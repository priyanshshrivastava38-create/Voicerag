import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { resetPassword } from "@/server/user-admin";

/** Issue a new one-time temporary password and sign the user out everywhere. */
export const POST = route<{ id: string }>(async (_req, user, { id }) => {
  requireAdmin(user);
  rateLimit(`admin-users:${user.id}`, 30, 30);
  return resetPassword(user, id);
});
