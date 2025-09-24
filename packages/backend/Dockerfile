# ------------------------
# Stage 1: Build
# ------------------------
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

RUN apk add --no-cache openssl curl

ENV NPM_CONFIG_FETCH_RETRIES=6 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV NODE_OPTIONS=--dns-result-order=ipv4first

COPY package*.json ./
COPY package-lock.json ./
# Optionally reuse host node_modules to skip network install during builds
ARG USE_HOST_NODE_MODULES=false
COPY node_modules ./node_modules
# Deterministic installs; allow peer conflicts in CI
RUN if [ "$USE_HOST_NODE_MODULES" = "true" ]; then \
            echo "Using host node_modules"; \
        else \
            rm -rf node_modules && npm ci --legacy-peer-deps --registry="$NPM_CONFIG_REGISTRY"; \
        fi \
    && npm cache verify

COPY tsconfig.json ./
COPY src ./src

# Ensure TS is available (if not already in devDeps)
RUN npm install --include=dev typescript

RUN npx tsc -p tsconfig.json

# ------------------------
# Stage 2: Runtime
# ------------------------
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

RUN apk add --no-cache openssl curl

# Make npm more resilient in runtime stage too
ENV NPM_CONFIG_FETCH_RETRIES=6 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV NODE_OPTIONS=--dns-result-order=ipv4first

COPY package*.json ./
COPY package-lock.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
RUN npm prune --omit=dev \
    && npm cache clean --force

COPY --from=builder /usr/src/app/dist ./dist

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i 's/\r$//' ./docker-entrypoint.sh \
    && chmod +x ./docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
