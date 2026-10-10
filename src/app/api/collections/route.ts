import { route } from "@/lib/api";
import { listCollections } from "@/server/documents";

export const GET = route(async (_req, user) => ({ collections: await listCollections(user) }));
