FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
ARG USE_HOST_NODE_MODULES=true
ENV NPM_CONFIG_FETCH_RETRIES=6 \
	NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
	NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000 \
	NPM_CONFIG_FETCH_TIMEOUT=300000 \
	NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV NODE_OPTIONS=--dns-result-order=ipv4first
## Install all deps for build (including dev)
COPY node_modules ./node_modules
RUN if [ "$USE_HOST_NODE_MODULES" = "true" ]; then \
			echo "Using host node_modules"; \
		else \
			rm -rf node_modules && npm ci --legacy-peer-deps --registry="$NPM_CONFIG_REGISTRY" && npm cache verify; \
		fi
COPY tsconfig.json ./
COPY src ./src
## Ensure TypeScript available (in case not pinned)
RUN npm install --include=dev typescript
RUN npx tsc -p tsconfig.json

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_FETCH_RETRIES=6 \
	NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
	NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000 \
	NPM_CONFIG_FETCH_TIMEOUT=300000 \
	NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY --from=base /app/package*.json ./
COPY --from=base /app/node_modules ./node_modules
# Prune dev deps without hitting network
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=base /app/dist ./dist
# 7001: WS gateway (browser clients)
# 7002: HTTP health/metrics
# 7003: libp2p TCP
# 7004: libp2p WebSockets
EXPOSE 7001 7002 7003 7004
CMD ["node", "dist/index.js"]
