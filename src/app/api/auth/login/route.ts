import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, clientIp } from "@/lib/api";
import { toResponse } from "@/lib/errors";
import { login } from "@/server/users";

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req); // login CSRF
    const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    return NextResponse.json(await login(email, password, clientIp(req)));
  } catch (e) {
    return toResponse(e);
  }
}
