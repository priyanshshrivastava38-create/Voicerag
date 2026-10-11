// One conversational turn: retrieval → (abstain | streaming LLM) → sentence segmentation →
// incremental TTS → audio frames, all cancellable through a single AbortSignal.
//
// LLM generation and TTS run concurrently: the TTS consumer synthesises segment N while the LLM
// is still producing segment N+1, and audio for a segment is forwarded chunk-by-chunk as the
// TTS provider streams it. Nothing on this path waits for persistence or analytics.
import { env } from "@/lib/env";
import { encodeAudioFrame, type ServerMsg, type SourceRef, type TurnOutcome } from "@/shared/protocol";
import type { Scope } from "../access";
import type { Providers } from "../providers/registry";
import { type ChatMessage, type LlmEvent, ProviderError, isAbort } from "../providers/types";
import { citedMarkers, speakable, tidyAnswer, verifyBorderlineAnswer } from "../rag/citations";
import { GENERAL_PREFIX, GENERAL_SYSTEM_PROMPT, NO_ACCESS_TEXT, SYSTEM_PROMPT, abstainText, buildMessages, isAbstention, leaksSystemPrompt, looksLikeQuestion, notAQuestionText, resolveMixedAbstention, smallTalkKind, smallTalkReply } from "../rag/prompt";
import { looksInternal, topicIntent, topicOverview } from "../rag/intents";
import type { RetrievalResult } from "../rag/retrieve";
import { TurnClock } from "./clock";
import { SpeechSegmenter } from "./segmenter";

export interface TurnInput {
  turnId: string;
  turnNum: number;
  mode: "voice" | "text";
  question: string;
  retrievalQuery: string;
  scope: Scope;
  history: ChatMessage[];
  speak: boolean;
  tts: { voice?: string; rateWpm?: number };
  clock: TurnClock;
  /** Retrieval already started speculatively for exactly this query + scope (validated by caller). */
  speculativeRetrieval?: Promise<RetrievalResult> | null;
  /** Generation already started speculatively for exactly this question, evidence and history. */
  speculativeLlm?: { events: AsyncIterable<LlmEvent>; startedAt: number } | null;
  signal: AbortSignal;
}

export interface TurnDeps {
  providers: Providers;
  retrieve: (scope: Scope, query: string, signal: AbortSignal) => Promise<RetrievalResult>;
  emit: (msg: ServerMsg) => void;
  sendAudio: (frame: Uint8Array) => void;
}

export interface TurnResult {
  outcome: TurnOutcome;
  errorCode: string | null;
  answer: string;
  cited: number[];
  sources: SourceRef[];
  abstained: boolean;
  retrieval: RetrievalResult | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  speculativeHit: boolean;
  speculativeLlm: boolean;
  /** Where the answer came from: VIH documents, a topic overview, general knowledge, or none. */
  grounding: "documents" | "overview" | "general" | "none";
}

class OutputGuardError extends Error {}

export function llmRequestFor(question: string, evidence: RetrievalResult["evidence"], history: ChatMessage[]) {
  return { system: SYSTEM_PROMPT, messages: buildMessages(question, evidence, history), maxTokens: env.llmMaxTokens, temperature: env.llmTemperature };
}

export function toSourceRefs(r: RetrievalResult): SourceRef[] {
  return r.evidence.map((e, i) => ({
    marker: i + 1,
    chunkId: e.chunkId,
    documentId: e.documentId,
    title: e.title,
    collection: e.collection,
    page: e.pageStart,
    heading: e.headingPath,
    excerpt: e.text.length > 320 ? `${e.text.slice(0, 317)}…` : e.text,
    score: Math.round(e.sim * 1000) / 1000,
  }));
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const { emit, providers } = deps;
  const { clock, signal, turnId } = input;
  const result: TurnResult = { outcome: "answered", errorCode: null, answer: "", cited: [], sources: [], abstained: false, retrieval: null, usage: null, speculativeHit: false, speculativeLlm: false, grounding: "none" };

  // ---- speech output pipeline (consumer) -------------------------------------------
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let producerDone = false;
  let seq = 0;
  let audioSeq = 0;
  const speakOn = input.speak;
  const tts = providers.tts;

  const consumer = (async () => {
    for (;;) {
      if (signal.aborted) return;
      const seg = queue.shift();
      if (seg === undefined) {
        if (producerDone) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      const text = speakable(seg, result.sources.length);
      if (!text) continue;
      if (!speakOn) continue;
      emit({ t: "speak", turnId, seq: seq++, text });
      if (!tts) {
        clock.mark("speakSent");
        continue; // browser TTS: the client synthesises and reports playback start
      }
      clock.mark("ttsStart");
      try {
        for await (const pcm of tts.synthesize(text, input.tts, signal)) {
          if (signal.aborted) return;
          if (clock.get("firstAudio") === null) {
            clock.mark("firstAudio");
            emit({ t: "state", state: "speaking", turnId });
          }
          deps.sendAudio(encodeAudioFrame(input.turnNum, audioSeq++, tts.sampleRate, pcm));
        }
      } catch (e) {
        if (isAbort(e) || signal.aborted) return;
        // A TTS failure must not lose the answer: the transcript is already on screen.
        emit({ t: "error", code: "TTS_FAILED", message: "Speech output failed; the answer is shown as text.", turnId, retryable: true });
        clock.mark("ttsError");
        return;
      }
    }
  })();
  const enqueue = (segs: string[]) => {
    if (!segs.length) return;
    queue.push(...segs);
    wake?.();
  };
  const finishProducer = () => {
    producerDone = true;
    wake?.();
  };

  /** Speak a fixed reply (no LLM). */
  const speakCanned = async (text: string) => {
    result.answer += text;
    clock.mark("firstToken");
    emit({ t: "token", turnId, text });
    const seg = new SpeechSegmenter();
    enqueue([...seg.push(text), ...seg.flush()]);
  };

  /** Stream an LLM reply into tokens + speech, with one bounded retry before the first token. */
  /** `buffered`: collect the reply without emitting tokens or speech (it is verified first). */
  const streamLlm = async (req: ReturnType<typeof llmRequestFor>, allowSpeculative: boolean, buffered = false) => {
    const segmenter = new SpeechSegmenter();
    let attempt = 0;
    for (;;) {
      const spec = allowSpeculative && attempt === 0 && input.speculativeLlm ? input.speculativeLlm : null;
      if (spec) clock.mark("llmStart", spec.startedAt);
      else clock.mark(attempt === 0 ? "llmStart" : "llmRetryStart");
      result.speculativeLlm = !!spec;
      let gotToken = false;
      try {
        for await (const ev of (spec ? spec.events : providers.llm.stream(req, signal)) as AsyncIterable<LlmEvent>) {
          signal.throwIfAborted();
          if (ev.type === "usage") {
            result.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
            continue;
          }
          if (!gotToken) {
            gotToken = true;
            clock.mark("firstToken");
          }
          result.answer += ev.text;
          if (leaksSystemPrompt(result.answer)) throw new OutputGuardError();
          if (buffered) continue;
          emit({ t: "token", turnId, text: ev.text });
          enqueue(segmenter.push(ev.text));
        }
        break;
      } catch (e) {
        // One bounded retry, only if nothing was streamed yet and the error is transient (a failed
        // speculative stream is always retried live).
        if (!gotToken && !signal.aborted && attempt === 0 && (spec || (e instanceof ProviderError && e.retryable))) {
          attempt++;
          continue;
        }
        throw e;
      }
    }
    if (!buffered) enqueue(segmenter.flush());
    clock.mark("llmDone");
  };

  const done = async () => {
    finishProducer();
    await consumer;
    signal.throwIfAborted();
    return finish();
  };

  try {
    // ---- pure small talk ("thanks a lot", "bye-bye") --------------------------------------
    // Checked on the raw utterance BEFORE retrieval: in a conversation, short follow-ups are merged
    // with the previous question for retrieval, which would turn "thanks a lot" into a search.
    // Only whole-utterance pleasantries match; "help me find the leave policy" is a real question.
    const pleasantry = smallTalkKind(input.question);
    if (pleasantry && pleasantry !== "help") {
      clock.mark("evidence");
      emit({ t: "evidence", turnId, sources: [], abstain: false, reason: "small_talk" });
      await speakCanned(smallTalkReply(pleasantry, input.scope.collectionNames ?? []));
      result.grounding = "overview";
      return await done();
    }

    // ---- topic overview ("what can you do for engineering?") --------------------------
    const topic = topicIntent(input.question);
    if (topic.isTopic && input.scope.collectionIds.length) {
      clock.mark("evidence");
      emit({ t: "evidence", turnId, sources: [], abstain: false, reason: "topic_overview" });
      await speakCanned(await topicOverview(input.scope, topic.slug));
      result.grounding = "overview";
      return await done();
    }

    // ---- retrieval ------------------------------------------------------------------
    emit({ t: "state", state: "searching", turnId });
    clock.mark("retrievalStart");
    let retrieval: RetrievalResult;
    if (input.speculativeRetrieval) {
      retrieval = await input.speculativeRetrieval;
      result.speculativeHit = true;
    } else {
      retrieval = await deps.retrieve(input.scope, input.retrievalQuery, signal);
    }
    signal.throwIfAborted();
    clock.mark("evidence");
    result.retrieval = retrieval;
    result.sources = toSourceRefs(retrieval);
    emit({ t: "evidence", turnId, sources: result.sources, abstain: retrieval.abstain, reason: retrieval.reason });

    // ---- no usable evidence ------------------------------------------------------------
    if (retrieval.abstain) {
      const names = input.scope.collectionNames ?? [];
      if (retrieval.reason === "no_authorized_collections") {
        await speakCanned(NO_ACCESS_TEXT);
        result.abstained = true;
        result.outcome = "abstained";
        return await done();
      }
      const smallTalk = smallTalkKind(input.question);
      if (smallTalk) {
        await speakCanned(smallTalkReply(smallTalk, names));
        result.grounding = "overview";
        return await done();
      }
      // General (non-VIH) questions may get clearly-labelled general guidance; anything that
      // looks like VIH-internal information is never answered from model memory.
      // Not a question at all (a remark, or speech picked up from the room): ask again rather than
      // answering "not in the knowledge base" or improvising general guidance.
      if (!looksLikeQuestion(input.question)) {
        await speakCanned(notAQuestionText(names));
        result.grounding = "overview";
        return await done();
      }
      if (env.generalAnswers && !looksInternal(input.question)) {
        emit({ t: "state", state: "thinking", turnId });
        result.grounding = "general";
        await speakCanned(GENERAL_PREFIX);
        await streamLlm({ system: GENERAL_SYSTEM_PROMPT, messages: [...input.history.slice(-4), { role: "user", content: input.question }], maxTokens: Math.max(env.llmMaxTokens, 240), temperature: 0.3 }, false);
        result.answer = tidyAnswer(result.answer);
        const general = result.answer.slice(GENERAL_PREFIX.length);
        // An empty or one-word reply is as unhelpful as an abstention.
        if (isAbstention(general) || (general.match(/[A-Za-z]{2,}/g) ?? []).length < 3) {
          // Don't show "here's general guidance. I don't have enough information…" — the final
          // text (answer_done) replaces the streamed tokens with a single, consistent abstention.
          result.answer = abstainText(names);
          result.abstained = true;
          result.outcome = "abstained";
          result.grounding = "none";
        }
        return await done();
      }
      await speakCanned(abstainText(names));
      result.abstained = true;
      result.outcome = "abstained";
      return await done();
    }

    // ---- grounded generation from VIH documents ----------------------------------------
    emit({ t: "state", state: "thinking", turnId });
    result.grounding = "documents";
    if (retrieval.reason === "borderline") {
      // Borderline evidence: generate in full, verify against the passages, then speak. Slower
      // to first audio than streaming, but a wrong policy answer costs more than a short wait.
      await streamLlm(llmRequestFor(input.question, retrieval.evidence, input.history), false, true);
      const passages = new Map(retrieval.evidence.map((e, i) => [i + 1, e.text]));
      const draft = resolveMixedAbstention(result.answer).text;
      const verified = !isAbstention(draft) && verifyBorderlineAnswer(draft, passages);
      result.answer = "";
      await speakCanned(verified ? draft : abstainText(input.scope.collectionNames ?? []));
      if (!verified) clock.mark("borderlineRejected");
    } else {
      await streamLlm(llmRequestFor(input.question, retrieval.evidence, input.history), true);
    }
    finishProducer();
    await consumer;
    signal.throwIfAborted();
    // Small models occasionally give a cited fact AND "I don't have enough information".
    const mixed = resolveMixedAbstention(result.answer);
    if (mixed.changed) result.answer = mixed.text;
    result.abstained = isAbstention(result.answer);
    if (result.abstained) {
      // Replace the model's wording ("I don't have enough information… [1]") with the standard
      // abstention, which drops stray citation markers and tells the user what they can ask about.
      result.answer = abstainText(input.scope.collectionNames ?? []);
      result.outcome = "abstained";
      result.grounding = "none";
    }
    return finish();
  } catch (e) {
    if (e instanceof OutputGuardError) {
      // Stop generation and speech; replace the answer with a safe refusal.
      queue.length = 0;
      finishProducer();
      await consumer.catch(() => undefined);
      result.answer = "I can't help with that request.";
      result.abstained = true;
      result.outcome = "abstained";
      result.errorCode = "OUTPUT_GUARD";
      clock.mark("outputGuard");
      emit({ t: "error", code: "OUTPUT_GUARD", message: "The response was withheld by a safety check.", turnId, retryable: false });
      return finish();
    }
    finishProducer();
    await consumer.catch(() => undefined);
    if (signal.aborted || isAbort(e)) {
      const timedOut = e instanceof ProviderError && e.code === "TIMEOUT";
      result.outcome = timedOut && !signal.aborted ? "timeout" : "cancelled";
      clock.mark(result.outcome === "cancelled" ? "cancelled" : "timeout");
      if (result.outcome === "timeout") emit({ t: "error", code: "TIMEOUT", message: "The assistant took too long to respond. Please try again.", turnId, retryable: true });
      return finish();
    }
    result.outcome = e instanceof ProviderError && e.code === "TIMEOUT" ? "timeout" : "error";
    result.errorCode = e instanceof ProviderError ? `${e.provider}:${e.code}` : "INTERNAL";
    clock.mark("error");
    emit({
      t: "error",
      code: result.outcome === "timeout" ? "TIMEOUT" : "GENERATION_FAILED",
      message: result.outcome === "timeout" ? "The assistant took too long to respond. Please try again." : "The assistant could not generate an answer. Please try again.",
      turnId,
      retryable: true,
    });
    return finish();
  }

  function finish(): TurnResult {
    clock.mark("end");
    result.cited = citedMarkers(result.answer, result.sources.length);
    return result;
  }
}
