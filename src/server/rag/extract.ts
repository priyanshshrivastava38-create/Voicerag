// Text extraction that preserves structure for citations:
//  - PDF:  per-page text (real page numbers) + heuristic headings
//  - DOCX: heading hierarchy from Word heading styles (no page numbers: Word pagination is a
//          layout artefact, so DOCX citations reference the section heading instead)
//  - MD:   ATX headings (#, ##, …); TXT: paragraphs, headings only if they look like headings
import type { DocKind } from "./validate";

export interface Block {
  text: string;
  /** Heading trail, e.g. ["Leave Policy", "Annual Leave"]. */
  headings: string[];
  page: number | null;
}

export interface Extracted {
  blocks: Block[];
  pageCount: number | null;
  title: string | null;
}

const MAX_CHARS = 2_000_000;
const MAX_PAGES = 1000;

export async function extract(kind: DocKind, buf: Buffer): Promise<Extracted> {
  const out = kind === "pdf" ? await extractPdf(buf) : kind === "docx" ? await extractDocx(buf) : extractMarkdown(buf.toString("utf8"), kind === "md");
  const total = out.blocks.reduce((n, b) => n + b.text.length, 0);
  if (total === 0) throw new Error("No extractable text (scanned PDFs need OCR, which is not enabled).");
  if (total > MAX_CHARS) throw new Error(`Document text exceeds ${MAX_CHARS} characters.`);
  return out;
}

// --- Markdown / text ---------------------------------------------------------------

export function extractMarkdown(text: string, markdown: boolean): Extracted {
  const blocks: Block[] = [];
  const stack: { level: number; title: string }[] = [];
  let title: string | null = null;
  let para: string[] = [];
  const flush = () => {
    const t = para.join(" ").replace(/\s+/g, " ").trim();
    if (t) blocks.push({ text: t, headings: stack.map((s) => s.title), page: null });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const h = markdown ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush();
      const level = h[1].length;
      const t = stripInlineMd(h[2]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: t });
      if (level === 1 && !title) title = t;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // List items and table rows are their own lines; keep them separated by sentence breaks.
    const item = line.replace(/^\s*([-*+]|\d+[.)])\s+/, "").replace(/^\|(.+)\|$/, "$1").replace(/\s*\|\s*/g, "; ");
    if (/^[-:;\s]+$/.test(item)) continue; // table separator rows
    const cleaned = markdown ? stripInlineMd(item) : item.trim();
    para.push(/[.!?:;]$/.test(cleaned) || item === line.trim() ? cleaned : `${cleaned}.`);
  }
  flush();
  return { blocks, pageCount: null, title };
}

function stripInlineMd(s: string) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .trim();
}

// --- PDF ------------------------------------------------------------------------------

async function extractPdf(buf: Buffer): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > MAX_PAGES) throw new Error(`PDF has ${pdf.numPages} pages; the limit is ${MAX_PAGES}.`);
  const { text: pages } = await extractText(pdf, { mergePages: false });
  const blocks: Block[] = [];
  let heading: string | null = null;
  let title: string | null = null;
  pages.forEach((pageText, i) => {
    let para: string[] = [];
    const flush = () => {
      const t = para.join(" ").replace(/\s+/g, " ").trim();
      if (t) blocks.push({ text: t, headings: heading ? [heading] : [], page: i + 1 });
      para = [];
    };
    for (const raw of pageText.split(/\n/)) {
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      if (looksLikeHeading(line)) {
        flush();
        heading = line.replace(/\s+/g, " ");
        if (!title) title = heading;
        continue;
      }
      para.push(line);
      if (/[.!?]$/.test(line) && para.join(" ").length > 400) flush();
    }
    flush();
  });
  return { blocks, pageCount: pages.length, title };
}

/** Short line, no terminal punctuation, numbered or Title Case → treat as a section heading. */
export function looksLikeHeading(line: string): boolean {
  if (line.length > 80 || line.length < 3 || /[.,;:!?]$/.test(line)) return false;
  if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(line)) return true;
  const words = line.split(/\s+/);
  if (words.length > 10) return false;
  const caps = words.filter((w) => /^[A-Z0-9&]/.test(w) || /^(and|of|the|for|to|in|a|on|&)$/.test(w)).length;
  return caps === words.length && words.some((w) => /^[A-Z][a-z]/.test(w) || /^[A-Z]{2,}$/.test(w));
}

// --- DOCX -----------------------------------------------------------------------------

async function extractDocx(buf: Buffer): Promise<Extracted> {
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  const blocks: Block[] = [];
  const stack: { level: number; title: string }[] = [];
  let title: string | null = null;
  const re = /<(h[1-6]|p|li|td)[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (tag[0] === "h") {
      const level = Number(tag[1]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: text });
      if (level === 1 && !title) title = text;
    } else {
      blocks.push({ text, headings: stack.map((s) => s.title), page: null });
    }
  }
  return { blocks, pageCount: null, title };
}

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
