import { NextRequest, NextResponse } from "next/server";
import { toResponse } from "@/lib/errors";
import { login } from "@/server/users";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
    return NextResponse.json(await login(body.email ?? "", body.password ?? "", req.headers.get("x-forwarded-for") ?? "local"));
  } catch (e) {
    return toResponse(e);
  }
}
