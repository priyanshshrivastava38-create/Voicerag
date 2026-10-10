import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { metricsSummary } from "@/server/metrics";

export const GET = route(async (req, user) => {
  requireAdmin(user);
  const sp = req.nextUrl.searchParams;
  const source = ["live", "benchmark", "synthetic-load"].includes(sp.get("source") ?? "") ? sp.get("source")! : "live";
  const hours = Math.min(24 * 30, Math.max(1, Number(sp.get("hours")) || 24));
  return metricsSummary({ source, hours });
});
