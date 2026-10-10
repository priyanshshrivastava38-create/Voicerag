// Liveness: the process is up and serving HTTP.
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ ok: true });
}
