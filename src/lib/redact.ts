// Strip secrets and connection strings before anything is logged or audited.
const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|ca[_-]?cert/i;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return "[truncated]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? (v ? "[redacted]" : v) : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function redactString(s: string): string {
  return s
    .replace(/(postgres(?:ql)?:\/\/)([^:@/\s]+):([^@\s]+)@/gi, "$1$2:[redacted]@")
    .replace(/(password|pwd)=([^&\s;]+)/gi, "$1=[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    .replace(/(Bearer|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "$1 [redacted]");
}
