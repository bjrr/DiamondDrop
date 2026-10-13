import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __caratPrisma: PrismaClient | undefined;
}

/**
 * Set to "1" to make the client emit a `query` event for every statement it
 * issues. Off by default — query logs contain parameter values, which for this
 * application means prices and costs.
 *
 * Exists for the D15 write-surface test, which has to observe what the
 * recalculation job actually writes. Prisma 6 removed `$use` middleware, and
 * `$extends` returns a NEW client rather than instrumenting this one, so an
 * extension could not see the job's writes at all. Query events are the only
 * remaining way to observe the shared client — and they are strictly better
 * evidence, because they show real SQL and therefore catch a raw-SQL write that
 * a model-name check would miss entirely.
 */
const QUERY_EVENTS_ENABLED = process.env.PRISMA_EMIT_QUERY_EVENTS === "1";

function createPrismaClient(): PrismaClient {
  if (QUERY_EVENTS_ENABLED) {
    return new PrismaClient({
      log: [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }],
    });
  }
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
