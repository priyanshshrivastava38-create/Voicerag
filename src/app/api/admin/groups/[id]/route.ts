import { json, route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { deleteGroup, updateGroup } from "@/server/user-admin";

export const PATCH = route<{ id: string }>(async (req, user, { id }) => {
  requireAdmin(user);
  return updateGroup(user, id, await json(req));
});

export const DELETE = route<{ id: string }>(async (_req, user, { id }) => {
  requireAdmin(user);
  return deleteGroup(user, id);
});
