FROM node:22-alpine AS build

WORKDIR /app/redline3d
RUN apk add --no-cache python3 make g++
COPY redline3d/package.json redline3d/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY redline3d/ .
COPY packages/engine/ /app/packages/engine/
ARG VITE_PRIVY_APP_ID
ARG VITE_WALLET
ARG VITE_SOLANA_CLUSTER
# Robinhood Chain rail. An unpassed --build-arg becomes an EMPTY env var, and process.env WINS
# over .env.production in vite's loadEnv — so leaving these unset does NOT fall back to the file.
# It is safe only because empty resolves to exactly the production defaults (rail evm, chain
# mainnet, no USDC address). Pass VITE_EVM_USDC_ADDRESS at deploy or the image ships no token.
ARG VITE_CHAIN_RAIL
ARG VITE_EVM_CHAIN
ARG VITE_EVM_USDC_ADDRESS
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID \
    VITE_WALLET=$VITE_WALLET \
    VITE_SOLANA_CLUSTER=$VITE_SOLANA_CLUSTER \
    VITE_CHAIN_RAIL=$VITE_CHAIN_RAIL \
    VITE_EVM_CHAIN=$VITE_EVM_CHAIN \
    VITE_EVM_USDC_ADDRESS=$VITE_EVM_USDC_ADDRESS
RUN npm run build

FROM caddy:2-alpine
COPY redline3d/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/redline3d/dist /usr/share/caddy
