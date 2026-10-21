# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-debian
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/rag/package.json packages/rag/package.json
RUN bun install --frozen-lockfile --production

COPY apps/web ./apps/web
COPY packages/rag ./packages/rag

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RAG_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["bun", "run", "start"]
