// Single source of truth for the technology inventory (Platform page + docs/TECH-STACK.md).
// Versions are the ones installed and verified in this build.

export interface Tech {
  name: string;
  version: string;
  role: string;
  /** Where it runs. */
  runs: "Browser" | "App server" | "AI services" | "Database" | "Cloud (optional)" | "Build & test";
}

export interface TechLayer {
  id: string;
  title: string;
  summary: string;
  items: Tech[];
}

export const TECH_LAYERS: TechLayer[] = [
  {
    id: "frontend",
    title: "Frontend & user experience",
    summary: "Server-rendered web app with a real-time voice client running entirely in the browser.",
    items: [
      { name: "Next.js", version: "15.5", role: "React framework: App Router, server rendering, API routes", runs: "App server" },
      { name: "React", version: "19.3", role: "UI components for the assistant, admin and info pages", runs: "Browser" },
      { name: "TypeScript", version: "5.9", role: "Strictly-typed code across client, server and tests", runs: "Build & test" },
      { name: "Tailwind CSS", version: "4.3", role: "Utility-first styling for the VIH design system", runs: "Build & test" },
      { name: "Web Audio API + AudioWorklet", version: "W3C", role: "Microphone capture, 16 kHz resampling, gapless playback", runs: "Browser" },
      { name: "Clash Display & Inter", version: "self-hosted", role: "VIH brand typography, served from the app (no font CDN)", runs: "Browser" },
    ],
  },
  {
    id: "realtime",
    title: "Real-time backend",
    summary: "One Node.js process serves the web app, the REST API and the voice WebSocket.",
    items: [
      { name: "Node.js", version: "22+ (26.8 dev)", role: "Runtime for the custom web + WebSocket server", runs: "App server" },
      { name: "ws", version: "8.22", role: "Authenticated, origin-checked voice WebSocket (binary PCM both ways)", runs: "App server" },
      { name: "Zod", version: "3.25", role: "Request validation for API inputs", runs: "App server" },
      { name: "tsx", version: "4.23", role: "TypeScript execution for server, worker and scripts", runs: "App server" },
      { name: "Node crypto", version: "built-in", role: "scrypt password hashing, SHA-256 session tokens and content hashes", runs: "App server" },
    ],
  },
  {
    id: "ai",
    title: "AI models (on VIH infrastructure)",
    summary: "Speech, language, search and voice models that run locally — no data leaves the server.",
    items: [
      { name: "whisper.cpp", version: "1.8.2", role: "Speech-to-text, Metal GPU accelerated, model ggml-base.en", runs: "AI services" },
      { name: "Ollama", version: "0.40", role: "Local model server for the LLM and embeddings", runs: "AI services" },
      { name: "Llama 3.2", version: "1B (3B alt.)", role: "Answer generation from retrieved evidence", runs: "AI services" },
      { name: "nomic-embed-text", version: "v1.5 · 768-d", role: "Semantic embeddings for document and query search", runs: "AI services" },
      { name: "Piper TTS", version: "1.8.0", role: "Neural text-to-speech, voice en_US-lessac-medium", runs: "AI services" },
      { name: "ONNX Runtime", version: "1.31", role: "Inference engine behind Piper", runs: "AI services" },
    ],
  },
  {
    id: "cloud",
    title: "Cloud AI (pluggable, optional)",
    summary: "Swap any stage to an approved cloud provider by configuration — no code changes.",
    items: [
      { name: "Google Gemini", version: "2.5 Flash", role: "Faster LLM option via Gemini's OpenAI-compatible API", runs: "Cloud (optional)" },
      { name: "Anthropic Claude", version: "SDK 0.129", role: "LLM option via the official Anthropic SDK (streaming)", runs: "Cloud (optional)" },
      { name: "OpenAI-compatible APIs", version: "v1", role: "Any compatible STT, LLM, TTS or embedding service", runs: "Cloud (optional)" },
    ],
  },
  {
    id: "data",
    title: "Data, search & documents",
    summary: "One PostgreSQL database holds users, permissions, documents, vectors, conversations and metrics.",
    items: [
      { name: "PostgreSQL", version: "16", role: "Primary database with transactions and row-level job locking", runs: "Database" },
      { name: "pgvector", version: "0.8.1", role: "HNSW vector index with iterative scans for permission-filtered search", runs: "Database" },
      { name: "PostgreSQL full-text search", version: "16", role: "Keyword search (tsvector + GIN), fused with vector results", runs: "Database" },
      { name: "Prisma ORM", version: "6.19", role: "Type-safe data access and migration-managed schema", runs: "App server" },
      { name: "unpdf", version: "1.8", role: "PDF text extraction with real page numbers", runs: "App server" },
      { name: "mammoth", version: "1.13", role: "DOCX extraction preserving heading structure", runs: "App server" },
    ],
  },
  {
    id: "quality",
    title: "Quality, testing & operations",
    summary: "Every turn is measured; every layer is tested.",
    items: [
      { name: "Vitest", version: "3.2", role: "Unit and integration tests against a real test database", runs: "Build & test" },
      { name: "Playwright", version: "1.64", role: "Browser end-to-end tests with a fake microphone (Chromium)", runs: "Build & test" },
      { name: "ESLint", version: "9.39", role: "Static analysis with Next.js rules", runs: "Build & test" },
      { name: "GitHub Actions", version: "CI", role: "Lint, type-check, tests on pgvector, production build, E2E", runs: "Build & test" },
      { name: "RAG eval & benchmarks", version: "in-house", role: "Recall@K, abstention, citations, injection; real-voice latency p50/p95/p99", runs: "Build & test" },
      { name: "Health & readiness probes", version: "in-house", role: "/api/health and /api/ready for deployment orchestration", runs: "App server" },
    ],
  },
];

/** Layers of the runtime architecture, top to bottom. */
export const ARCHITECTURE = [
  { layer: "Client", detail: "Browser", parts: ["React 19 UI", "AudioWorklet mic", "Voice activity detection", "Streaming playback"] },
  { layer: "Gateway", detail: "App server", parts: ["Next.js 15", "WebSocket (ws)", "Auth & permissions", "Turn orchestrator"] },
  { layer: "Intelligence", detail: "AI services", parts: ["whisper.cpp STT", "Llama 3.2 / Gemini / Claude", "nomic embeddings", "Piper TTS"] },
  { layer: "Knowledge", detail: "Database", parts: ["PostgreSQL 16", "pgvector HNSW", "Full-text search", "Prisma"] },
];
