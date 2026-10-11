import { json, route } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { changeOwnPassword } from "@/server/user-admin";

/** Change your own password. Other sessions are ended; this device gets a fresh session. */
export const POST = route(async (req, user) => {
  rateLimit(`password:${user.id}`, 5, 5);
  await changeOwnPassword(user, await json(req));
  await createSession(user.id);
  return { ok: true };
});
