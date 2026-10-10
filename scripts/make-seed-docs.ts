// Generates the synthetic seed documents in seed/docs in their real formats (MD, TXT, PDF, DOCX)
// so ingestion is exercised through each extractor.   npm run seed:docs
import fs from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { DOCS, type SeedDoc } from "../seed/content";

const OUT = path.resolve("seed/docs");

function markdown(d: SeedDoc) {
  return [`# ${d.title}`, ...d.sections.flatMap((s) => [`## ${s.heading}`, ...s.paragraphs])].join("\n\n") + "\n";
}

function text(d: SeedDoc) {
  return [d.title.toUpperCase(), "", ...d.sections.flatMap((s) => [...s.paragraphs, ""])].join("\n");
}

async function pdf(d: SeedDoc) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const H = 842;
  const M = 56;
  // One page per two sections, so page numbers in citations are meaningful.
  for (let i = 0; i < d.sections.length; i += 2) {
    const page = doc.addPage([W, H]);
    let y = H - M;
    if (i === 0) {
      page.drawText(d.title, { x: M, y, size: 18, font: bold, color: rgb(0.1, 0.1, 0.2) });
      y -= 36;
    }
    for (const s of d.sections.slice(i, i + 2)) {
      page.drawText(s.heading, { x: M, y, size: 13, font: bold });
      y -= 22;
      for (const p of s.paragraphs) {
        const words = p.split(" ");
        let line = "";
        for (const w of words) {
          const next = line ? `${line} ${w}` : w;
          if (font.widthOfTextAtSize(next, 11) > W - 2 * M) {
            page.drawText(line, { x: M, y, size: 11, font });
            y -= 15;
            line = w;
          } else line = next;
        }
        if (line) {
          page.drawText(line, { x: M, y, size: 11, font });
          y -= 15;
        }
        y -= 8;
      }
      y -= 10;
    }
    page.drawText(`Page ${doc.getPageCount()}`, { x: W / 2 - 15, y: 30, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  }
  return Buffer.from(await doc.save());
}

async function docx(d: SeedDoc) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: d.title, heading: HeadingLevel.HEADING_1 }),
          ...d.sections.flatMap((s) => [new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_2 }), ...s.paragraphs.map((p) => new Paragraph({ text: p }))]),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function writeSeedDocs(log = true) {
  await fs.mkdir(OUT, { recursive: true });
  for (const d of DOCS) {
    const ext = path.extname(d.file);
    const data = ext === ".md" ? markdown(d) : ext === ".txt" ? text(d) : ext === ".pdf" ? await pdf(d) : await docx(d);
    await fs.writeFile(path.join(OUT, d.file), data);
    if (log) console.log(`wrote seed/docs/${d.file}`);
  }
}

if (process.argv[1]?.endsWith("make-seed-docs.ts")) void writeSeedDocs();
