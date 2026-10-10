// Energy-based voice activity / end-of-turn detector with an adaptive noise floor.
// Pure and clock-free (driven by frame durations) so it is unit-testable and runs on the
// browser main thread with negligible cost. Emits:
//   start  – speech began (after minSpeechMs of voiced frames; includes pre-roll)
//   pause  – silence onset inside speech (pauseMs): the server may transcribe speculatively
//   resume – speech continued after a pause
//   end    – end of turn (hangoverMs of continuous silence)
// A neural VAD (e.g. Silero) is a drop-in upgrade if noisy environments demand it.

export interface VadOptions {
  /** Voiced if rms > max(absMinRms, noiseFloor * ratio). */
  ratio: number;
  absMinRms: number;
  minSpeechMs: number;
  pauseMs: number;
  hangoverMs: number;
  /** Utterances shorter than this (voiced time) are discarded as noise. */
  minUtteranceMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  ratio: 3,
  absMinRms: 0.012,
  minSpeechMs: 90,
  pauseMs: 150,
  hangoverMs: 550,
  minUtteranceMs: 250,
};

export type VadEvent =
  | { type: "start"; preRollMs: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "end"; speechMs: number; hangoverMs: number }
  | { type: "abort" };

export class EnergyVad {
  private noiseFloor = 0.005;
  private inSpeech = false;
  private voicedRun = 0;
  private silenceRun = 0;
  private voicedTotal = 0;
  private paused = false;
  /** Multiplier applied while the assistant is speaking, to resist echo-triggered barge-in. */
  sensitivityScale = 1;

  constructor(public opts: VadOptions = DEFAULT_VAD) {}

  get speaking() {
    return this.inSpeech;
  }

  reset() {
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silenceRun = 0;
    this.voicedTotal = 0;
    this.paused = false;
  }

  threshold() {
    return Math.max(this.opts.absMinRms, this.noiseFloor * this.opts.ratio) * this.sensitivityScale;
  }

  /** Feed one frame's RMS (0..1) and its duration. Returns the events it triggers. */
  process(rms: number, frameMs: number): VadEvent[] {
    const ev: VadEvent[] = [];
    const voiced = rms > this.threshold();
    if (!voiced && !this.inSpeech && this.sensitivityScale === 1) {
      // Track the noise floor only from non-speech frames (slow rise, fast fall), and never while
      // the assistant is audible — its echo is not ambient noise and would deafen the VAD.
      const a = rms > this.noiseFloor ? 0.02 : 0.2;
      this.noiseFloor = Math.max(0.0005, this.noiseFloor + a * (rms - this.noiseFloor));
    }

    if (!this.inSpeech) {
      this.voicedRun = voiced ? this.voicedRun + frameMs : 0;
      if (this.voicedRun >= this.opts.minSpeechMs) {
        this.inSpeech = true;
        this.voicedTotal = this.voicedRun;
        this.silenceRun = 0;
        this.paused = false;
        ev.push({ type: "start", preRollMs: this.voicedRun });
      }
      return ev;
    }

    if (voiced) {
      this.voicedTotal += frameMs;
      if (this.paused) ev.push({ type: "resume" });
      this.paused = false;
      this.silenceRun = 0;
      return ev;
    }

    this.silenceRun += frameMs;
    if (!this.paused && this.silenceRun >= this.opts.pauseMs) {
      this.paused = true;
      ev.push({ type: "pause" });
    }
    if (this.silenceRun >= this.opts.hangoverMs) {
      const speechMs = this.voicedTotal;
      const hangoverMs = this.silenceRun;
      this.reset();
      ev.push(speechMs >= this.opts.minUtteranceMs ? { type: "end", speechMs, hangoverMs } : { type: "abort" });
    }
    return ev;
  }
}

export function rmsOf(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0;
  const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
  let s = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] * scale;
    s += x * x;
  }
  return Math.sqrt(s / samples.length);
}
