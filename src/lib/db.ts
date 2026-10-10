import { PrismaClient } from "@prisma/client";

// One client per process (survives Next.js dev hot reloads).
const g = globalThis as unknown as { __prisma?: PrismaClient };
export const prisma = g.__prisma ?? new PrismaClient({ log: ["error"] });
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;
