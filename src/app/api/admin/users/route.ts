import { json, route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { createUser, listUsers } from "@/server/user-admin";

export const GET = route(async (_req, user) => {
  requireAdmin(user);
  return { users: await listUsers() };
});

/** Create an account. The response carries the one-time temporary password (shown once). */
export const POST = route(async (req, user) => {
  requireAdmin(user);
  rateLimit(`admin-users:${user.id}`, 30, 30);
  return createUser(user, await json(req));
});
