# VIH VoiceRAG

A real-time, permission-aware voice assistant over an internal knowledge base for VIH Metaverse.
You speak in the browser. The system transcribes your speech, retrieves authorised evidence,
generates a short cited answer and speaks it back while the answer is still being generated.
You can interrupt it at any time by talking.

> **Status: internal pilot candidate, running on synthetic data.** The knowledge base ships with
> invented documents (`seed/`). Do not load real company documents or connect company systems
> until the organisation approves the chosen providers and their data-handling terms
> (see [docs/SECURITY.md](docs/SECURITY.md)).

## What works today (verified)

| Capability | How it was verified |
|---|---|
| Real browser voice session: mic → VAD → STT → RAG → streamed LLM → incremental TTS → playback | Playwright with Chromium and a fake capture device (`tests/e2e`); real-provider runs with `bench:voice` |
| Barge-in: talking over the assistant stops playback locally and cancels generation and TTS server-side, with no stale audio | `tests/unit/turn.test.ts`, `tests/integration/voice-session.test.ts`, E2E |
| Permission-aware hybrid retrieval (pgvector HNSW + Postgres full-text, RRF fusion) with page or section citations | Integration tests; `eval:rag` (0 leaks) |
| Explicit abstention when evidence is insufficient (no LLM call) | `eval:rag` |
| Prompt-injection defences for retrieved text | `eval:rag` injection cases; unit tests |
| Stage-by-stage latency instrumentation, p50/p95/p99 dashboard | `/admin/metrics`; `bench:voice` |
| Ingestion of PDF, DOCX, TXT and Markdown with versioning, re-indexing, deletion and duplicate guards | Integration tests |

Measured numbers, test conditions and known limits are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

In-app pages:

- `/about`: VIH Metaverse company and product overview.
- `/how-it-works`: the pipeline, with live measured stage timings.
- `/platform`: the tech stack and live provider configuration.

The assistant can also answer company questions (for example "What does ViH Shruti do?") from the *About VIH Metaverse* document.

## Architecture in one picture

```
Browser ──────────────────────────────────────────────┐   Node server (one process)
 mic → AudioWorklet (16 kHz PCM, 20 ms) → EnergyVad     │   ┌──────────────────────────────────────────────┐
   speech_start / pause / speech_end + PCM frames ──WS──┼──▶│ VoiceSession                                 │
                                                        │   │  pause → speculative STT ─▶ speculative       │
 PcmPlayer ◀── audio frames (turn-numbered) ◀───────WS──┼───│          retrieval ─▶ speculative LLM (buffered)│
 transcript, citations, state ◀─────────────────────────┤   │  end   → validate → release → TTS per clause  │
                                                        │   │ Next.js: UI, REST API, admin, metrics        │
                                                        │   └───┬───────────┬─────────────┬──────────────┘
                                                        │       │           │             │
                                                        │  whisper.cpp    Ollama       Piper TTS      Postgres 16
                                                        │  (STT sidecar)  (LLM+embed)  (sidecar)     + pgvector
```

Details and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (macOS, local providers; nothing leaves the machine)

Prerequisites: Node 22+, PostgreSQL 16 with pgvector ≥ 0.8, Ollama, Python 3.10+.
Full setup, including how to build whisper.cpp and get the Piper voice, is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

```bash
cp .env.example .env                       # set DATABASE_URL / DATABASE_URL_TEST
npm install
createdb vih_voicerag && createdb vih_voicerag_test
npm run db:deploy && DATABASE_URL=$DATABASE_URL_TEST npm run db:deploy

ollama pull llama3.2:1b && ollama pull nomic-embed-text
python3 -m venv .venv-tts && .venv-tts/bin/pip install piper-tts
npm run sidecars                           # whisper.cpp STT :8178 + Piper TTS :8179 (keep running)

npm run seed:docs && npm run db:seed       # synthetic users/collections/docs, indexed
npm run build && npm start                 # http://localhost:3100
```

Synthetic accounts (password = `VOICERAG_SEED_PASSWORD`):

| User | Role | Can retrieve from |
|---|---|---|
| `admin@vih.test` | Admin | all collections |
| `alice@vih.test` | Member (engineering) | General, HR, IT & Security, Engineering |
| `bob@vih.test` | Member (finance) | General, HR, IT & Security, Finance |
| `carol@vih.test` | Member (no groups) | nothing (gets an explicit no-access answer) |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Development / production server (UI, API and voice WebSocket on `PORT`) |
| `npm run sidecars` | Local STT and TTS sidecars |
| `npm run worker` | Standalone ingestion worker (when `VOICERAG_INPROCESS_WORKER=false`) |
| `npm test` | Unit and integration tests (deterministic mocks, disposable test DB) |
| `npm run test:e2e` | Browser E2E (Chromium, fake microphone, production build) |
| `REAL_PROVIDERS=1 npm run test:providers` | Real-provider integration suite |
| `npm run eval:rag [-- --generate]` | Retrieval and answer-quality evaluation |
| `npm run bench:voice -- --rounds 3` | Real end-to-end voice latency benchmark (server must be running) |
| `npm run bench:load` | **Synthetic** concurrency and failure-mode load test (mock providers) |
| `npm run retention:purge` | Apply the retention policy |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design, latency strategy, RAG, abstention policy, option A vs B
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md): measured latency and quality, conditions, bottlenecks
- [docs/SECURITY.md](docs/SECURITY.md): controls, data flows, privacy, production gaps
- [docs/PROVIDERS.md](docs/PROVIDERS.md): provider configuration and selection criteria
- [docs/TECH-STACK.md](docs/TECH-STACK.md): every technology, with version and role
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deployment, troubleshooting, cost, backup, readiness checklist
