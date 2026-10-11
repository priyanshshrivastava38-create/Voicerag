# VIH VoiceRAG application image (web + voice WebSocket + in-process ingestion worker).
# Model sidecars (whisper.cpp, Ollama, Piper) and Postgres + pgvector run separately.
# For a full single-VM deployment (sidecars, Postgres, Caddy/HTTPS) see deploy/ and docs/DEPLOY.md.
#
#   docker build -t vih-voicerag .
#   docker run --rm --env-file .env vih-voicerag npx prisma migrate deploy   # once per release
#   docker run -d --env-file .env -p 3100:3100 -v voicerag-storage:/app/storage vih-voicerag
#   docker run -d --env-file .env vih-voicerag ./node_modules/.bin/tsx scripts/worker.ts  # optional standalone
#                                  ingestion worker (then set VOICERAG_INPROCESS_WORKER=false on web nodes)

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3100 \
    VOICERAG_STORAGE_DIR=/app/storage \
    NEXT_TELEMETRY_DISABLED=1
# The custom server runs TypeScript through tsx and the Prisma CLI is needed for `migrate deploy`,
# so the full dependency tree is kept.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3100
# No VOLUME instruction (some hosts, e.g. Railway, reject it): mount /app/storage at run time
# (-v above, compose `app-storage`), or set VOICERAG_STORAGE_BACKEND=db.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The server handles SIGTERM (readiness off, voice sessions closed, in-flight ingestion finished, 10 s
# hard deadline). tsx is started directly (not via npx) so the signal reaches it without an npm layer;
# run with an init process (`docker run --init`, compose `init: true`) so PID 1 reaps children.
STOPSIGNAL SIGTERM
CMD ["./node_modules/.bin/tsx", "server.ts"]
