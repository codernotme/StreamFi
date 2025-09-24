import { z } from 'zod'

export const TipStatePayload = z.object({
  type: z.literal('tip'),
  channelId: z.string(),
  streamId: z.string(),
  chainId: z.number(),
  spentWei: z.string(), // bigint as string
  nonce: z.string(), // bigint as string
  viewer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deadline: z.number().optional(),
})

export type TipStatePayload = z.infer<typeof TipStatePayload>

export const Envelope = z.object({
  payload: TipStatePayload,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  id: z.string().optional(),
  ts: z.number().optional(),
})

export type Envelope = z.infer<typeof Envelope>

export const EIP712_DOMAIN = (chainId: number, verifyingContract: string) => ({
  name: 'StreamFi-P2P',
  version: '1',
  chainId,
  verifyingContract,
})

export const EIP712_TYPES = {
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
