import { WebSocket } from 'ws'
import { ethers } from 'ethers'
import { z } from 'zod'
import { logger } from '../utils/logger'
import { env } from '../config/environment'

const P2P_WS = process.env.CLEARING_NODE_WS_URL || 'ws://localhost:7001'
const TOPIC_PREFIX = process.env.P2P_TOPIC_PREFIX || 'streamfi'
// Comma-separated topics to subscribe to (exact matches)
const SUB_TOPICS = (process.env.P2P_SUB_TOPICS || `${TOPIC_PREFIX}.sepolia.demo`).split(',').map(s => s.trim()).filter(Boolean)

// EIP-712 schema for TipState envelope
const TipStatePayload = z.object({
  type: z.literal('tip'),
  channelId: z.string(),
  streamId: z.string(),
  chainId: z.number(),
  spentWei: z.string(),
  nonce: z.string(),
  viewer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deadline: z.number().optional(),
})
const Envelope = z.object({
  payload: TipStatePayload,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  id: z.string().optional(),
  ts: z.number().optional(),
})
export type Envelope = z.infer<typeof Envelope>

function domainCandidates(chainId: number): string[] {
  // Allow any of our deployed contracts as verifyingContract
  return [env.nitrolite.adjudicator, env.nitrolite.custody, env.nitrolite.vault].map(a => a.toLowerCase())
}

const EIP712_TYPES = {
  TipState: [
    { name: 'channelId', type: 'string' },
    { name: 'streamId', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'spentWei', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'viewer', type: 'address' },
    { name: 'creator', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type TipState = z.infer<typeof TipStatePayload>

export class ClearingNodeService {
  private ws: WebSocket | null = null
  private connected = false
  private reconnectDelay = 500
  private lastConnectedAt: number | null = null
  private lastMessageAt: number | null = null
  private topics = new Set<string>()
  // in-memory latest state by channelId
  private latest = new Map<string, { env: Envelope, topic: string }>()

  start() {
    this.connect()
  }

  private connect() {
    const url = P2P_WS
    logger.info({ url }, 'P2P connect -> clearing-node WS gateway')
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.connected = true
      this.lastConnectedAt = Date.now()
      this.reconnectDelay = 500
      // subscribe to topics
      for (const t of SUB_TOPICS) {
        this.topics.add(t)
        ws.send(JSON.stringify({ type: 'subscribe', topic: t }))
      }
      logger.info({ topics: Array.from(this.topics) }, 'P2P subscribed')
    })

    ws.on('message', (buf: Buffer) => {
      this.lastMessageAt = Date.now()
      try {
        const msg = JSON.parse(buf.toString())
        const topic = String(msg?.topic || '')
        const data = msg?.data
        if (!topic || !topic.startsWith(TOPIC_PREFIX)) return
        const parsed = Envelope.safeParse(data)
        if (!parsed.success) return
        const env = parsed.data
        // verify signature against any allowed verifyingContract
        const t = env.payload
        const signOk = this.verifyEnvelope(env)
        if (!signOk) return
        // dedupe/order by nonce per channel
        const prev = this.latest.get(t.channelId)
        const prevNonce = prev ? BigInt(prev.env.payload.nonce) : -1n
        const curNonce = BigInt(t.nonce)
        if (curNonce > prevNonce) {
          this.latest.set(t.channelId, { env, topic })
          logger.info({ channelId: t.channelId, nonce: String(curNonce), topic }, 'P2P state updated')
        }
      } catch (e: any) {
        logger.warn({ err: e?.message }, 'P2P message parse failed')
      }
    })

    const cleanup = () => {
      this.connected = false
      this.ws = null
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000)
    }
    ws.on('close', cleanup)
    ws.on('error', (err) => { logger.warn({ err }, 'P2P socket error'); cleanup() })
  }

  private verifyEnvelope(env: Envelope): boolean {
    try {
      const p = env.payload
      for (const vc of domainCandidates(p.chainId)) {
        const domain = { name: 'StreamFi-P2P', version: '1', chainId: p.chainId, verifyingContract: vc }
        try {
          const recovered = ethers.verifyTypedData(domain as any, EIP712_TYPES as any, p as any, env.signature)
          if (recovered.toLowerCase() === env.signer.toLowerCase()) return true
        } catch { /* try next */ }
      }
      return false
    } catch { return false }
  }

  public getHealth() {
    return {
      url: P2P_WS,
      connected: this.connected,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      topics: Array.from(this.topics),
      size: this.latest.size,
    }
  }

  public getLatest(channelId: string) {
    return this.latest.get(channelId) || null
  }

  public async publish(topic: string, env: Envelope): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) throw new Error('p2p_not_connected')
    if (!topic.startsWith(TOPIC_PREFIX)) throw new Error('invalid_topic')
    if (!this.verifyEnvelope(env)) throw new Error('bad_signature')
    const msg = { type: 'publish', topic, data: env }
    this.ws.send(JSON.stringify(msg))
    return true
  }
}

export const clearingNodeService = new ClearingNodeService()
