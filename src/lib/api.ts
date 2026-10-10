// Route-handler wrapper: authentication, consistent errors, same-origin check for mutations.
import { NextRequest, NextResponse } from "next/server";
import { type AuthUser, requireUser } from "./auth";
import { ApiError, forbidden, toResponse } from "./errors";

/** Routes usable while a user still has an admin-issued temporary password. */
const PASSWORD_FLOW = new Set(["/api/auth/password", "/api/auth/logout", "/api/me"]);

type Ctx<P> = { params: Promise<P> };

export function route<P = Record<string, string>>(
  handler: (req: NextRequest, user: AuthUser, params: P) => Promise<unknown>,
) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const user = await requireUser();
      if (user.mustChangePassword && !PASSWORD_FLOW.has(req.nextUrl.pathname)) {
        throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Choose a new password before continuing.");
      }
      const result = await handler(req, user, await ctx.params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (e) {
      return toResponse(e);
    }
  };
}

/** Header set by server.ts from the socket address (or a trusted proxy); never taken from the client. */
export const CLIENT_IP_HEADER = "x-voicerag-client-ip";

/** Client IP for rate limiting. Only the custom server can set this header (it strips client copies). */
export function clientIp(req: NextRequest) {
  return req.headers.get(CLIENT_IP_HEADER) ?? "unknown";
}

/** CSRF defence in depth (cookies are SameSite=Lax): mutations must come from our own origin. */
export function assertSameOrigin(req: NextRequest) {
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
