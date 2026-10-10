// Structure-aware chunking: chunks never straddle a section boundary (so each chunk has one
// heading path for its citation), are packed to ~targetWords, and overlap within a section.
import { sha256 } from "@/lib/crypto";
import type { Block } from "./extract";

export interface ChunkDraft {
  ordinal: number;
  text: string;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  contentHash: string;
}

export function chunkBlocks(blocks: Block[], targetWords: number, overlapWords: number): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  const overlap = Math.min(overlapWords, Math.floor(targetWords / 3));
  // Group consecutive blocks by heading path.
  const sections: { path: string; blocks: Block[] }[] = [];
  for (const b of blocks) {
    const path = b.headings.join(" > ");
    const last = sections[sections.length - 1];
    if (last && last.path === path) last.blocks.push(b);
    else sections.push({ path, blocks: [b] });
  }

  for (const sec of sections) {
    // Sentence units with their page, so long paragraphs split at sentence boundaries.
    const units: { words: string[]; page: number | null }[] = [];
    for (const b of sec.blocks) {
      for (const s of splitSentences(b.text)) units.push({ words: s.split(/\s+/).filter(Boolean), page: b.page });
    }
    let cur: { words: string[]; page: number | null }[] = [];
    let count = 0;
    const emit = () => {
      if (!count) return;
      const text = cur.map((u) => u.words.join(" ")).join(" ");
      const pages = cur.map((u) => u.page).filter((p): p is number => p !== null);
      out.push({
        ordinal: out.length,
        text,
        headingPath: sec.path || null,
        pageStart: pages.length ? Math.min(...pages) : null,
        pageEnd: pages.length ? Math.max(...pages) : null,
        contentHash: sha256(`${sec.path}\n${text}`),
      });
    };
    for (const u of units) {
      if (count > 0 && count + u.words.length > targetWords) {
        emit();
        // Carry trailing sentences (up to `overlap` words) into the next chunk.
        const carry: typeof cur = [];
        let n = 0;
        for (let i = cur.length - 1; i >= 0 && n + cur[i].words.length <= overlap; i--) {
          carry.unshift(cur[i]);
          n += cur[i].words.length;
        }
        cur = carry;
        count = n;
      }
      // A single over-long sentence is hard-split.
      if (u.words.length > targetWords * 1.5) {
        for (let i = 0; i < u.words.length; i += targetWords) {
          cur.push({ words: u.words.slice(i, i + targetWords), page: u.page });
          count += Math.min(targetWords, u.words.length - i);
          if (count >= targetWords) {
            emit();
            cur = [];
            count = 0;
          }
        }
        continue;
      }
      cur.push(u);
      count += u.words.length;
    }
    emit();
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Text that is embedded for a chunk: document title and section give the vector context. */
export function embeddingText(title: string, c: { headingPath: string | null; text: string }) {
  return `${title}${c.headingPath ? ` — ${c.headingPath}` : ""}\n${c.text}`;
}
