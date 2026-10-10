// Consistent API errors: { error: { code, message, details? } } with a matching HTTP status.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { redactString } from "./redact";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Sign in required.") => new ApiError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "You do not have access to this resource.") => new ApiError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found.") => new ApiError(404, "NOT_FOUND", msg);
export const conflict = (msg: string, details?: unknown) => new ApiError(409, "CONFLICT", msg, details);
export const tooMany = (msg = "Too many requests; slow down.") => new ApiError(429, "RATE_LIMITED", msg);

export function toResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid input.", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
      { status: 422 },
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[api] unhandled error:", redactString(msg));
  return NextResponse.json({ error: { code: "INTERNAL", message: "Unexpected server error." } }, { status: 500 });
}
