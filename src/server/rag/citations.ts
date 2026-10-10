// Citation markers in model output: [1], [1][2], [1, 3], [1-2]. Only markers that refer to an
// evidence passage actually supplied for this turn are kept; anything else is dropped, so the UI
// can never show a source the model invented.

export function citedMarkers(text: string, evidenceCount: number): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g)) {
    for (const part of m[1].split(",")) {
      const range = part.split(/[-–]/).map((x) => Number(x.trim()));
      const [a, b] = [range[0], range[1] ?? range[0]];
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 20; n++) if (n >= 1 && n <= evidenceCount) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Remove citation markers and markdown so text sounds natural when spoken. Only brackets that
 * refer to a supplied passage are markers; any other bracketed number (small models sometimes
 * write "[22] days") keeps its digits so the spoken answer never loses a figure.
 */
export function speakable(text: string, evidenceCount = 99): string {
  return text
    .replace(/\s*\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g, (m, inner: string) => (inner.split(/[-,–]/).every((n) => Number(n) >= 1 && Number(n) <= evidenceCount) ? "" : ` ${inner}`))
    .replace(/\[(?:\d|\s|,)*$/g, "") // dangling partial marker at a chunk boundary
    .replace(/[-=_]{3,}/g, " ") // markdown rules / heading underlines
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tidy free-form (general-guidance) answers from small models: drop markdown heading underlines
 * and rules, and if generation stopped mid-sentence (length limit), end at the last full sentence.
 */
export function tidyAnswer(text: string): string {
  let t = text.replace(/^\s*[-=_]{3,}\s*$/gm, "").replace(/\s[-=_]{3,}\s/g, " ").replace(/^#+\s*/gm, "").replace(/\n{2,}/g, "\n").trim();
  if (!/[.!?:)\]]$/.test(t)) {
    const cut = Math.max(t.lastIndexOf(". "), t.lastIndexOf(".\n"), t.lastIndexOf("? "), t.lastIndexOf("! "));
    if (cut > t.length * 0.5) t = t.slice(0, cut + 1);
  }
  return t;
}

/**
 * Verification for answers generated from BORDERLINE evidence (a plausible but not clearly strong
 * match), where a small model is most likely to misapply or invent. Accept only an answer that
 * cites a supplied passage, whose every sentence is lexically supported by the passages it cites,
 * and whose every number appears in those passages. Anything else is replaced by an abstention.
 */
export function verifyBorderlineAnswer(answer: string, passages: Map<number, string>): boolean {
  const cited = citedMarkers(answer, passages.size);
  if (!cited.length) return false;
  if (supportedSentenceRatio(answer, passages) < 1) return false;
  const source = cited.map((m) => passages.get(m) ?? "").join(" ").replace(/,(?=\d{3})/g, "");
  const numbers = speakable(answer, passages.size).replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
  return numbers.every((n) => new RegExp(`(^|\\D)${n.replace(".", "\\.")}(\\D|$)`).test(source));
}

/**
 * Lexical support check used by the RAG eval and the borderline gate: fraction of answer sentences
 * whose content words are mostly present in the passages they cite. A heuristic, reported as such.
 */
export function supportedSentenceRatio(answer: string, passages: Map<number, string>): number {
  // Attach markers written after the full stop ("… days. [1]") to the sentence they follow.
  const normalized = answer.replace(/([.!?])((?:\s*\[\d+(?:\s*[-,–]\s*\d+)*\])+)/g, "$2$1");
  const sentences = normalized.split(/(?<=[.!?])\s+/).filter((s) => /\w{3,}/.test(s));
  if (!sentences.length) return 0;
  let ok = 0;
  for (const s of sentences) {
    const markers = citedMarkers(s, 99);
    const src = markers.map((m) => passages.get(m) ?? "").join(" ").toLowerCase();
    if (!src) continue;
    const words = (speakable(s).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !COMMON.has(w));
    if (!words.length) {
      ok++;
      continue;
    }
    const hit = words.filter((w) => src.includes(w.replace(/s$/, ""))).length / words.length;
    if (hit >= 0.6) ok++;
  }
  return ok / sentences.length;
}

const COMMON = new Set("that this with have from your they will would there their about which when what into also only than then just more most some such each other according knowledge base based documents document evidence passage".split(" "));
