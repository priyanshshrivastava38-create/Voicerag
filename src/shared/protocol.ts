// Voice WebSocket protocol, shared by the browser client, the server and the benchmark harness.
//
// One persistent socket per voice session carries:
//   client → server  JSON control messages + binary PCM16LE mono 16 kHz microphone frames
//                    (frames belong to the currently open utterance; only sent while speaking)
//   server → client  JSON events + binary audio frames (AUDIO_HEADER_BYTES header + PCM16LE)
//
// Keeping one socket avoids per-turn connection setup and keeps ordering guarantees, which the
// interruption logic relies on (a `cancel` is always processed before later audio frames).

export const MIC_SAMPLE_RATE = 16000;
export const WS_PATH = "/ws/voice";

export type TurnOutcome = "answered" | "abstained" | "cancelled" | "error" | "timeout";
export type AssistantState = "idle" | "listening" | "transcribing" | "searching" | "thinking" | "speaking";

export interface ClientConfig {
  /** Server-synthesised audio (true) or text only. In "browser" TTS mode the client speaks `speak` events itself. */
  speak: boolean;
  voice?: string;
  rateWpm?: number;
}

export type ClientMsg =
  | { t: "hello"; config: ClientConfig; conversationId?: string | null }
  | { t: "config"; config: ClientConfig }
  | { t: "speech_start"; uttId: string }
  // Silence onset inside an utterance: the server may start a speculative transcription.
  | { t: "pause"; uttId: string }
  | { t: "resume"; uttId: string }
  // End of turn decided by the client VAD. hangoverMs = silence waited before deciding.
  | { t: "speech_end"; uttId: string; speechMs: number; hangoverMs: number }
  | { t: "speech_abort"; uttId: string }
  | { t: "text"; text: string }
  | { t: "cancel"; reason: "barge_in" | "user_stop" }
  // Browser-measured latencies (its own clock): last voiced mic frame / first speech frame → first audio scheduled.
  | { t: "playback_started"; turnId: string; lastVoiceToAudioMs: number | null; speechStartToAudioMs: number | null }
  | { t: "new_conversation" }
  | { t: "ping"; ts: number };

export interface SourceRef {
  marker: number;
  chunkId: string;
  documentId: string;
  title: string;
  collection: string;
  page: number | null;
  heading: string | null;
  excerpt: string;
  score: number;
}

export interface TurnMetricsView {
  eosToTranscriptMs: number | null;
  eosToEvidenceMs: number | null;
  eosToFirstTokenMs: number | null;
  eosToFirstAudioMs: number | null;
  sttMs: number | null;
  retrievalMs: number | null;
  llmTtftMs: number | null;
  ttsFirstChunkMs: number | null;
  totalMs: number | null;
  retrievalCacheHit: boolean | null;
  speculativeHit: boolean | null;
}

export type ServerMsg =
  | { t: "ready"; sessionId: string; conversationId: string | null; providers: Record<string, string>; ttsMode: "server" | "browser" | "none" }
  | { t: "state"; state: AssistantState; turnId?: string }
  | { t: "partial"; uttId: string; text: string }
  | { t: "turn_start"; turnId: string; turnNum: number; mode: "voice" | "text" }
  | { t: "transcript"; turnId: string; text: string }
  | { t: "evidence"; turnId: string; sources: SourceRef[]; abstain: boolean; reason: string }
  | { t: "token"; turnId: string; text: string }
  | { t: "speak"; turnId: string; seq: number; text: string }
  | { t: "answer_done"; turnId: string; text: string; cited: number[]; abstained: boolean; grounding: "documents" | "overview" | "general" | "none"; messageId: string | null; conversationId: string | null }
  | { t: "turn_end"; turnId: string; outcome: TurnOutcome; metrics: TurnMetricsView }
  | { t: "error"; code: string; message: string; turnId?: string; retryable: boolean }
  | { t: "pong"; ts: number };

// Binary audio frame header (server → client):
//   byte 0      : 0x41 ('A')
//   byte 1      : version (1)
//   bytes 2-3   : chunk sequence within the turn (uint16 LE)
//   bytes 4-7   : turn number (uint32 LE) — the client drops audio for stale turns
//   bytes 8-11  : sample rate (uint32 LE)
//   bytes 12-   : PCM16LE mono samples
export const AUDIO_HEADER_BYTES = 12;

export function encodeAudioFrame(turnNum: number, seq: number, sampleRate: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 0x41);
  dv.setUint8(1, 1);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setUint32(4, turnNum >>> 0, true);
  dv.setUint32(8, sampleRate >>> 0, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), AUDIO_HEADER_BYTES);
  return out;
}

export function decodeAudioFrame(buf: ArrayBuffer): { turnNum: number; seq: number; sampleRate: number; pcm: Int16Array } | null {
  if (buf.byteLength < AUDIO_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x41 || dv.getUint8(1) !== 1) return null;
  const len = Math.floor((buf.byteLength - AUDIO_HEADER_BYTES) / 2);
  // Copy so the samples are 2-byte aligned regardless of the source buffer.
  const pcm = new Int16Array(len);
  new Uint8Array(pcm.buffer).set(new Uint8Array(buf, AUDIO_HEADER_BYTES, len * 2));
  return { turnNum: dv.getUint32(4, true), seq: dv.getUint16(2, true), sampleRate: dv.getUint32(8, true), pcm };
}
