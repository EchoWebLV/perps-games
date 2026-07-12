FROM node:22-alpine AS build

WORKDIR /app/redline3d
RUN apk add --no-cache python3 make g++
COPY redline3d/package.json redline3d/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY redline3d/ .
COPY packages/engine/ /app/packages/engine/
RUN npm run build

FROM caddy:2-alpine
COPY redline3d/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/redline3d/dist /usr/share/caddy
