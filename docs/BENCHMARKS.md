# Benchmarks and evaluation (measured, 2026-10-10)

Every number here comes from a reproducible run whose raw output is in `bench-results/` (gitignored;
re-run the commands to regenerate). Nothing is projected or extrapolated.
**The sub-500 ms end-of-speech-to-first-audio stretch target was _not_ achieved in this environment.**
Details and reasons are below.

## Test environment

| | |
|---|---|
| Hardware | Apple M1, 8 GB unified memory, macOS 14.5 |
| Machine state | **Heavily memory-constrained:** 8.6–9.8 GB of swap in use during all runs (browser, IDE, a VM and MySQL running alongside). This inflates and destabilises model latency, and is the dominant factor in the tail numbers. |
| STT | whisper.cpp v1.8.2 server, `ggml-base.en`, Metal, greedy, `-nc -nf` |
| LLM | Ollama 0.40, `llama3.2:1b` (default) / `llama3.2:3b` (compared) |
| Embeddings | Ollama `nomic-embed-text` (768-d) |
| TTS | Piper 1.8 `en_US-lessac-medium` (22.05 kHz), persistent sidecar |
| DB | PostgreSQL 16.15 + pgvector 0.8.1 (HNSW, iterative scan) |
| Corpus | 9 synthetic documents, 36 chunks, 5 collections |
| Network | localhost (no WAN; production adds client↔server RTT) |

## Definitions

- **Perceived latency.** Time from the last voiced microphone frame to the first assistant audio. It includes the
  VAD end-of-turn hangover (550 ms). It is measured on the client's clock, by `bench:voice` or by the browser through `playback_started`.
- **EOS → first audio.** Time from when the server receives `speech_end` to when the first audio frame is sent. This is pipeline latency only.
- **Warm.** Models are loaded and the server has served at least one turn. The first turn after a process start is recorded as `coldStart`.
- **Percentiles.** Nearest-rank. With n < 100, p99 equals the maximum.

## 1. End-to-end voice latency (real providers, `npm run bench:voice`)

Spoken questions are synthesised with macOS `say`, then streamed in real time over the voice WebSocket
through the same `EnergyVad` the browser uses. Each run has 12 questions (10 answerable, 2 unanswerable) and one warm-up turn.

| Run (in order) | Config | n | Perceived p50 / p95 / max (ms) | EOS→first audio p50 / p95 | LLM TTFT p50 | Notes |
|---|---|---|---|---|---|---|
| `smoke` | 3B model, k=4, speculative STT+retrieval | 11 | 6 921 / 21 136 / 21 136 | 6 330 / 20 537 | 4 788 | Baseline; one timeout |
| `1b-local` | 1B model, k=3 | 12 | 1 002 / 5 387 / 5 387 | 438 / 4 821 | 1 438 | 6 of 10 answerable questions abstained because of STT errors, so many turns took the fast path |
| `1b-specllm-vocab` | + speculative LLM, STT vocabulary prompt | 24 | 2 102 / 6 688 / 6 983 | 1 541 / 6 118 | 2 189 | EOS → first token p50 **621 ms** |
| `1b-nocontext` (current) | + whisper `-nc -nf` (fixes cross-request context bug) | 24 | 2 828 / 11 423 / 13 795 | 2 206 / 10 847 | 1 906 | Transcript word accuracy p50 **100%**; 18/24 turns reached the LLM |

The same runs split by path (perceived, ms):

| Run | Answered: n, p50, p95, best | Abstained (no LLM): n, p50, p95, best |
|---|---|---|
| `1b-specllm-vocab` | 11 · 4 068 · 6 983 · 2 102 | 13 · 919 · 4 187 · 705 |
| `1b-nocontext` | 18 · 3 986 · 13 795 · **2 131** | 6 · 1 083 · 1 703 · 884 |

### Speed tuning pass (same machine, back-to-back runs, 24 turns each)

| | `tune-baseline` | `tune-final` | Change |
|---|---|---|---|
| Perceived p50 / p95 / max | 6 827 / 11 279 / 12 138 | **2 882 / 5 521 / 7 005** | −58% / −51% |
| EOS → first token p50 | 2 991 | 1 178 | |
| LLM TTFT p50 | 3 004 | 1 249 | |
| TTS first chunk p50 | 1 589 | 420 | |
| Pre-rendered turns (speculative hit) | 79% | 100% | |
| Perceived under 1 s | 1/24 | 5/24 (abstention / cache path) | |

Changes in the tuning pass:

- **Full-turn pre-render.** Retrieval, LLM and TTS all start at the pause and sit behind an output gate until the end of turn is confirmed.
- **Live partial transcripts off by default** (`STT_PARTIAL_INTERVAL_MS=0`), because they compete for the shared GPU.
- **Ollama context window 4096 → 2048.**
- **First spoken clause after 3 words**, and pause detection at 150 ms.

Tried and rejected:

- **whisper `-ac 768`:** 2.7× faster STT, but it misheard "per diem", which breaks retrieval.
- **An "answer-first" prompt:** within eval noise on accuracy, and it produced one wrong answer with the 1B model.

Swap in use was 9.1–10.2 GB across these runs. Run-to-run noise on this machine is large.

Real browser, real providers (`playwright.real.config.ts`): Chromium, a fake microphone carrying a spoken
question, then whisper.cpp, Ollama 1B and Piper. The turn was answered correctly with a citation (Leave policy, "2. Annual Leave", p. 1).
The browser measured **4 379 ms** perceived, with EOS → first audio 3 657 ms (STT 210, retrieval 2, LLM TTFT 2 650, TTS 769).

### Where the time goes (current configuration)

| Stage | Isolated, warm | Inside the voice pipeline (p50 / p95) |
|---|---|---|
| VAD hangover | 550 ms (fixed, configurable) | 550 |
| STT, whisper base.en (about 3 s utterance) | 175–380 ms | 258 / 560. **Hidden:** EOS → transcript p50 0 ms (speculation hit 92–100%) |
| Retrieval (embed + hybrid SQL) | p50 23–28 ms, p95 47–77 ms (`eval:rag`) | 5 / 457 (EOS → evidence p50 ≈ 1–3 ms) |
| LLM TTFT, `llama3.2:1b` | p50 444, p95 1 413 (`eval:rag`) | 1 906 / 5 928 |
| TTS first chunk (Piper, one clause) | 160–210 ms per sentence | 356–558 / 936–5 069 |

**Bottleneck:** LLM time-to-first-token. On this machine it is 4–5× slower inside the live pipeline than in
isolation. Ollama, whisper.cpp and Piper contend for the GPU and CPU, and the system is swapping. Speculative
generation hides up to about 300 ms of TTFT inside the hangover. The rest is on the critical path.

### Status against the latency targets

| Target | Status on this machine |
|---|---|
| < 500 ms EOS → first audio (stretch) | **Not met** for answered turns. The best EOS → first-audio turns were about 380–440 ms, all abstentions or retrieval-cache hits. |
| < 1 s to first audio, short queries, warm | **Met on the abstention path** (perceived p50 0.9–1.1 s). **Not met for answered turns** (perceived p50 ≈ 2.8–4.0 s, best 2.1 s). |
| < 200 ms retrieval, warm index | **Met:** p50 23–28 ms, p95 47–77 ms (`eval:rag`); p95 457 ms under live contention |

### What it would take to get under 1 s and toward 500 ms

These are estimates, not measurements:

1. **Move the LLM off this laptop** (the biggest lever). A hosted model with roughly 200–400 ms TTFT, or a dedicated GPU host, combined with speculation, puts EOS → first audio near TTS-first-chunk + network.
2. **Streaming STT** (for example Deepgram, AssemblyAI or OpenAI realtime transcription) with server-side endpointing. This lets the 550 ms hangover shrink.
3. **A shorter hangover** with semantic end-of-turn detection, trading against cutting users off.
4. **Streaming TTS** with a first chunk under 100 ms.

The synthetic load test (below) shows the orchestration itself adds only about 3 ms. Most of the gap is
model latency on this hardware.

## 2. Orchestration, concurrency and failure modes (**SYNTHETIC**, `npm run bench:load`)

Mock providers with simulated latencies (STT 150 ms, LLM TTFT 300 ms + 15 ms/token, TTS 80 ms). Everything
else is real: WebSockets, Postgres/pgvector retrieval, speculation, cancellation, persistence and metrics.
**This measures overhead and behaviour, not model latency.**

| Scenario | Sessions | Turns | EOS→first audio p50 / p95 / p99 (ms) | Result |
|---|---|---|---|---|
| concurrency 1 | 1 | 5 | 83 / 90 / 90 | Simulated floor after speculation ≈ 80 ms (TTS) → overhead ≈ 3 ms |
| concurrency 10 | 10 | 50 | 82 / 83 / 87 | 10.6 turns/s |
| concurrency 25 | 25 | 125 | 82 / 91 / 99 | 26.4 turns/s |
| concurrency 50 | 50 | 250 | 83 / 133 / 157 | 51.2 turns/s |
| slow LLM (2 s TTFT) | 10 | 30 | 1 751 / 1 759 / 1 759 | Part of the TTFT hidden by speculation; no timeouts |
| long answers (×8) | 10 | 30 | 83 / 86 / 86 | First audio independent of answer length |
| barge-in on 50% of turns | 10 | 40 | 82 / 93 / 93 | 24 turns cancelled, **0 stale audio frames** after cancel |
| LLM outage | 5 | 10 | n/a | 10/10 turns report `error` cleanly; no hangs |

With real local models, concurrency is limited by the single whisper.cpp and Ollama processes, which serve
one request at a time. That is a capacity issue, addressed by hosted providers or more model workers.

## 3. Retrieval and answer quality (`npm run eval:rag [-- --generate]`)

53 labelled cases (`seed/eval-set.ts`):

- 32 answerable;
- 12 unanswerable;
- 7 cross-permission ("forbidden");
- 2 prompt injection.

13 of them are a held-out split never used for tuning.

**Retrieval** (nomic-embed-text, k=3):

| Metric | Result |
|---|---|
| Recall@1 / @3 (gold document) | 100% / 100% |
| MRR | 1.000 |
| Gold document in final evidence after policy | 94.1% (2 false abstentions: h01, h06) |
| Abstention accuracy, tuning split (n=40) | 100% (**in-sample**, the thresholds were tuned here) |
| Abstention accuracy, held-out split (n=13) | **84.6%** (both errors are false abstentions on paraphrases) |
| Permission leaks (any chunk outside the user's scope retrieved) | **0 / 53** |
| Retrieval latency (embed + search, cache off) | p50 23–28 ms, p95 47–77 ms |

The top-cosine distributions overlap (answerable min 0.676, should-abstain max 0.724). That is why the
policy combines similarity with keyword coverage, and why the held-out score is lower than the tuning score.

**Generation** (text turns, warmed model, k=3):

| Metric | `llama3.2:1b` (default) | `llama3.2:3b` |
|---|---|---|
| Answer accuracy (answerable, fact present) | 87.5% | 90.6% |
| Correct abstention (unanswerable + forbidden) | 100% | 100% |
| Answers citing the gold source / all citations gold | 100% / 100% | 100% / 100% |
| Groundedness (lexical support of cited sentences) | p50 100% | p50 100% |
| Prompt injection resisted (2 cases) | 100% | 100% |
| Leaks in answers (forbidden cases) | 0 | 0 |
| LLM TTFT p50 / p95 | **444 / 1 413 ms** | 1 066 / 4 165 ms |

Before the evidence-sanitisation defence was added, the 3B model **failed** one injection case. It read out
the planted "password" and part of the system prompt. This is why sentence-level neutralisation and the
output guard exist. Groundedness is a lexical heuristic, not an entailment judgement; treat it as a smoke test.

Speech recognition over the voice path:

- Transcript word accuracy p50 is 100% after the whisper `-nc` fix.
- A cross-request context bug had previously truncated a transcript to "open?". It came from whisper.cpp conditioning on the previous request.
- `base.en` still mis-hears some synthetic-voice words ("primary caregiver" became "primary cara driver"). `small.en` or a hosted STT is recommended for the pilot.

## Reproduce

```bash
npm run sidecars & npm run build && npm start &          # real providers
npm run eval:rag -- --generate                           # quality
npm run bench:voice -- --rounds 2 --label mylabel        # end-to-end voice latency
npm run bench:load                                       # SYNTHETIC orchestration/concurrency
npx playwright test -c playwright.real.config.ts         # real browser + real providers
```
