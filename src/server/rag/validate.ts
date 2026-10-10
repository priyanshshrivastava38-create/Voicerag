// Upload validation. The file type is decided from the extension AND verified against the
// content's magic bytes; the client-supplied MIME type is ignored.
import { badRequest } from "@/lib/errors";

export type DocKind = "pdf" | "docx" | "txt" | "md";

export const MIME: Record<DocKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

export function kindFromFilename(name: string): DocKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document";
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 160) || "document";
}

export function validateUpload(filename: string, buf: Buffer, maxBytes: number): DocKind {
  const kind = kindFromFilename(filename);
  if (!kind) throw badRequest("Unsupported file type. Allowed: PDF, DOCX, TXT, Markdown.");
  if (buf.length === 0) throw badRequest("The file is empty.");
  if (buf.length > maxBytes) throw badRequest(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  if (kind === "pdf" && buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw badRequest("File content is not a PDF.");
  if (kind === "docx") {
    if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) throw badRequest("File content is not a DOCX (zip) document.");
    if (!buf.includes(Buffer.from("word/document.xml"))) throw badRequest("ZIP archive is not a Word document.");
  }
  if (kind === "txt" || kind === "md") {
    if (buf.includes(0)) throw badRequest("Text file contains binary data.");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw badRequest("Text files must be UTF-8 encoded.");
    }
  }
  return kind;
}
