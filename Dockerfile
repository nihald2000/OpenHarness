FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY src ./src
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
EXPOSE 4096
CMD ["node", "--loader", "./scripts/ts-loader.mjs", "packages/server/src/main.ts"]
