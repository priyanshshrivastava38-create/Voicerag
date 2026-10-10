// Splits a token stream into speakable segments for incremental TTS.
// The FIRST segment is released early at a clause boundary (comma/semicolon/colon/dash) once it
// has a few words, because time-to-first-audio is dominated by waiting for text; later segments
// are whole sentences, which synthesise with more natural prosody.

export interface SegmenterOptions {
  firstMinWords: number;
  firstMaxWords: number;
  maxWords: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = { firstMinWords: 3, firstMaxWords: 12, maxWords: 40 };

const ABBREV = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|inc|ltd|no|approx|dept)\.$/i;

export class SpeechSegmenter {
  private buf = "";
  private emitted = 0;
  constructor(private opts: SegmenterOptions = DEFAULT_SEGMENTER) {}

  /** Feed raw model text; returns zero or more segments ready to synthesise. */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const seg = this.next(false);
      if (!seg) break;
      out.push(seg);
    }
    return out;
  }

  /** End of stream: whatever remains. */
  flush(): string[] {
    const seg = this.next(true);
    return seg ? [seg] : [];
  }

  private next(final: boolean): string | null {
    const s = this.buf;
    if (!s.trim()) return null;
    const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
    const first = this.emitted === 0;

    // Sentence end: punctuation (optionally followed by a citation marker / quote) then space.
    const re = /[.!?](?:\s*\[\d+(?:\s*[-,–]\s*\d+)*\])*["')\]]?(?=\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const end = m.index + m[0].length;
      const candidate = s.slice(0, end);
      if (ABBREV.test(s.slice(0, m.index + 1))) continue;
      if (/\d\.$/.test(s.slice(0, m.index + 1)) && /^\d/.test(s.slice(m.index + 1))) continue; // 3.5
      if (words(candidate) >= 2 || final) return this.take(end);
    }
    if (first) {
      const clause = /[,;:—–](?=\s)/g;
      while ((m = clause.exec(s))) {
        const end = m.index + 1;
        const n = words(s.slice(0, end));
        if (n >= this.opts.firstMinWords && n <= this.opts.firstMaxWords) return this.take(end);
      }
    }
    // Run-on text without punctuation: cut at a word boundary.
    const limit = first ? this.opts.firstMaxWords : this.opts.maxWords;
    const ws = s.trim().split(/\s+/);
    if (ws.length > limit) {
      const cut = ws.slice(0, limit).join(" ");
      const idx = s.indexOf(cut) + cut.length;
      return this.take(idx);
    }
    if (final) return this.take(s.length);
    return null;
  }

  private take(end: number): string | null {
    const seg = this.buf.slice(0, end).trim();
    this.buf = this.buf.slice(end);
    if (!seg) return null;
    this.emitted++;
    return seg;
  }
}
