FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm --config.onlyBuiltDependencies[]=better-sqlite3 rebuild better-sqlite3
COPY . .
RUN pnpm run build \
    && chmod -R a+rX /app \
    && useradd --system --uid 10001 --create-home appuser \
    && mkdir -p /app/data \
    && chown appuser:appuser /app/data
ENV NODE_ENV=production
ENV BIND_ADDRESS=0.0.0.0
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
