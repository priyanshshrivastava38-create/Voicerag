import { route } from "@/lib/api";
import { logout } from "@/server/users";

export const POST = route(async () => {
  await logout();
  return { ok: true };
});
