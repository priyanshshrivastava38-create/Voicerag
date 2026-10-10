import { route } from "@/lib/api";
import { listCollections } from "@/server/documents";
import { describeProviders } from "@/server/providers/registry";

export const GET = route(async (_req, user) => ({
  user,
  collections: (await listCollections(user)).filter((c) => c.searchable).map((c) => ({ id: c.id, name: c.name })),
  providers: describeProviders(),
}));
