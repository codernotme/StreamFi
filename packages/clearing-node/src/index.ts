import pino from 'pino'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { Envelope } from './schema.js'
import { ethers } from 'ethers'
import { createLibp2p, Libp2p } from 'libp2p'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// Polyfill for Node < 22 to support libraries expecting Promise.withResolvers
if (!(Promise as any).withResolvers) {
  ;(Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: any) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}
const PORT_WS_GATEWAY = Number(process.env.P2P_GATEWAY_WS_PORT || process.env.P2P_WS_PORT || 7001)
const PORT_HTTP = Number(process.env.PORT || 7002)
const TOPIC_PREFIX = process.env.P2P_TOPIC_PREFIX || 'streamfi'
const P2P_LISTEN_TCP = process.env.P2P_LISTEN_TCP || '/ip4/0.0.0.0/tcp/7003'
const P2P_LISTEN_WS = process.env.P2P_LISTEN_WS // e.g., '/ip4/0.0.0.0/tcp/7004/ws'
const P2P_BOOTSTRAP = (process.env.P2P_BOOTSTRAP || '').split(',').map(s => s.trim()).filter(Boolean)
const VERIFY_CONTRACTS = (process.env.P2P_EIP712_VERIFY_CONTRACTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

type Client = { id: string, ws: WebSocket, topics: Set<string> }
const clients = new Map<string, Client>()
let node: Libp2p | null = null

function okTopic(topic?: string) {
  return !!topic && topic.startsWith(TOPIC_PREFIX)
}

function verifyTipEnvelope(env: Envelope): boolean {
  try {
    const parsed = Envelope.parse(env)
    const p = parsed.payload
    // Reconstruct EIP-712 hash and recover signer
    const candidates = VERIFY_CONTRACTS.length > 0 ? VERIFY_CONTRACTS : ['0x0000000000000000000000000000000000000000']
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
    }
    for (const vc of candidates) {
      const domain = {
        name: 'StreamFi-P2P',
        version: '1',
        chainId: p.chainId,
        verifyingContract: vc
      }
      try {
        const recovered = ethers.verifyTypedData(domain, types, p as any, parsed.signature)
        if (recovered.toLowerCase() === parsed.signer.toLowerCase()) return true
      } catch (e) {
        // try next candidate
      }
    }
    return false
  } catch (e:any) {
    logger.warn({ err: e.message }, 'verify failed')
    return false
  }
}

function broadcast(topic: string, data: any, exceptId?: string) {
  const msg = JSON.stringify({ topic, data })
  for (const c of clients.values()) {
    if (!c.topics.has(topic)) continue
    if (c.id === exceptId) continue
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg)
    }
  }
}

async function startP2P() {
  const listen: string[] = []
  if (P2P_LISTEN_TCP) listen.push(P2P_LISTEN_TCP)
  if (P2P_LISTEN_WS) listen.push(P2P_LISTEN_WS)

  node = await createLibp2p({
    addresses: { listen },
    transports: [tcp(), ...(P2P_LISTEN_WS ? [webSockets()] : [])],
    streamMuxers: [mplex()],
    connectionEncrypters: [noise() as any],
    services: {
      identify: identify() as any,
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }) as any
    },
    peerDiscovery: P2P_BOOTSTRAP.length ? [bootstrap({ list: P2P_BOOTSTRAP })] : [],
  })

  node.addEventListener('peer:connect', (evt: any) => {
    logger.info({ peer: evt.detail.toString() }, 'peer connected')
  })
  node.addEventListener('peer:disconnect', (evt: any) => {
    logger.info({ peer: evt.detail.toString() }, 'peer disconnected')
  })

  // Fan-in from libp2p to WS gateway for any subscribed topics
  const psOn: any = (node as any).services?.pubsub
  psOn?.addEventListener?.('message', (evt: any) => {
    try {
      const topic = evt.detail.topic
      const data = JSON.parse(Buffer.from(evt.detail.data).toString())
      if (!okTopic(topic)) return
      if (!verifyTipEnvelope(data)) return
      broadcast(topic, data)
    } catch (e: any) {
      logger.warn({ err: e.message }, 'failed to handle p2p message')
    }
  })

  await node.start()
  logger.info({ id: node.peerId.toString(), addrs: node.getMultiaddrs().map((a: any) => a.toString()) }, 'libp2p started')
}

function startWsGateway() {
  const wss = new WebSocketServer({ port: PORT_WS_GATEWAY })
  wss.on('connection', (ws: WebSocket) => {
    const id = nanoid()
    const client: Client = { id, ws, topics: new Set() }
    clients.set(id, client)
    logger.info({ id }, 'ws connected')

    ws.on('message', async (buf: Buffer) => {
      if (buf.length > 64 * 1024) return
      let msg: any
      try { msg = JSON.parse(buf.toString()) } catch { return }
      const { type, topic, data } = msg || {}
      if (!okTopic(topic)) return

      if (type === 'subscribe') {
        client.topics.add(topic)
        if (node) {
          try {
            const ps: any = (node as any).services?.pubsub
            if (ps && typeof ps.subscribe === 'function') {
              await ps.subscribe(topic)
            }
          } catch {}
        }
        return
      }
      if (type === 'publish') {
        // only allow valid envelopes
        if (!verifyTipEnvelope(data)) return
        // bridge to p2p
        if (node) {
          try {
            const ps: any = (node as any).services?.pubsub
            if (ps && typeof ps.publish === 'function') {
              await ps.publish(topic, Buffer.from(JSON.stringify(data)))
            }
          } catch (e: any) {
            logger.warn({ err: e.message }, 'failed to publish to p2p')
          }
        }
        // also echo to local subscribers
        broadcast(topic, data, id)
        return
      }
    })

    ws.on('close', () => {
      clients.delete(id)
      logger.info({ id }, 'ws disconnected')
    })
  })
  logger.info({ port: PORT_WS_GATEWAY }, 'ws gateway listening')
}

function startHttp() {
  const app = express()
  app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({
      status: 'UP',
      wsClients: clients.size,
      topics: Array.from(new Set(Array.from(clients.values()).flatMap(c => Array.from(c.topics)))),
      p2p: node ? {
        id: node.peerId.toString(),
        addrs: node.getMultiaddrs().map((a: any) => a.toString()),
        peers: node.getConnections().length,
      } : { started: false }
    })
  })
  app.listen(PORT_HTTP, () => logger.info({ port: PORT_HTTP }, 'http metrics listening'))
}

startP2P().then(() => startWsGateway()).catch(err => logger.error({ err }, 'failed to start p2p'))
startHttp()
