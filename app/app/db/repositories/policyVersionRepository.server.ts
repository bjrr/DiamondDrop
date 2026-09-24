import { buildPolicyVersionRecord } from "~/domain/evidence/policyVersion";
import {
  computeMissingRequiredPolicyVersions,
  REQUIRED_POLICY_VERSIONS,
  type MissingRequiredPolicyVersion,
  type RequiredPolicyVersion,
} from "~/domain/evidence/requiredPolicyVersions";

import { prisma } from "../client.server";

/**
 * Create/read only — policy_version is append-only at the database level
 * (spec §0.5). There is no update or delete method here on purpose.
 */
export async function createPolicyVersion(input: unknown) {
  const record = buildPolicyVersionRecord(input);
  return prisma.policyVersion.create({ data: record });
}

export async function getPolicyVersionById(id: string) {
  return prisma.policyVersion.findUnique({ where: { id } });
}

export async function getPolicyVersionBySlugAndVersion(slug: string, version: number) {
  return prisma.policyVersion.findUnique({ where: { slug_version: { slug, version } } });
}

/** The currently effective version for a slug — highest version number. */
export async function getLatestPolicyVersion(slug: string) {
  return prisma.policyVersion.findFirst({ where: { slug }, orderBy: { version: "desc" } });
}

export interface RequiredPolicyVersionsHealth {
  status: "ok" | "missing" | "unknown";
  missing: MissingRequiredPolicyVersion[];
  error?: string;
}

/**
 * The database-touching half of the required-policy-version check (`/health`,
 * `docs/specs/SLICE-3-LUXURY-STEALS.md` follow-up — owner ruling on the
 * production `policy_unavailable` 500). Pure decision logic lives in
 * `computeMissingRequiredPolicyVersions`
 * (`~/domain/evidence/requiredPolicyVersions`); this function's only job is
 * to fetch which of the registry's (slug, version) pairs actually exist and
 * hand the result to that pure function.
 *
 * `required` defaults to the real registry but is an explicit parameter —
 * same test-substitution shape as `__setDraftOrderPortForTests` elsewhere in
 * this codebase — so integration tests can exercise the "a required policy
 * is missing" path with a synthetic entry, without needing to delete a real
 * `policy_version` row (impossible: the table is append-only).
 *
 * NEVER THROWS — mirrors `getMigrationState`'s contract, because `/health`
 * must keep reporting `database`/`migrations` even if this specific check
 * fails (e.g. the connection drops between the two queries).
 */
export async function checkRequiredPolicyVersionsProvisioned(
  required: readonly RequiredPolicyVersion[] = REQUIRED_POLICY_VERSIONS
): Promise<RequiredPolicyVersionsHealth> {
  if (required.length === 0) {
    return { status: "ok", missing: [] };
  }

  try {
    const rows = await prisma.policyVersion.findMany({
      where: { OR: required.map((r) => ({ slug: r.slug, version: r.version })) },
      select: { slug: true, version: true },
    });
    const missing = computeMissingRequiredPolicyVersions(required, rows);
    return { status: missing.length === 0 ? "ok" : "missing", missing };
  } catch (error) {
    return {
      status: "unknown",
      missing: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
