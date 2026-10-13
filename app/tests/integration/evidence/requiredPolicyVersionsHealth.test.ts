import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { REQUIRED_POLICY_VERSIONS } from "~/domain/evidence/requiredPolicyVersions";
import { checkRequiredPolicyVersionsProvisioned } from "~/db/repositories/policyVersionRepository.server";
import { deriveHealthSummary, loader } from "~/routes/health";

/**
 * The database-touching half of the required-policy-version health check,
 * against a real, migrated-and-seeded Postgres (`tests/integration/globalSetup.ts`
 * runs `prisma migrate deploy` then `prisma/seed.ts` once for the whole run —
 * so the real `REQUIRED_POLICY_VERSIONS` entries are provisioned by the
 * migration exactly as production is).
 *
 * THE "MISSING" PATH CANNOT BE PRODUCED BY DELETING A REAL ROW —
 * `policy_version` is append-only at the database level (this is the whole
 * point of the feature this migration provisions). So the negative path is
 * exercised by calling `checkRequiredPolicyVersionsProvisioned` with a
 * SYNTHETIC required list naming a (slug, version) that was never
 * provisioned — the same test-substitution shape as `__setDraftOrderPortForTests`
 * elsewhere in this codebase, and the reason that parameter exists at all.
 */

describe("checkRequiredPolicyVersionsProvisioned — real database", () => {
  it("reports ok for the real REQUIRED_POLICY_VERSIONS registry against the migrated+seeded database", async () => {
    const result = await checkRequiredPolicyVersionsProvisioned();
    expect(result).toEqual({ status: "ok", missing: [] });
  });

  it("finds the Luxury Steals acknowledgment policy version row the migration provisions", async () => {
    const row = await prisma.policyVersion.findUnique({
      where: {
        slug_version: {
          slug: "luxury-steals-final-sale-acknowledgment",
          version: 1,
        },
      },
    });
    expect(row).not.toBeNull();
  });

  it("reports 'missing' for a required (slug, version) that has never been provisioned", async () => {
    const syntheticRequired = [
      ...REQUIRED_POLICY_VERSIONS,
      { slug: "a-policy-nobody-has-ever-provisioned", version: 999, text: "x", contentHash: "irrelevant" },
    ];

    const result = await checkRequiredPolicyVersionsProvisioned(syntheticRequired);

    expect(result.status).toBe("missing");
    expect(result.missing).toEqual([{ slug: "a-policy-nobody-has-ever-provisioned", version: 999 }]);
  });

  it("does not report a provisioned entry as missing just because an UNPROVISIONED one is also required", async () => {
    // Same call as above — the real Luxury Steals policy must not disappear
    // from "present" just because a second, synthetic requirement is absent.
    const syntheticRequired = [
      ...REQUIRED_POLICY_VERSIONS,
      { slug: "a-policy-nobody-has-ever-provisioned", version: 999, text: "x", contentHash: "irrelevant" },
    ];
    const result = await checkRequiredPolicyVersionsProvisioned(syntheticRequired);
    const missingSlugs = result.missing.map((m) => m.slug);
    expect(missingSlugs).not.toContain("luxury-steals-final-sale-acknowledgment");
  });

  it("reports ok trivially for an empty required list", async () => {
    await expect(checkRequiredPolicyVersionsProvisioned([])).resolves.toEqual({ status: "ok", missing: [] });
  });
});

describe("/health loader — end-to-end against the real database", () => {
  it("returns 200 with requiredPolicyVersions.status 'ok' once the migration+seed have run", async () => {
    const request = new Request("https://app.example.com/health");
    const response = await loader({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      requiredPolicyVersions: { status: string; missing: unknown[] };
    };
    expect(body.status).toBe("ok");
    expect(body.requiredPolicyVersions).toEqual({ status: "ok", missing: [] });
  });

  it("does not leak the policy text or content hash — only (slug, version) and status", async () => {
    const request = new Request("https://app.example.com/health");
    const response = await loader({ request, params: {}, context: {} } as never);
    const text = await response.text();

    expect(text).not.toMatch(/FINAL SALE ACKNOWLEDGMENT/);
    expect(text).not.toMatch(/content.?hash/i);
  });
});

describe("deriveHealthSummary — re-exported and consistent with the pure unit tests", () => {
  it("agrees with the real checkRequiredPolicyVersionsProvisioned('ok') result", async () => {
    const requiredPolicyVersions = await checkRequiredPolicyVersionsProvisioned();
    const summary = deriveHealthSummary({
      database: { status: "ok" },
      migrations: { applied: [], pending: [] },
      requiredPolicyVersions,
    });
    expect(summary).toEqual({ status: "ok", httpStatus: 200 });
  });
});
