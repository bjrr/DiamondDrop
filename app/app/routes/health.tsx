import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { getMigrationState, type MigrationState } from "~/db/migrationStatus.server";
import {
  checkRequiredPolicyVersionsProvisioned,
  type RequiredPolicyVersionsHealth,
} from "~/db/repositories/policyVersionRepository.server";
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

export type OverallHealthStatus = "ok" | "degraded" | "error";

export interface HealthSummary {
  status: OverallHealthStatus;
  httpStatus: 200 | 503;
}

/**
 * PURE — the one place deciding what `/health`'s top-level `status` and HTTP
 * response code mean, given the three independent checks. Exported so
 * `health.test.ts` can assert every tier with synthetic inputs and no
 * database — the loader below is a thin I/O wrapper around this.
 *
 * THREE TIERS, DELIBERATELY, NOT THE ORIGINAL TWO. A missing required
 * `policy_version` row (see `~/domain/evidence/requiredPolicyVersions`) is
 * real and must be VISIBLE — it is exactly the class of defect that put the
 * Luxury Steals acknowledgment endpoint into production returning HTTP 500 on
 * every attempt with nothing catching it until a real customer hit it. But it
 * is also narrow: ONE feature's precondition, not evidence the process can't
 * serve traffic at all.
 *
 * THE DELIBERATE CHOICE: "missing" maps to `status: "degraded"` at HTTP 200,
 * not HTTP 503. Two reasons, both concrete to this deployment
 * (`fly.toml`):
 *
 * 1. `[[http_service.checks]]` in `fly.toml` points at this exact route, and
 *    its own comment says plainly: "A machine that cannot reach Postgres
 *    stops taking traffic." `min_machines_running = 1` — there is no second
 *    machine to fail over to. A 503 here does not narrow service, it removes
 *    the only machine from rotation, which takes down Buy Now, Group Buy and
 *    every other purchase path along with the one that is actually broken.
 *    Turning "Luxury Steals acknowledgment is unprovisioned" into "the whole
 *    storefront is unreachable" is a materially worse outcome than the
 *    defect it would be reacting to.
 * 2. It would also be inconsistent with this codebase's own established
 *    failure philosophy: CLAUDE.md's pricing- and sync-failure rules (§16-17)
 *    both scope a detected problem down to "only the affected variant
 *    becomes unavailable" rather than pulling the whole catalogue. A missing
 *    required policy version is the same shape of problem — a required
 *    precondition for ONE flow, not the process — and deserves the same
 *    proportionality.
 *
 * "Degraded" is still LOUD, which is the whole point of building this rather
 * than leaving the gap: it is a real word at the top of the JSON body, not
 * buried in a nested field, and it is served the moment a deploy finishes —
 * visible to anyone or anything polling `/health`, including a future
 * monitoring alert wired to this field — rather than only at the first
 * customer's failed request. What it deliberately does NOT do is get the
 * machine pulled from Fly's rotation over a problem Fly pulling the machine
 * cannot fix and would only compound.
 *
 * `requiredPolicyVersions.status === "unknown"` (the check itself failed —
 * e.g. the query errored even though the plain connectivity probe above
 * succeeded) is treated the same as "missing": something about a required
 * precondition could not be confirmed, and "could not confirm" must not
 * silently read as "confirmed ok".
 *
 * `database`/`migrations` failures are UNCHANGED from before this task: they
 * still drive `status: "error"` at HTTP 503, because those genuinely mean the
 * process cannot serve ANY request — the class of problem this route's Fly
 * check exists to catch.
 */
export function deriveHealthSummary(input: {
  database: DatabaseHealth;
  migrations: MigrationState;
  requiredPolicyVersions: RequiredPolicyVersionsHealth;
}): HealthSummary {
  const cannotServeAnyRequest = input.database.status === "error" || Boolean(input.migrations.error);
  if (cannotServeAnyRequest) {
    return { status: "error", httpStatus: 503 };
  }

  const requiredPolicyVersionsOk = input.requiredPolicyVersions.status === "ok";
  if (!requiredPolicyVersionsOk) {
    return { status: "degraded", httpStatus: 200 };
  }

  return { status: "ok", httpStatus: 200 };
}

// No auth on this route by design — it must expose service/migration
// status only, never cost/margin/secret data (spec §0.2 non-goal: "no admin
// screens beyond a health/status page"). requiredPolicyVersions below is
// also non-sensitive: only (slug, version) pairs and a status, never the
// policy text or content hash.
export async function loader(_args: LoaderFunctionArgs) {
  const [database, migrations, requiredPolicyVersions] = await Promise.all([
    checkDatabase(),
    getMigrationState(),
    checkRequiredPolicyVersionsProvisioned(),
  ]);

  const { status, httpStatus } = deriveHealthSummary({ database, migrations, requiredPolicyVersions });

  if (requiredPolicyVersions.status !== "ok") {
    // LOUD, per this route's own doc comment above: logged as an error even
    // though the HTTP status stays 200, so a log-based alert can catch this
    // the moment a deploy finishes rather than depending on someone reading
    // the JSON body by hand.
    logger.error("health.required_policy_versions_not_ok", {
      status: requiredPolicyVersions.status,
      missing: requiredPolicyVersions.missing,
      error: requiredPolicyVersions.error,
    });
  }

  return Response.json(
    {
      status,
      service: "carat-for-us-app",
      timestamp: new Date().toISOString(),
      database,
      migrations,
      requiredPolicyVersions,
    },
    { status: httpStatus }
  );
}
