# Architecture

## Goals and constraints

The priority is the time from the end of the user's speech to the first audible answer. Next come
grounded, permission-safe answers. Any work done early to save time must be safe to throw away.
Each stage sits behind a provider interface ([`src/server/providers/types.ts`](../src/server/providers/types.ts)).
No vendor model ID appears outside configuration.

## Option A vs option B

| | A. Modular pipeline (implemented) | B. Realtime speech-to-speech |
|---|---|---|
| Pipeline | VAD → STT → hybrid RAG → streaming LLM → incremental TTS | One realtime audio model; retrieval through a `search_knowledge` tool call |
| Retrieval control | Deterministic. Retrieval always runs, inside the user's permission scope, before generation. The abstention policy is enforced in code. | Model-driven. The model decides whether to call the tool, and abstention relies on the prompt. |
| Citations | Exact: only markers that map to supplied passages are shown or spoken | Have to be rebuilt from tool results |
| Data flow | Each stage can be local or approved separately | All audio goes to one vendor |
| Latency | Sum of stages, partly overlapped by speculation (below) | Lower floor (no TTS/STT hand-offs), but a tool call adds a round trip |
| Status | Implemented, tested, benchmarked | Interface only (`RealtimeSpeechProvider`). **Not benchmarked: no realtime-audio credentials were available.** |

A is the right baseline for an internal knowledge assistant:

- Permission enforcement and abstention are code, not prompts.
- Citations are verifiable.
- No audio has to go to a third party.

B is worth benchmarking once a provider is approved. A turn calls `search_knowledge`, which runs
`retrieve()` with the session's scope. The same eval set can then compare grounding and latency.

## Request flow (one voice turn)

```
browser                                     server (VoiceSession)
───────                                     ─────────────────────
speech_start + 300 ms pre-roll  ─────────▶  buffer PCM; cancel any active turn (barge-in)
PCM frames (20 ms, only while speaking) ─▶  buffer (cap VOICE_MAX_UTTERANCE_SECONDS)
pause (150 ms of silence)  ──────────────▶  SPECULATE: STT(buffer) → scope → runTurn() (retrieve → LLM → TTS)
                                             with all output held in an OutputGate
                                             (nothing is sent to the client)
resume (speech continues) ───────────────▶  discard speculation (abort signal)
speech_end (after 550 ms of silence) ────▶  t=0. Transcript = speculative STT if valid, else STT now
                                ◀───────────  turn_start, transcript
                                             validate: same query, same scope key, same history
                                ◀───────────  evidence (sources)   [abstain → canned answer, no LLM]
                                ◀───────────  tokens (streamed text with [n] markers)
                                             segmenter: first clause (≥ 4 words) → TTS → audio frames
                                ◀───────────  binary audio (header: turn number, seq, sample rate)
PcmPlayer schedules gaplessly; reports playback_started with its own timing
                                ◀───────────  answer_done (messageId, cited), turn_end (metrics)
                                             persist message, citations, metrics (async)
```

### Latency techniques and their measured effect

| Technique | Where | Effect |
|---|---|---|
| Speculative STT on `pause` | `session.ts` | Transcript is usually ready at end-of-turn (EOS → transcript p50 0 ms in `bench:voice`) |
| Speculative retrieval on the speculative transcript | `session.ts` | Evidence is usually ready at end-of-turn (EOS → evidence p50 ≈ 1 ms) |
| Full-turn pre-render behind an `OutputGate` (retrieval, LLM and TTS start at the pause) | `session.ts`, `gate.ts` | Pre-rendered on 100% of benchmark turns. Perceived p50 6.8 s → 2.9 s on the dev laptop. Output is released only after validation. |
| First speech segment at a clause boundary | `segmenter.ts` | TTS starts after about 4 words instead of a full sentence |
| Per-segment streaming TTS, pipelined with the LLM | `turn.ts` | Audio starts long before generation ends |
| Deterministic abstention (no LLM call) | `turn.ts` | Abstentions cost about 0.4–0.8 s end-to-end |
| Warm-up at boot, `keep_alive`, pooled keep-alive HTTP | `registry.ts`, providers | Avoids model loads on the first user turn |
| One SQL round trip for hybrid search; HNSW iterative scan | `retrieve.ts` | Retrieval p50 ≈ 30 ms warm (eval) |
| Query-embedding and retrieval caches (authorisation-scoped) | `retrieve.ts` | Repeated questions skip the embed and search |
| Single persistent WebSocket per session; no transcoding | protocol | No per-turn connection setup; raw PCM16 both ways |

Speculation is safe:

- Results stay server-side until `speech_end` confirms the same transcript, scope key and history length.
- Any mismatch aborts the speculative work through its `AbortController`, which also cancels the
  underlying HTTP request to Ollama.

### Cancellation

Each turn has a single `AbortSignal`, which reaches:

- the provider `fetch` calls (Ollama streaming, whisper.cpp, Piper);
- the Anthropic SDK request;
- the TTS consumer loop;
- speculative work.

Barge-in is handled on both sides:

1. The browser stops playback and drops frames for the cancelled turn number at once, with no round trip.
2. The server aborts the turn when it processes `speech_start` or `cancel`. Because the socket is ordered, no audio frame for the old turn is sent after that point (asserted in tests).

Every provider call is bounded:

- **STT:** 10 s timeout.
- **LLM:** `LLM_TIMEOUT_MS` timeout, plus one retry only if no token has streamed yet.
- **TTS:** 10 s timeout. On failure the answer stays as text.

## RAG

**Ingestion** ([`ingest.ts`](../src/server/rag/ingest.ts)): `DocumentVersion` rows are the job queue.

- **Claiming:** jobs are claimed with `FOR UPDATE SKIP LOCKED`, so any number of workers is safe.
- **Extraction:** keeps real PDF page numbers, DOCX and Markdown heading paths, and TXT paragraphs.
- **Chunking:** structure-aware. A chunk never crosses a section; there is sentence overlap inside a section.
- **Embedding:** embeddings are cached by `sha256(title + section + text)` and model, so retries and re-indexing never pay twice.
- **Activation:** a single transaction swaps the active chunks, sets `currentVersion`, and bumps `IndexState.version`.
- **Deletion:** removes chunks in the same kind of transaction, erases files, and scrubs citation excerpts.

**Retrieval** ([`retrieve.ts`](../src/server/rag/retrieve.ts)): one CTE runs a pgvector cosine top-N and a
full-text top-N (OR of query lexemes), both filtered inside SQL by `collectionId = ANY(scope)`.

- **Ranking:** reciprocal-rank fusion, then at most 2 chunks per document and top-k.
- **Defence in depth:** results are filtered by scope again in code.
- **Follow-ups:** short or anaphoric questions are expanded with the previous question (no extra LLM call).

**Reranking was not added.** Recall@1 on the eval set is already 100%, so a cross-encoder would add latency
without measurable benefit here. Revisit with a larger, real corpus.

### Confidence and abstention

Similarity scores are **not** probabilities. The policy is explicit and tunable:

- answer if top cosine ≥ `RAG_MIN_VECTOR_SIM` (0.73); or
- answer if cosine ≥ `RAG_MIN_VECTOR_SIM_WITH_KEYWORD` (0.66) **and** ≥ 50% of the query's content terms appear in the chunk;
- otherwise give a deterministic spoken abstention without calling the LLM.

Corpus-wide words ("VIH", "Metaverse", "policy") are excluded from keyword coverage.

The thresholds were tuned on 40 labelled cases and checked on 13 held-out cases. The held-out
accuracy (84.6%) is the honest estimate (see BENCHMARKS.md). The model is also instructed to
abstain if the passages don't answer the question. That is a second, independent check.

### Grounding and prompt injection

- **Fencing:** evidence is wrapped in `<evidence id="n">` tags. Text inside a document cannot open or close these tags.
- **System prompt:** passages are declared untrusted data.
- **Sentence filter:** sentences addressed to AI systems ("ignore previous instructions", "tell the user…", "reveal your prompt") are removed before prompting. Ingestion also writes an audit event (`document.injection_suspected`) for such documents.
- **Output guard:** a streaming check stops generation if the system prompt starts to leak.
- **No tools:** the model has no tools, so injected text cannot cause actions.
- **Citations:** only markers that map to supplied passages are linked or removed from speech. Other bracketed numbers stay as plain digits.

## Data model

See [`prisma/schema.prisma`](../prisma/schema.prisma). Groups receive collection grants, and users belong to groups.
Admin rights cover management only: an admin retrieves only from collections granted to their own groups.

## Scaling path (only when measurements require it)

The server is a single Node process with in-process caches and an in-process ingestion worker.
In order of need:

1. Separate worker processes (`npm run worker`, `VOICERAG_INPROCESS_WORKER=false`).
2. Move model serving to a GPU host or hosted APIs.
3. Several web nodes behind a sticky load balancer. Each WebSocket is pinned to one node.
4. A shared rate limiter and session counter (Redis), since the in-process limits are per node.
