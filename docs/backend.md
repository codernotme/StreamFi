# StreamFi Backend

A modern, modular Node.js backend for the **StreamFi** platform, built with **TypeScript**, **Express**, **Mongoose (MongoDB)**, and **Socket.IO**. It provides a robust API for authentication, stream management, monetization, and real-time events for an interactive streaming experience.

---

## Overview

* **Runtime:** Node.js (v20)
* **Language:** TypeScript
* **Framework:** Express.js
* **Database ORM:** Mongoose
* **Real-time:** Socket.IO
* **Database:** MongoDB
* **Containerization:** Docker & Docker Compose
* **Architecture:** Feature-based modules under `src/modules/*`

---

## Key Features

* Modular architecture (Auth, Streams, Monetization, Notifications, Users)
* RESTful JSON API for frontend integration
* Real-time events (reactions) with Socket.IO, room-based by `streamId`
* MongoDB with Mongoose models (no Prisma)
* Type-safe codebase with explicit DTOs and types
* Dockerfile + docker-compose for local dev and production parity
* Centralized logging and global error handling

---

## Folder Structure

```
streamfi-backend/
├── prisma/ (deprecated)
│   └── README.md           # Prisma removed; using MongoDB via Mongoose
├── src/
│   ├── app.ts              # Express app setup (middleware + error handler)
│   ├── server.ts           # Entry point (HTTP server + Socket.IO)
│   ├── config/
│   │   └── environment.ts  # Env parsing & validation (Zod recommended)
│   ├── lib/
│   │   └── mongo.ts        # Mongoose connection and models
│   ├── modules/            # Feature modules (auth, stream, monetization, ...)
│   ├── routes/             # Central router mounting module routers
│   ├── services/           # Shared services (overlay, blockchain)
│   ├── utils/              # Logger and helpers
│   └── types/              # App-specific TypeScript types
├── .env.example
├── .env                    # Local env (git-ignored)
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## Configuration

Create a `.env` in the `streamfi-backend/` root (copy from `.env.example`):

```env
PORT=8000
DATABASE_URL="mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/streamfi?retryWrites=true&w=majority"
JWT_SECRET="your-secret"
JWT_EXPIRES_IN="1d"
# other keys: STRIPE_SECRET_KEY, JSON_RPC_PROVIDER, STREAMFI_CONTRACT_ADDRESS, ADMIN_PRIVATE_KEY, etc.
```

> Docker Compose uses the same Atlas `DATABASE_URL`; no local Mongo container is used.

`src/config/environment.ts` should parse and validate env vars (Zod recommended) and export a typed `env` object.

---

## Running Locally (Docker)

From the project root (where the main `docker-compose.yml` lives):

```bash
docker compose up --build
```

* Backend will be available on `http://localhost:<PORT>` (default 8000).
* Logs will stream into your terminal.

### Database (Atlas-only)

No migration step is required. The app connects to MongoDB Atlas via `DATABASE_URL`. Mongoose models are defined in `src/lib/mongo.ts`.

---

## API Contracts

### Auth — `/api/auth`

* `POST /login`
  Request: `{ email, password }`
  Response: `{ token, user: { id, name, email, role } }`

* `POST /signup`
  Request: `{ name, email, password }`
  Response: `{ token, user }`

* `GET /me` (Bearer token)
  Response: `{ user }`

### Streaming — `/api/stream`

* `POST /ingest` (auth) → `{ ingestUrl, streamKey, status }`
* `GET /:id/status` → `{ id, status, viewers, startedAt? }`
* `GET /:id/hls` → `{ hlsUrl }`

### Monetization — `/api/monetization`

* `GET /summary?range=today|7d|30d` → `{ totalDonations, totalNftSales, totalPayouts }`
* `GET /donations` → `Donation[]` (paginated)
* `GET /nfts` → `NFTSale[]` (paginated)
* `GET /payouts` → `Payout[]` (paginated)

### Notifications — `/api/notifications`

* `GET /` → `{ items: Notification[] }`
* `POST /read` `{ ids: string[] }` → `{ ok: true }`

### Settings — `/api/settings`

* `GET /` → user settings
* `POST /` → update settings

---

## Real-time (Socket.IO)

**Global namespace (`/`)** — On connect, clients supply `streamId` in handshake query.

* Client sends: `reaction` — payload: `{ streamId: string, type: string }`
* Server broadcasts to room: `new_reaction` — payload: `{ type: string }`

Server-side logic is handled in `src/services/overlay.service.ts` (join room on connect, validate payloads, emit broadcasts).

---

## Data Models (high level)

`src/lib/mongo.ts` defines models such as:

* `User` — credentials, profile, role, walletAddress, relations
* `Stream` — title, streamKey, ingestUrl, status, streamer relation
* `Transaction` / `Donation` / `NFTSale` / `Payout` — monetization records
* `Notification` — user notifications

Manage schema changes by updating the Mongoose schemas.

---

## Code Conventions & Architecture

* **Modularity:** Each feature in `src/modules/*` holds its routes, controllers and service logic.
* **Thin Controllers:** Controllers receive requests and delegate complex logic to services.
* **Central Router:** `src/routes/index.ts` mounts all module routers.
* **Type Safety:** Use interfaces and DTOs for request/response contracts.
* **Error Handling:** Global error handler formats and logs errors in `app.ts`.
* **Mongo Connection:** Reuse the shared Mongoose connection and models from `src/lib/mongo.ts`.
* **Socket.IO:** Initialize in `server.ts` with `http.createServer(app)` and attach Socket.IO instance; pass the instance to overlay service.

---

## Development Tips

* Use `ts-node-dev` + `tsconfig-paths/register` for local dev to support TypeScript path aliases. Example `package.json` scripts:

```json
"scripts": {
  "dev": "ts-node-dev --respawn --transpile-only -r tsconfig-paths/register src/server.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node -r tsconfig-paths/register dist/server.js",
  // Prisma scripts removed
}
```

* Keep `.env` in root of backend; do not commit secrets.

---

## Known Limitations & Next Steps

* Implement full Web3 / blockchain flows in `blockchain.service.ts`.
* Add request-body validation (Zod/Joi) for all endpoints.
* Strengthen security: stricter CORS, helmet, rate limiting, input sanitization.
* Expand unit & integration tests; add CI pipeline.
* Replace demo data with real monetization flows (Stripe, NFT marketplace integrations).

---

## Suggested API Types (frontend contract)

* **Donation**

  ```ts
  { id: string, amount: number, currency: string, donor: string, message?: string, createdAt: string }
  ```
* **NFTSale**

  ```ts
  { id: string, tokenId: string|number, price: number, currency: string, buyer: string, createdAt: string }
  ```
* **Payout**

  ```ts
  { id: string, amount: number, currency: string, provider: string, status: 'PENDING'|'COMPLETED'|'FAILED', createdAt: string }
  ```

---

## Contributing

* Follow code style: ESLint + Prettier
* Add tests for all newly added endpoints / services
* Document new routes and events in this README

---

## License

MIT

---