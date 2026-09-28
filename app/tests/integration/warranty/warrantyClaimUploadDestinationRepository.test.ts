import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  consumeWarrantyClaimUploadDestination,
  recordIssuedWarrantyClaimUploadDestination,
} from "~/db/repositories/warrantyClaimUploadDestinationRepository.server";

/**
 * Closes the storageKey trust gap flagged in the R2 adapter handoff — the
 * mechanism-level tests for `consumeWarrantyClaimUploadDestination`, the
 * single atomic conditional UPDATE that is this whole fix's load-bearing
 * operation. `warrantyClaimRoute.test.ts` covers the end-to-end route
 * behaviour (the response an attacker actually sees); this file proves the
 * underlying primitive is actually race-safe and actually collapses every
 * failure mode identically, against real Postgres.
 */

const DEFAULT_CUSTOMER_GID = "gid://shopify/Customer/333333";

async function seed(overrides: Partial<{ claimId: string; customerRef: string; storageKey: string; expiresAt: Date }> = {}) {
  return recordIssuedWarrantyClaimUploadDestination({
    claimId: overrides.claimId ?? randomUUID(),
    customerRef: overrides.customerRef ?? DEFAULT_CUSTOMER_GID,
    kind: "photo",
    contentType: "image/jpeg",
    storageKey: overrides.storageKey ?? `warranty/${randomUUID()}/photo/${randomUUID()}.jpg`,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
  });
}

describe("recordIssuedWarrantyClaimUploadDestination", () => {
  it("persists an unconsumed destination with the exact fields given", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: DEFAULT_CUSTOMER_GID });
    expect(destination.claimId).toBe(claimId);
    expect(destination.customerRef).toBe(DEFAULT_CUSTOMER_GID);
    expect(destination.consumedAt).toBeNull();
  });
});

describe("consumeWarrantyClaimUploadDestination — the atomic verify-and-consume gate", () => {
  it("a key never issued is refused (no row to match)", async () => {
    const ok = await consumeWarrantyClaimUploadDestination({
      storageKey: `warranty/${randomUUID()}/photo/never-issued.jpg`,
      claimId: randomUUID(),
      customerRef: DEFAULT_CUSTOMER_GID,
    });
    expect(ok).toBe(false);
  });

  it("a key issued for a DIFFERENT claim is refused", async () => {
    const issuedClaimId = randomUUID();
    const destination = await seed({ claimId: issuedClaimId, customerRef: DEFAULT_CUSTOMER_GID });

    const ok = await consumeWarrantyClaimUploadDestination({
      storageKey: destination.storageKey,
      claimId: randomUUID(), // a different claim
      customerRef: DEFAULT_CUSTOMER_GID,
    });
    expect(ok).toBe(false);

    // Refusing must not consume it — a legitimate later attempt (e.g. after
    // fixing a client bug) can still succeed.
    const row = await prisma.warrantyClaimUploadDestination.findUnique({ where: { storageKey: destination.storageKey } });
    expect(row?.consumedAt).toBeNull();
  });

  it("a key issued to a DIFFERENT customer is refused, and the failure is INDISTINGUISHABLE from a wrong-claim refusal (both return exactly `false`)", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: "gid://shopify/Customer/999999" });

    const ok = await consumeWarrantyClaimUploadDestination({
      storageKey: destination.storageKey,
      claimId,
      customerRef: DEFAULT_CUSTOMER_GID, // not who it was issued to
    });
    expect(ok).toBe(false);
  });

  it("an expired key is refused", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: DEFAULT_CUSTOMER_GID, expiresAt: new Date(Date.now() - 1000) });

    const ok = await consumeWarrantyClaimUploadDestination({
      storageKey: destination.storageKey,
      claimId,
      customerRef: DEFAULT_CUSTOMER_GID,
    });
    expect(ok).toBe(false);
  });

  it("a valid, matching, unexpired key is consumed successfully", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: DEFAULT_CUSTOMER_GID });

    const ok = await consumeWarrantyClaimUploadDestination({
      storageKey: destination.storageKey,
      claimId,
      customerRef: DEFAULT_CUSTOMER_GID,
    });
    expect(ok).toBe(true);

    const row = await prisma.warrantyClaimUploadDestination.findUnique({ where: { storageKey: destination.storageKey } });
    expect(row?.consumedAt).not.toBeNull();
  });

  it("the SAME key cannot be consumed twice — a second attempt after a successful one is refused", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: DEFAULT_CUSTOMER_GID });
    const params = { storageKey: destination.storageKey, claimId, customerRef: DEFAULT_CUSTOMER_GID };

    expect(await consumeWarrantyClaimUploadDestination(params)).toBe(true);
    expect(await consumeWarrantyClaimUploadDestination(params)).toBe(false);
  });

  it("RACE SAFETY: of two concurrent attempts to consume the same key, exactly one succeeds", async () => {
    const claimId = randomUUID();
    const destination = await seed({ claimId, customerRef: DEFAULT_CUSTOMER_GID });
    const params = { storageKey: destination.storageKey, claimId, customerRef: DEFAULT_CUSTOMER_GID };

    const [first, second] = await Promise.all([
      consumeWarrantyClaimUploadDestination(params),
      consumeWarrantyClaimUploadDestination(params),
    ]);
    const successes = [first, second].filter(Boolean).length;
    expect(successes).toBe(1);
  });
});
