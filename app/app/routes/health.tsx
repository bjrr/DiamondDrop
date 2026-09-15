import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { getMigrationState } from "~/db/migrationStatus.server";
import { logger } from "~/lib/logger.server";

interface DatabaseHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    // This route is unauthenticated by design (see below), so the raw
    // driver error — which can include connection strings, hostnames, or
    // other internal detail — is logged server-side only. The response
    // body gets a generic message instead.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("health.database_check_failed", { error: message });
    return { status: "error", error: "database unreachable" };
  }
}

// No auth on this route by design — it must expose service/migration
// status only, never cost/margin/secret data (spec §0.2 non-goal: "no admin
// screens beyond a health/status page").
export async function loader(_args: LoaderFunctionArgs) {
  const [database, migrations] = await Promise.all([checkDatabase(), getMigrationState()]);

  const healthy = database.status === "ok" && !migrations.error;

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "carat-for-us-app",
      timestamp: new Date().toISOString(),
      database,
      migrations,
    },
    { status: healthy ? 200 : 503 }
  );
}
