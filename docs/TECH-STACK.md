# Technology stack

Generated from `src/shared/tech-stack.ts`, the same source as the in-app **Platform** page. Versions are the ones installed and verified in this build.

## Architecture

| Layer | Runs on | Components |
|---|---|---|
| Client | Browser | React 19 UI · AudioWorklet mic · Voice activity detection · Streaming playback |
| Gateway | App server | Next.js 15 · WebSocket (ws) · Auth & permissions · Turn orchestrator |
| Intelligence | AI services | whisper.cpp STT · Llama 3.2 / Gemini / Claude · nomic embeddings · Piper TTS |
| Knowledge | Database | PostgreSQL 16 · pgvector HNSW · Full-text search · Prisma |

## Frontend & user experience

Server-rendered web app with a real-time voice client running entirely in the browser.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| Next.js | 15.5 | React framework: App Router, server rendering, API routes | App server |
| React | 19.3 | UI components for the assistant, admin and info pages | Browser |
| TypeScript | 5.9 | Strictly-typed code across client, server and tests | Build & test |
| Tailwind CSS | 4.3 | Utility-first styling for the VIH design system | Build & test |
| Web Audio API + AudioWorklet | W3C | Microphone capture, 16 kHz resampling, gapless playback | Browser |
| Clash Display & Inter | self-hosted | VIH brand typography, served from the app (no font CDN) | Browser |

## Real-time backend

One Node.js process serves the web app, the REST API and the voice WebSocket.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| Node.js | 22+ (26.8 dev) | Runtime for the custom web + WebSocket server | App server |
| ws | 8.22 | Authenticated, origin-checked voice WebSocket (binary PCM both ways) | App server |
| Zod | 3.25 | Request validation for API inputs | App server |
| tsx | 4.23 | TypeScript execution for server, worker and scripts | App server |
| Node crypto | built-in | scrypt password hashing, SHA-256 session tokens and content hashes | App server |

## AI models (on VIH infrastructure)

Speech, language, search and voice models that run locally — no data leaves the server.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| whisper.cpp | 1.8.2 | Speech-to-text, Metal GPU accelerated, model ggml-base.en | AI services |
| Ollama | 0.40 | Local model server for the LLM and embeddings | AI services |
| Llama 3.2 | 1B (3B alt.) | Answer generation from retrieved evidence | AI services |
| nomic-embed-text | v1.5 · 768-d | Semantic embeddings for document and query search | AI services |
| Piper TTS | 1.8.0 | Neural text-to-speech, voice en_US-lessac-medium | AI services |
| ONNX Runtime | 1.31 | Inference engine behind Piper | AI services |

## Cloud AI (pluggable, optional)

Swap any stage to an approved cloud provider by configuration — no code changes.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| Google Gemini | 2.5 Flash | Faster LLM option via Gemini's OpenAI-compatible API | Cloud (optional) |
| Anthropic Claude | SDK 0.129 | LLM option via the official Anthropic SDK (streaming) | Cloud (optional) |
| OpenAI-compatible APIs | v1 | Any compatible STT, LLM, TTS or embedding service | Cloud (optional) |

## Data, search & documents

One PostgreSQL database holds users, permissions, documents, vectors, conversations and metrics.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| PostgreSQL | 16 | Primary database with transactions and row-level job locking | Database |
| pgvector | 0.8.1 | HNSW vector index with iterative scans for permission-filtered search | Database |
| PostgreSQL full-text search | 16 | Keyword search (tsvector + GIN), fused with vector results | Database |
| Prisma ORM | 6.19 | Type-safe data access and migration-managed schema | App server |
| unpdf | 1.8 | PDF text extraction with real page numbers | App server |
| mammoth | 1.13 | DOCX extraction preserving heading structure | App server |

## Quality, testing & operations

Every turn is measured; every layer is tested.

| Technology | Version | Role | Runs on |
|---|---|---|---|
| Vitest | 3.2 | Unit and integration tests against a real test database | Build & test |
| Playwright | 1.64 | Browser end-to-end tests with a fake microphone (Chromium) | Build & test |
| ESLint | 9.39 | Static analysis with Next.js rules | Build & test |
| GitHub Actions | CI | Lint, type-check, tests on pgvector, production build, E2E | Build & test |
| RAG eval & benchmarks | in-house | Recall@K, abstention, citations, injection; real-voice latency p50/p95/p99 | Build & test |
| Health & readiness probes | in-house | /api/health and /api/ready for deployment orchestration | App server |
