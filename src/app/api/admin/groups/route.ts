import { json, route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { createGroup, listGroups } from "@/server/user-admin";

export const GET = route(async (_req, user) => {
  requireAdmin(user);
  return { groups: await listGroups() };
});

export const POST = route(async (req, user) => {
  requireAdmin(user);
  return createGroup(user, await json(req));
});
