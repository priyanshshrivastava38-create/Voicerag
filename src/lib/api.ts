// Route-handler wrapper: authentication, consistent errors, same-origin check for mutations.
import { NextRequest, NextResponse } from "next/server";
import { type AuthUser, requireUser } from "./auth";
import { forbidden, toResponse } from "./errors";

type Ctx<P> = { params: Promise<P> };

export function route<P = Record<string, string>>(
  handler: (req: NextRequest, user: AuthUser, params: P) => Promise<unknown>,
) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const user = await requireUser();
      const result = await handler(req, user, await ctx.params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (e) {
      return toResponse(e);
    }
  };
}

/** CSRF defence in depth (cookies are SameSite=Lax): mutations must come from our own origin. */
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients (curl, tests) do not send Origin
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw forbidden("Cross-origin request rejected.");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cross-origin")) throw e;
    throw forbidden("Cross-origin request rejected.");
  }
}

export async function json<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function pageParams(req: NextRequest, maxSize = 200) {
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(sp.get("pageSize")) || 50));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, q: (sp.get("q") ?? "").trim().slice(0, 200) };
}
