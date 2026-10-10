// Readiness: DB reachable, providers healthy and warm. Details only for admins.
import { currentUser } from "@/lib/auth";
import { readiness } from "@/server/health";

export const dynamic = "force-dynamic";
export async function GET() {
  const r = await readiness();
  const user = await currentUser().catch(() => null);
  const body = user?.role === "ADMIN" ? r : { ready: r.ready };
  return Response.json(body, { status: r.ready ? 200 : 503 });
}
