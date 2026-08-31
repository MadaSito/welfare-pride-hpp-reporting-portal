FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && useradd --system --uid 10001 --create-home appuser && mkdir -p /app/data && chown -R appuser:appuser /app
ENV NODE_ENV=production
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
