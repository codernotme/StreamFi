<div align="center">

# StreamFi · Live Streaming × Web3 × Realtime

<img src="packages/frontend/public/globe.svg" height="64" alt="StreamFi" />

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000?logo=express)](https://expressjs.com/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?logo=socketdotio)](https://socket.io/)
[![Stripe](https://img.shields.io/badge/Stripe-ready-626CD9?logo=stripe&logoColor=white)](https://stripe.com/)

</div>

## Why StreamFi (USP)

- One cohesive stack blending live streaming, realtime chat, and on-chain monetization (NFTs, tips) out of the box.
- Batteries-included DX: authentication, roles, admin/mod tools, metrics, logging, CSRF, CORS/Helmet.
- Modular by design: swap RTMP/HLS backends, change chains/providers, or extend features without rewiring everything.

## How it works

1) Ingest + HLS
- OBS pushes RTMP to your origin (Node Media Server or cloud). The backend builds HLS URLs or proxies via `/api/stream/:id/hls`.
2) Realtime
- Viewers join a stream room over Socket.IO; per-event rate limits and moderation namespace are enforced.
3) Monetization
- Donations via Stripe/UPI/PayPal stubs and NFT mint/indexer hooks. Payout requests flow is included.
4) Web3
- Ethers v6 + indexer to sync NFT ownership and metadata (IPFS gateway + optional Pinata pinning).

## Tech stack

- Frontend: Next.js 15 (App Router), React 19, Tailwind/shadcn, RainbowKit/wagmi, hls.js, socket.io-client.
- Backend: Node/Express, TypeScript, MongoDB (Mongoose), Socket.IO, ethers v6.
- Security/ops: Helmet, strict CORS, CSRF, API/socket rate limits, structured logs (Pino + correlation IDs), Prometheus metrics `/metrics`.

## Monorepo layout

```
packages/
	backend/      # Express + MongoDB (Mongoose) + Socket.IO API
	frontend/     # Next.js app
	foundry-contracts/  # Solidity + Foundry (demo contracts)
docs/           # Architecture notes
docker-compose.yml
```

## Environment

- Backend: copy `packages/backend/.env.example` → `packages/backend/.env` and fill required values (DATABASE_URL, JWT_SECRET, JSON_RPC_PROVIDER). For on-chain channels on Sepolia also set:
	- `CREATOR_VAULT_ADDRESS` (Nitrolite)
	- `YELLOW_CHANNEL_CONTRACT` (ChannelManager)
	- `CHANNEL_CHAIN_ID=11155111`
	- Optional minimums: `MIN_CHANNEL_DEPOSIT_WEI`, `MIN_TIP_WEI`
- Frontend: copy `packages/frontend/.env.example` → `packages/frontend/.env.local` (or `.env`) and set `NEXT_PUBLIC_API_BASE` to `http://localhost:8000/api`.

## Run (Docker Compose)

```powershell
docker compose up --build
```

Services
- Backend: http://localhost:8000
- Frontend: http://localhost:3000
- MongoDB: mongodb://user:password@localhost:27017/streamfi?authSource=admin
- Media Server (RTMP/HLS origin): exposed on 1935 (RTMP) and 8081 (HLS)

### Media Server build context note
The compose file now hardcodes the media server build context to `./packages/media-server` (previously it used an env var fallback `${MEDIA_SERVER_CONTEXT:-./media-server}` which caused build failures for fresh clones). If you need to point at a different implementation, create a `docker-compose.override.yml` with:

```yaml
services:
	nms:
		build:
			context: ./path-to-your-alt-media-server
```

This keeps the default path stable for all contributors.

## Run (local dev)

```powershell
# backend
cd packages/backend
npm install
npm run dev

# frontend (new terminal)
cd packages/frontend
npm install
npm run dev
```

## Key features


### Resilience / Hardening

The backend includes defensive measures to avoid crashes on transient RPC issues:
- Contract bytecode fetch in Nitrolite (channel) service uses retry with backoff (handles ECONNRESET / timeouts).
- Global `unhandledRejection` and `uncaughtException` handlers log and keep the process alive.
- `/health` and `/api/health` now expose Nitrolite readiness + admin signer balance so scripts can wait before starting flows.
- On-chain operations call an internal `ensureReady()` that lazily re-attempts initialization if prior startup failed.

Automation tip: wait for `/api/health` to report `nitrolite.ready: true` before running channel E2E scripts.

### Off-Chain Microtransaction Channels (Yellow Prototype)

MVP added for low-gas tipping via signed off-chain state updates:

Endpoints
```
GET    /api/channels/stream/:streamId/init           # Fetch vault + limits
POST   /api/channels/open                            # Open per-viewer channel
POST   /api/channels/:channelId/tip                  # EIP-712 signed tip update
POST   /api/channels/:channelId/close                # Cooperative close & vault deposit
GET    /api/channels/stream/:streamId/summary        # Aggregate revenue
```

Environment (backend)
```
YELLOW_CHANNEL_CONTRACT=0xYourChannelContract
CHANNEL_CHAIN_ID=11155111
MIN_CHANNEL_DEPOSIT_WEI=100000000000000        # 0.0001 ETH
MIN_TIP_WEI=100000000000                       # 0.0000001 ETH
```

Flow
1. Viewer connects wallet on watch page.
2. Init fetch provides vaultId + limits.
3. Viewer opens channel (sets deposit offline placeholder).
4. Each tip: viewer signs ChannelState (channelId, vaultId, deposit, spent, nonce).
5. Backend verifies signature, updates spent, broadcasts `superchat`.
6. Close: backend deposits cumulative spent into Nitrolite vault.

Rate limiting: basic in-memory limiter (15 tips / 5s per viewer/channel) — replace with Redis for production.

## Payments (Stripe)

- Backend: `POST /api/payments/stripe/create-payment-intent` → `clientSecret` (requires STRIPE_SECRET_KEY).
- Webhook: set STRIPE_WEBHOOK_SECRET and send events to `POST /api/payments/stripe/webhook`.
- Frontend: `/donate` uses Stripe Elements; set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- Optional local webhook via Stripe CLI:

```powershell
stripe listen --forward-to http://localhost:8000/api/payments/stripe/webhook
```

## Screenshots

> Add your screenshots or short clips here (player, dashboard, donations).

## Roadmap

- CI pipeline (install, lint/typecheck, build, backend tests)
- OpenTelemetry tracing + pino/otel binding; configurable sampling
- Redis-based rate limiting for sockets
- More tests and OpenAPI docs

---

MIT © StreamFi contributors

## OBS Quick Start

Configure OBS to stream to the local Node Media Server:

- Service: Custom
- Server: rtmp://localhost:1935/live
- Stream Key: use the key from POST /api/stream/ingest (copy `streamKey`)

Steps:
1. Sign in on the app, then call POST http://localhost:8000/api/stream/ingest with your auth cookie/token to get `{ ingestUrl, streamKey }`.
2. In OBS, set Server to the `ingestUrl` or rtmp://localhost:1935/live and Stream Key to that `streamKey`.
3. Start streaming. The HLS URL for players is returned by GET http://localhost:8000/api/stream/{id-or-key}/hls.