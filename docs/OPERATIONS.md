# Operations

## Local setup in detail (macOS / Apple silicon)

1. **Postgres 16 with pgvector ≥ 0.8.** If Homebrew's pgvector targets a different Postgres major version, build it from source:
   `git clone --branch v0.8.1 https://github.com/pgvector/pgvector && cd pgvector && make PG_CONFIG=$(brew --prefix postgresql@16)/bin/pg_config && make install PG_CONFIG=…`.
   Then create both databases and run `npm run db:deploy` against each.
2. **whisper.cpp server.** A pip-installed `cmake` is enough:
   `git clone --branch v1.8.2 https://github.com/ggml-org/whisper.cpp && cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON && cmake --build build -j --target whisper-server`.
   Copy `build/bin/whisper-server` to `.vendor/bin/`, or set `WHISPER_SERVER_BIN`.
   Download the model: `curl -L -o ~/.cache/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`.
   `small.en` is more accurate and slower.
3. **Piper.** `python3 -m venv .venv-tts && .venv-tts/bin/pip install piper-tts`. Download
   `en_US-lessac-medium.onnx` and its `.onnx.json` from `huggingface.co/rhasspy/piper-voices` into `~/.cache/piper/`.
4. **Ollama.** `ollama pull llama3.2:1b && ollama pull nomic-embed-text`.
5. Run `npm run sidecars`, `npm run seed:docs && npm run db:seed`, then `npm run build && npm start`.
   **Restart the server after every `npm run build`.** A running process serving a rebuilt `.next` directory produces a client-side exception.

## Production deployment (simple first)

```
            HTTPS/WSS
browser ───────────────▶ reverse proxy (TLS, HSTS, WebSocket upgrade, sticky sessions if >1 node)
                              │
                              ▼
                    app node: `npm start` (Next.js + /ws/voice, in-process worker)
                              │            │                     │
                         Postgres 16    model host(s): whisper.cpp / vLLM-Ollama / Piper
                         + pgvector     (GPU), or approved hosted APIs
```

- Build: `npm ci && npx prisma migrate deploy && npm run build`. Run `npm start` under a supervisor (systemd or a container) with `NODE_ENV=production`.
  Mock providers are refused in production. The server refuses to start, with a message naming the problem, when `DATABASE_URL` is missing or unreachable or a provider name is unknown.
- Container deployment: for a complete single-VM stack (Postgres, Ollama, whisper.cpp, Piper, the app and Caddy for HTTPS, all in Docker Compose), follow [DEPLOY.md](DEPLOY.md) and use the files in `deploy/`.
- Container: `docker build -t vih-voicerag .`, then `docker run --rm --env-file .env vih-voicerag npx prisma migrate deploy` once per release, and
  `docker run -d --env-file .env -p 3100:3100 -v voicerag-storage:/app/storage vih-voicerag`. The image runs as a non-root user and has a `HEALTHCHECK` on `/api/health`.
  Point `DATABASE_URL`, `OLLAMA_URL`, `WHISPERCPP_URL` and `PIPER_URL` at hosts reachable from the container (not `127.0.0.1`).
- Proxy: forward `Upgrade`/`Connection` headers for `/ws/voice`; set idle timeouts above 120 s; the app must see the original `Host` and `Origin`.
  Set `TRUST_PROXY=true` so login rate limiting keys on the real client IP (the proxy must append to `X-Forwarded-For`). The app's HTTP keep-alive (65 s) outlasts typical proxy idle timeouts.
- Shutdown: on SIGTERM the server flips readiness to false, closes voice sessions (code 1001), lets the in-flight ingestion job finish, closes HTTP and the database pool, and exits (hard deadline 10 s; the standalone worker allows 60 s). Dead WebSocket peers are detected by a 30 s ping and released.
- Health: `GET /api/health` (liveness), `GET /api/ready` (DB, providers and warm-up; detailed output for admins only). Gate traffic on readiness.
- Scale ingestion separately with `VOICERAG_INPROCESS_WORKER=false` on web nodes and `npm run worker` elsewhere.
- Schedule `npm run retention:purge` daily.
- Logging: stdout, with secrets redacted. Per-turn metrics go to `TurnMetric`, viewable at `/admin/metrics`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `/api/ready` 503 | The `providers` block names the failing stage. Start the sidecars and pull the models. |
| "I didn't catch that" often | Mic level meter; VAD thresholds (`DEFAULT_VAD` in `src/shared/vad.ts`); background noise. A neural VAD is the upgrade path. |
| Assistant interrupts itself | Echo from speakers. Use headphones, or raise `BARGE_IN_SENSITIVITY` in `voice-client.ts`. Echo cancellation must be supported by the browser. |
| Slow first answer after idle | Ollama `keep_alive`, OS swapping (`sysctl vm.swapusage`); compare `coldStart` rows on the dashboard. |
| Wrong words in transcripts | Add domain terms to `STT_VOCABULARY`; use `small.en` or a hosted STT. |
| Too many "not in the knowledge base" answers | Run `npm run eval:rag`. Check the false-abstention list and tune `RAG_MIN_VECTOR_SIM*` using the held-out split. |
| Document stuck in QUEUED | Is the worker running? Stale locks are reclaimed after 10 min. Check the `error` column. |
| Client-side exception after deploy | The server was not restarted after the build. |

## Cost model

Cost per turn = STT seconds × STT price + (input tokens × input price + output tokens × output price) + TTS characters × TTS price + infrastructure share.

- Input tokens ≈ system prompt (~230) + history (≤ 4 short messages) + k × chunk (~3 × 100 words). This is about 600–900 tokens.
- Output tokens are capped by `LLM_MAX_TOKENS` (160); typical answers are 30–60.
- Abstentions cost no LLM tokens.
- Typical STT input is 2–5 s of audio. TTS input is about 150–300 characters.
- Speculation can waste one LLM prefix when the user resumes speaking. On the benchmarks, 4–8% of turns did.

With LLM prices set in `.env`, the dashboard reports measured cost per turn from real token usage. Local
providers have no per-call cost; size the GPU host by measured turns per second (see the load test).

## Backup and recovery

- Postgres holds everything except document bytes. Take nightly `pg_dump` plus WAL archiving or managed PITR, and test restores monthly.
- `VOICERAG_STORAGE_DIR` holds the documents. Use encrypted, versioned object storage or a snapshot schedule aligned with the database backup.
- Embeddings can be rebuilt from documents (`npx tsx scripts/reindex-all.ts`); the embedding cache makes rebuilds cheap.

## Production readiness checklist

- [ ] Providers approved (data handling, residency) and verified with `test:providers`
- [ ] SSO/MFA; groups synced from the identity provider
- [ ] TLS/WSS, HSTS, CSP; secrets in a manager; encryption at rest
- [ ] Real documents approved; owners assigned; injection review process
- [ ] `eval:rag` on a labelled set from **real** questions; thresholds re-tuned with a held-out split
- [ ] `bench:voice` from the production region meets agreed SLOs; dashboard alerts on p95 and error rate
- [ ] Load test with real providers at expected peak concurrency
- [ ] Backups and restore drill; retention job scheduled
- [ ] DPIA and user notice for voice processing; accessibility review of the UI
