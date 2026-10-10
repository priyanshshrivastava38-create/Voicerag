// Streaming PCM playback with gapless scheduling and instant stop (barge-in).
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private gain: GainNode | null = null;
  onIdle: (() => void) | null = null;

  /** Must be called from a user gesture (autoplay policy). */
  async init() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get playing() {
    return this.sources.size > 0;
  }

  /**
   * Schedule PCM16 for playback. Returns the performance.now() timestamp at which this chunk
   * becomes audible (includes the device output latency where the browser reports it).
   */
  enqueue(pcm: Int16Array, sampleRate: number): number {
    const ctx = this.ctx;
    if (!ctx || !this.gain || pcm.length === 0) return performance.now();
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    // Small lead (15 ms) on the first chunk so scheduling jitter doesn't clip the start.
    const startAt = Math.max(this.nextAt, ctx.currentTime + 0.015);
    src.start(startAt);
    this.nextAt = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.onIdle?.();
    };
    const outLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? ctx.baseLatency ?? 0;
    return performance.now() + (startAt - ctx.currentTime + outLatency) * 1000;
  }

  /** Stop immediately and drop everything scheduled. */
  stop() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources.clear();
    this.nextAt = 0;
  }

  async close() {
    this.stop();
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
