# The app image: API, UI, MCP, job queue and scheduler in one Node process.
# The UI has no build step; the TypeScript is compiled in the build stage.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown path (flush telemetry, drain, close pools) actually runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY templates ./templates

# node:alpine ships an unprivileged `node` user. Nothing here needs root.
USER node

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=40s --retries=5 \
  CMD ["node", "dist/healthcheck.js", "/healthz"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
