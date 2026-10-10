// Per-turn monotonic timestamps. Marks are stored as absolute performance.now() values and
// reported relative to the anchor (t=0): the end-of-turn decision received by the server (voice)
// or the text message received (text). A speculatively pre-rendered turn is created before the
// end of turn and re-anchored with rebase() when it is released, so work done during the VAD
// hangover shows up as negative marks.
export class TurnClock {
  private originAt: number;
  private marks = new Map<string, number>();

  constructor(origin = performance.now()) {
    this.originAt = origin;
  }

  get origin() {
    return this.originAt;
  }

  rebase(origin = performance.now()) {
    this.originAt = origin;
  }

  /** Record a mark once (first occurrence wins). Returns ms since anchor. */
  mark(name: string, at = performance.now()): number {
    if (!this.marks.has(name)) this.marks.set(name, at);
    return this.marks.get(name)! - this.originAt;
  }

  get(name: string): number | null {
    return this.marks.has(name) ? this.marks.get(name)! - this.originAt : null;
  }

  between(a: string, b: string): number | null {
    const x = this.get(a);
    const y = this.get(b);
    return x === null || y === null ? null : Math.round(y - x);
  }

  since(name: string): number | null {
    const v = this.get(name);
    return v === null ? null : Math.round(v);
  }

  toJSON() {
    return Object.fromEntries([...this.marks].map(([k, v]) => [k, Math.round(v - this.originAt)]));
  }
}
