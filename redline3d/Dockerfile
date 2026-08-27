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
    ARG VITE_PYTH_API_KEY
    ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID \
        VITE_WALLET=$VITE_WALLET \
        VITE_SOLANA_CLUSTER=$VITE_SOLANA_CLUSTER \
        VITE_PYTH_API_KEY=$VITE_PYTH_API_KEY
    RUN npm run build

FROM caddy:2-alpine
COPY redline3d/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/redline3d/dist /usr/share/caddy
