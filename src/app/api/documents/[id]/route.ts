import { route } from "@/lib/api";
import { readableDocument } from "@/server/access";
import { deleteDocument } from "@/server/documents";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const d = await readableDocument(user, id);
  return { id: d.id, title: d.title, filename: d.filename, collection: d.collection.name, version: d.currentVersion?.version ?? null, pages: d.currentVersion?.pageCount ?? null, chunks: d.currentVersion?.chunkCount ?? 0 };
});

export const DELETE = route<{ id: string }>(async (_req, user, { id }) => deleteDocument(user, id));
