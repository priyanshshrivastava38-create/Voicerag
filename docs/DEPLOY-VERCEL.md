# Deploying on Vercel + Railway (split hosting)

Vercel cannot run the voice WebSocket or the speech-to-text model: its functions are short-lived and
it ignores the custom server (`server.ts`). This setup puts each part where it can run:

```
 browser ──HTTPS──▶ Vercel   (Next.js UI, login, REST API, admin, uploads)
    │                  │
    │                  └──────────────┐
    └──WSS + ticket──▶ Railway "voice" (server.ts: voice WebSocket + ingestion worker)
                          │        │
                          │        └──private network──▶ Railway "stt" (whisper.cpp)
                          ▼
                    Neon Postgres + pgvector  ◀── both Vercel and Railway
                          
 LLM answers and embeddings: Gemini API.   Text-to-speech: the browser's own voice.
```

How the pieces fit:

- **Login** happens on Vercel. The session cookie is not sent cross-site, so before connecting the
  browser gets a 60-second signed ticket from `/api/voice/ticket` (Vercel) and passes it to the
  voice server. Both hosts share `VOICE_TICKET_SECRET`. Signing out revokes outstanding tickets.
- **Uploads** go into Postgres (`VOICERAG_STORAGE_BACKEND=db`) because Vercel and Railway share no
  disk. The Railway worker picks them up from the database queue and indexes them.
- **Speech output** uses the browser's speech synthesis (`TTS_PROVIDER=browser`), so no TTS server.

For a single machine with everything local (lower latency, nothing to split), use
[DEPLOY.md](DEPLOY.md) instead.

> **Data:** questions, retrieved passages and document text (for embeddings) are sent to Google's
> Gemini API, and documents are stored in Neon. Load only the synthetic demo documents until your
> organisation approves these providers (see [SECURITY.md](SECURITY.md)).

You need accounts on GitHub (the repo pushed), [Neon](https://neon.tech), [Railway](https://railway.com)
and [Vercel](https://vercel.com), plus a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

---

## 1. Database (Neon)

1. Create a project. Pick the region closest to your users, and use the same region for Railway and
   Vercel functions below (every voice turn makes several database round trips).
2. From **Connect**, copy two connection strings:
   - **Direct** (host without `-pooler`), for Railway and for migrations/seeding.
   - **Pooled** (host with `-pooler`), for Vercel. Append `&pgbouncer=true&connection_limit=1`.

   Both need `sslmode=require` (Neon includes it).

The `vector` extension is created by the first migration; nothing to enable by hand.

## 2. Generate the shared secret

```bash
openssl rand -hex 32     # → VOICE_TICKET_SECRET (same value on Railway and Vercel)
```

## 3. Railway: speech-to-text service

1. **New project → Deploy from GitHub repo →** this repo. Rename the service to `stt`.
2. **Settings → Config-as-code → Railway config file:** `deploy/railway/stt.json`.
3. **Variables:**

   | Variable | Value | Why |
   |---|---|---|
   | `WHISPER_HOST` | `::` | Railway's private network uses IPv6 |
   | `GGML_NATIVE` | `OFF` | the image is built on a different CPU than it runs on |
   | `WHISPER_THREADS` | number of vCPUs on your plan (e.g. `4`) | |

4. Do **not** generate a public domain. It is reached only as `http://stt.railway.internal:8178`.

The first build compiles whisper.cpp and downloads the model (several minutes).

## 4. Railway: voice service

1. In the same project: **New → GitHub repo →** this repo again. Rename it to `voice`.
2. **Settings → Config-as-code:** `deploy/railway/voice.json` (builds the root `Dockerfile`, runs
   `prisma migrate deploy` before each deploy, health check `/api/health`).
3. **Settings → Networking → Generate domain.** Note it, e.g. `voice-production.up.railway.app`.
4. **Variables** (fill in `<…>`):

   ```bash
   NODE_ENV=production
   TRUST_PROXY=true
   DATABASE_URL=<Neon DIRECT connection string>
   VOICE_TICKET_SECRET=<from step 2>
   VOICE_ALLOWED_ORIGINS=https://<your-app>.vercel.app      # set after step 6; comma-separate several
   VOICERAG_STORAGE_BACKEND=db
   VOICERAG_INPROCESS_WORKER=true

   STT_PROVIDER=whispercpp
   WHISPERCPP_URL=http://stt.railway.internal:8178
   WHISPERCPP_MODEL_PATH=ggml-base.en.bin                     # label only; the model lives in the stt image

   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-2.5-flash
   GEMINI_API_KEY=<your Gemini key>
   LLM_REASONING_EFFORT=none
   LLM_ALLOW_LOCAL_FALLBACK=false
   LLM_FALLBACK_MODEL=

   EMBED_PROVIDER=openai                                       # OpenAI-compatible API, served by Gemini
   EMBED_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   EMBED_API_KEY=<your Gemini key>
   EMBED_MODEL=gemini-embedding-001
   EMBED_DIM=768

   TTS_PROVIDER=browser
   ```

   Copy any tuning values you rely on from `.env.example` (`STT_VOCABULARY`, `RAG_*`, `VOICE_*`).
   Keep exactly **one replica**: per-user session limits and the retrieval cache are in memory.

5. Deploy. `https://<voice-domain>/api/ready` should return `{"ready":true}` once the providers are warm.

## 5. Load the documents and create the first admin

From your machine, against Neon, with the **same embedding settings** as the voice service
(documents must be embedded with the model used at question time):

```bash
export DATABASE_URL='<Neon DIRECT connection string>'
export VOICERAG_STORAGE_BACKEND=db
export EMBED_PROVIDER=openai EMBED_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export EMBED_API_KEY='<your Gemini key>' EMBED_MODEL=gemini-embedding-001 EMBED_DIM=768

npx prisma migrate deploy            # no-op if Railway already ran it
npm run seed:docs
npm run db:seed -- --docs-only       # groups, collections, demo documents (indexed now)
npm run admin:create -- --email you@company.com --name "Your Name"
```

Add more users under **Users** (`/admin/users`) once the site is up.

## 6. Vercel: web UI

1. **Add New → Project →** import this repo. Framework preset: **Next.js** (build command comes
   from `package.json`: `prisma generate && next build`).
   Vercel deploys the repo's default branch to production. If your code is on another branch, set
   **Settings → Environments → Production → Branch Tracking** to it (Railway: **Settings → Source**).
2. **Settings → Functions → Region:** the same region as Neon and Railway.
3. **Environment variables** (Production):

   ```bash
   DATABASE_URL=<Neon POOLED connection string>&pgbouncer=true&connection_limit=1
   VOICE_TICKET_SECRET=<from step 2>
   VOICE_SERVER_URL=https://<voice-domain>                    # readiness checks
   NEXT_PUBLIC_VOICE_WS_URL=wss://<voice-domain>              # read at BUILD time: redeploy after changing
   VOICERAG_STORAGE_BACKEND=db
   VOICERAG_MAX_UPLOAD_MB=4                                   # Vercel caps request bodies at 4.5 MB

   # Shown on /platform and the console; keep in sync with the voice service.
   STT_PROVIDER=whispercpp
   WHISPERCPP_MODEL_PATH=ggml-base.en.bin
   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-2.5-flash
   GEMINI_API_KEY=<your Gemini key>
   LLM_ALLOW_LOCAL_FALLBACK=false
   LLM_FALLBACK_MODEL=
   EMBED_PROVIDER=openai
   EMBED_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   EMBED_API_KEY=<your Gemini key>
   EMBED_MODEL=gemini-embedding-001
   EMBED_DIM=768
   TTS_PROVIDER=browser
   ```

4. Deploy, then put the Vercel URL (`https://<your-app>.vercel.app`, or your custom domain) into
   `VOICE_ALLOWED_ORIGINS` on the Railway voice service and redeploy it.

## 7. Check it

1. `https://<your-app>.vercel.app/api/ready` returns `{"ready":true}` (database + voice server).
2. Sign in, press the microphone button and ask "How many days of annual leave do I get?".
3. If the voice connection fails, open the browser console:
   - `403` on the WebSocket: the Vercel origin is missing from `VOICE_ALLOWED_ORIGINS` (exact
     scheme + host, no trailing path).
   - `401`: `VOICE_TICKET_SECRET` differs between Vercel and Railway.
   - CSP error mentioning `connect-src`: `NEXT_PUBLIC_VOICE_WS_URL` was changed without a redeploy.
   - Railway logs show `whispercpp` unreachable: check the `stt` service is up and `WHISPER_HOST=::`.

## 8. Re-tune retrieval for Gemini embeddings

The retrieval thresholds (`RAG_MIN_VECTOR_SIM`, `RAG_MIN_VECTOR_SIM_WITH_KEYWORD`,
`RAG_MIN_VECTOR_SIM_BORDERLINE`) were tuned for the local `nomic-embed-text` model. Gemini
embeddings have a different similarity range, so run the evaluation against Neon (with the step 5
environment plus the LLM settings) and adjust before inviting users:

```bash
npm run eval:rag -- --generate
```

Watch for answerable questions being abstained (thresholds too high) and unrelated questions being
answered from documents (too low). Set the chosen values on **both** Railway and Vercel.

## Known limits of this setup

- **Latency:** higher than the single-VM setup. Speech-to-text runs on shared Railway CPU, and the
  browser, Vercel, Railway, Neon and Gemini are separate hops. Measure with
  `npm run bench:voice` pointed at the voice service.
- **Browser voice:** sounds different on each OS and browser, and some browsers have no good
  English voice installed.
- **One voice replica:** scale up the instance, not the replica count.
- **Uploads:** at most 4 MB per file through Vercel.
- **Vercel Hobby** is for non-commercial use; use a Pro plan for company deployments.
