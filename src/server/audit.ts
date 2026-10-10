// Audit trail with data minimisation: never pass transcripts, answers or document text here,
// only identifiers and small structured details (which are redacted again before storage).
import { prisma } from "@/lib/db";
import { redact, redactString } from "@/lib/redact";

export async function audit(input: {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}) {
  await prisma.auditEvent.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      details: input.details ? (redact(input.details) as object) : undefined,
    },
  });
}

/** Fire-and-forget variant for hot paths (voice turns): never blocks or throws into the caller. */
export function auditAsync(input: Parameters<typeof audit>[0]) {
  audit(input).catch((e) => console.error("[audit] write failed:", redactString(String(e))));
}
