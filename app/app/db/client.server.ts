import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __caratPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Reuse a single client across dev hot-reloads so we don't exhaust Postgres
// connections; a fresh client per module load is fine in production, where
// the module graph is only ever loaded once.
export const prisma: PrismaClient = global.__caratPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__caratPrisma = prisma;
}
