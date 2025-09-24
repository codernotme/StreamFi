import { WebSocket } from 'ws'
import { ethers } from 'ethers'

const GATEWAY = process.env.GATEWAY || 'ws://localhost:7001'
const TOPIC = process.env.TOPIC || 'streamfi.demo'
const VERIFYING_CONTRACT = (process.env.VERIFYING_CONTRACT || '0xb79C129317ec545d1268a2AAedf26146f353a6d5').toLowerCase()
const CHAIN_ID = Number(process.env.CHAIN_ID || 11155111)

function delay(ms: number) { return new Promise(res => setTimeout(res, ms)) }

async function main() {
  const sub = new WebSocket(GATEWAY)
  const pub = new WebSocket(GATEWAY)

  const pk = process.env.PRIVATE_KEY
  const wallet = pk ? new ethers.Wallet(pk) : ethers.Wallet.createRandom()
  const viewer = wallet.address
  const creator = '0x1111111111111111111111111111111111111111'

  const payload = {
    type: 'tip',
    channelId: 'channel-1',
    streamId: 'stream-1',
    chainId: CHAIN_ID,
    spentWei: '1000',
    nonce: '1',
    viewer,
    creator,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  }

  const domain = {
    name: 'StreamFi-P2P',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  }
  const types = {
    TipState: [
      { name: 'channelId', type: 'string' },
      { name: 'streamId', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'spentWei', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'viewer', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ]
  } as const

  const signature = await wallet.signTypedData(domain as any, types as any, payload as any)
  const env = { payload, signature, signer: viewer, ts: Date.now() }

  let received = false
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for message')), 5000)
    sub.on('open', () => {
      sub.send(JSON.stringify({ type: 'subscribe', topic: TOPIC }))
    })
    sub.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString())
        if (msg?.topic === TOPIC) {
          received = true
          clearTimeout(to)
          resolve()
        }
      } catch {}
    })
    sub.on('error', reject)
    pub.on('open', async () => {
      // small delay to ensure subscribe is processed
      await delay(200)
      pub.send(JSON.stringify({ type: 'publish', topic: TOPIC, data: env }))
    })
    pub.on('error', reject)
  })

  console.log(JSON.stringify({ ok: received }, null, 2))
  process.exit(received ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
