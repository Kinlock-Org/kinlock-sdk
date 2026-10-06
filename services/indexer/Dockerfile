# Kinlock indexer: one container (ARCHITECTURE.md §2). Build from the repo root:
#   docker build -f services/indexer/Dockerfile .
# Testnet only until mainnet is approved. Configuration comes from the environment (.env.example);
# no secrets are baked into the image.

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY services/indexer/package.json services/indexer/
RUN pnpm install --frozen-lockfile
COPY services/indexer services/indexer
RUN pnpm --filter @kinlock/indexer build \
 && pnpm --filter @kinlock/indexer deploy --legacy --prod /out \
 && rm -rf /out/dist /out/src /out/test \
 && cp -r services/indexer/dist /out/dist \
 && mkdir -p /out/src/db && cp -r services/indexer/src/db/migrations /out/src/db/migrations

FROM node:20-alpine
# git: clones the public registry for the payee display join (REGISTRY_GIT_URL).
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /out ./
COPY services/indexer/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
ENV NODE_ENV=production
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
