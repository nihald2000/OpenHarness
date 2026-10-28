FROM oven/bun:1.3.3 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/server/package.json packages/server/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN mkdir -p /out && bun build --compile packages/server/src/main.ts --outfile /out/openharness && bun run --cwd apps/web build

FROM node:24-bookworm-slim AS server
ENV NODE_ENV=production \
    OPENHARNESS_HOST=0.0.0.0 \
    OPENHARNESS_PORT=4096 \
    OPENHARNESS_DATA_DIR=/data \
    OPENHARNESS_WORKSPACE=/workspace
WORKDIR /app
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
COPY --from=build --chown=node:node /out/openharness /usr/local/bin/openharness
USER node
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4096/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/openharness"]

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN chown node:node /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
