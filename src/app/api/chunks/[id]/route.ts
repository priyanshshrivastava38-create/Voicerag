// Source viewer for a citation: returns the cited passage only if the caller may read it.
import { route } from "@/lib/api";
import { readableChunk } from "@/server/access";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const c = await readableChunk(user, id);
  const d = c.version.document;
  return {
    id: c.id,
    text: c.text,
    heading: c.headingPath,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    current: c.active,
    document: { id: d.id, title: d.title, filename: d.filename, collection: d.collection.name, version: c.version.version },
  };
});
