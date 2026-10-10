# Providers

Each pipeline stage is selected independently in `.env`. Model and voice identifiers live only in configuration.

| Stage | Key | Implementations | Verified here |
|---|---|---|---|
| STT | `STT_PROVIDER` | `whispercpp` (local sidecar), `openai` (any OpenAI-compatible `/audio/transcriptions`), `mock` | whispercpp ✔ (real runs) |
| LLM | `LLM_PROVIDER`, `LLM_MODEL` | `ollama`, `anthropic` (official SDK, streaming), `openai` (any OpenAI-compatible `/chat/completions`, e.g. OpenAI, Groq, vLLM), `mock` | ollama ✔ |
| Embeddings | `EMBED_PROVIDER`, `EMBED_MODEL`, `EMBED_DIM` | `ollama`, `openai`, `mock` | ollama ✔ |
| TTS | `TTS_PROVIDER` | `piper` (local sidecar), `openai` (`/audio/speech`, streamed PCM), `browser` (Web Speech API on the client), `mock` | piper ✔ |
| Realtime S2S | — | Interface only (`RealtimeSpeechProvider`) | — |

**Not verified against live services (no credentials were available):** `anthropic`, all `openai`-compatible
paths, and browser TTS. They are written against the vendors' documented APIs and typecheck, but have never
made a real call. Run `REAL_PROVIDERS=1 npm run test:providers` after configuring them, before any pilot use.

## Recommended configurations

| Profile | STT | LLM | TTS | Notes |
|---|---|---|---|---|
| **Private / offline (default)** | whisper.cpp `small.en` on a GPU host | Ollama or vLLM, 3B–8B, on a dedicated GPU | Piper | No data leaves your infrastructure. Needs a GPU box; on a laptop see BENCHMARKS.md. |
| **Lowest latency (needs approval)** | Hosted streaming STT | Hosted fast model through `anthropic` or `openai` | Hosted streaming TTS | Expect TTFT of a few hundred ms. Audio and text go to vendors. |

Anthropic: `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=…`, `LLM_MODEL=claude-opus-5-5` (the default
recommendation). The provider requests `effort: "low"` for short spoken answers and enables the server-side
refusal fallback. For latency, benchmark `claude-haiku-5-5` and choose on measured TTFT and answer quality
(`eval:rag --generate` plus `bench:voice`). Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK`
to get cost per turn on the dashboard.

## Selection criteria (fill in per candidate before the pilot)

| Criterion | How to evaluate |
|---|---|
| Latency | `bench:voice` p50/p95 for EOS → first audio and stage TTFT, from the deployment region |
| Streaming | Partial transcripts, token streaming, chunked PCM TTS |
| Accuracy | `eval:rag --generate` answer, abstention, citation and injection scores; STT word accuracy on staff voices and accents |
| Data handling | Retention, training use, zero-retention options, sub-processors, DPA |
| Residency | Region pinning matching policy (for example India/EU) |
| Cost per turn | See OPERATIONS.md (cost model) |
| Reliability | Rate limits, status history, timeouts and retries (handled by `ProviderError` with `retryable`) |

## Adding a provider

Implement the interface in `src/server/providers/types.ts` (honour the `AbortSignal`; throw `ProviderError`
with `retryable` set correctly), register it in `registry.ts`, and add it to `tests/providers`.
