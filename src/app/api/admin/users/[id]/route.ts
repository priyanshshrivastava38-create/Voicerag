import { json, route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { updateUser } from "@/server/user-admin";

export const PATCH = route<{ id: string }>(async (req, user, { id }) => {
  requireAdmin(user);
  return updateUser(user, id, await json(req));
});
