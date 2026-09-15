import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { prisma } from "~/db/client.server";
import { getMigrationState } from "~/db/migrationStatus.server";

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
    return { status: "error", error: error instanceof Error ? error.message : "unknown error" };
  }
}

// No auth on this route by design — it must expose service/migration
// status only, never cost/margin/secret data (spec §0.2 non-goal: "no admin
// screens beyond a health/status page").
export async function loader(_args: LoaderFunctionArgs) {
  const [database, migrations] = await Promise.all([checkDatabase(), getMigrationState()]);

  const healthy = database.status === "ok" && !migrations.error;

  return json(
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
