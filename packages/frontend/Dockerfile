# frontend/Dockerfile

# 1. Base Image (pin to stable LTS for reliability)
FROM node:20-alpine AS base
# Add glibc compatibility for Next.js binaries on Alpine
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# 2. Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --legacy-peer-deps

# 3. Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The NEXT_PUBLIC_* envs need to be available at build time for client code
ARG NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_HLS_BASE
ARG NEXT_PUBLIC_CHAT_WS_BASE
ARG NEXT_PUBLIC_CLEARNODE_WS_URL
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
ENV NEXT_PUBLIC_HLS_BASE=${NEXT_PUBLIC_HLS_BASE}
ENV NEXT_PUBLIC_CHAT_WS_BASE=${NEXT_PUBLIC_CHAT_WS_BASE}
ENV NEXT_PUBLIC_CLEARNODE_WS_URL=${NEXT_PUBLIC_CLEARNODE_WS_URL}
RUN npm run build

# 4. Runner
FROM base AS runner
WORKDIR /app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]