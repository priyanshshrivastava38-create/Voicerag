import { route } from "@/lib/api";
import { reindexDocument } from "@/server/documents";

export const POST = route<{ id: string }>(async (_req, user, { id }) => reindexDocument(user, id));
