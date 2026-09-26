import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  createWarrantyOrderLookupVerification,
  performDummyWarrantyOrderLookupRoundTrip,
  recordWarrantyOrderLookupVerificationEmailOutcome,
  redeemWarrantyOrderLookupVerification,
} from "~/db/repositories/warrantyOrderLookupVerificationRepository.server";

/**
 * D33 — the persistence layer for the guest warranty-order-lookup
 * verification token, against real Postgres. Mirrors
 * `luxuryStealSyncFailureRepository.test.ts`'s `Promise.all` concurrency
 * style for the single-use race test.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

function fixtureInput(overrides: Partial<{ orderRef: string; orderName: string; purchaserEmail: string }> = {}) {
  return {
    orderRef: overrides.orderRef ?? `gid://shopify/Order/${uniq()}`,
    orderName: overrides.orderName ?? "#1001",
    purchaserEmail: overrides.purchaserEmail ?? "purchaser@example.com",
  };
}

describe("createWarrantyOrderLookupVerification", () => {
  it("stores a hash of the token, never the token itself", async () => {
    const { id, token } = await createWarrantyOrderLookupVerification(fixtureInput());

    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    // The raw token cannot be found by treating it as if it were the hash.
    await expect(prisma.warrantyOrderLookupVerification.findUnique({ where: { tokenHash: token } })).resolves.toBeNull();
  });

  it("sets an expiry in the future and leaves consumedAt unset", async () => {
    const before = new Date();
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(before.getTime());
    expect(row.consumedAt).toBeNull();
  });

  it("returns a distinct high-entropy token on every call", async () => {
    const a = await createWarrantyOrderLookupVerification(fixtureInput());
    const b = await createWarrantyOrderLookupVerification(fixtureInput());
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });
});

describe("recordWarrantyOrderLookupVerificationEmailOutcome — team-lead review note on task #26", () => {
  it("defaults to no recorded outcome — a row created but never dispatched is distinguishable from one that was", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.verificationEmailStatus).toBeNull();
    expect(row.verificationEmailProviderMessageId).toBeNull();
    expect(row.verificationEmailAttemptedAt).toBeNull();
  });

  it("records SENT with the provider message id and an attempted-at timestamp", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    await recordWarrantyOrderLookupVerificationEmailOutcome({ verificationId: id, status: "sent", providerMessageId: "resend-abc123" });

    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.verificationEmailStatus).toBe("sent");
    expect(row.verificationEmailProviderMessageId).toBe("resend-abc123");
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });

  it("records FAILED with no provider message id", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    await recordWarrantyOrderLookupVerificationEmailOutcome({ verificationId: id, status: "failed" });

    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.verificationEmailStatus).toBe("failed");
    expect(row.verificationEmailProviderMessageId).toBeNull();
  });

  it("records SKIPPED_UNCONFIGURED with no provider message id", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    await recordWarrantyOrderLookupVerificationEmailOutcome({ verificationId: id, status: "skipped_unconfigured" });

    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.verificationEmailStatus).toBe("skipped_unconfigured");
    expect(row.verificationEmailProviderMessageId).toBeNull();
  });

  it("DATABASE CHECK CONSTRAINT: refuses a provider message id on a non-sent status, even bypassing the repository", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    await expect(
      prisma.warrantyOrderLookupVerification.update({
        where: { id },
        data: { verificationEmailStatus: "failed", verificationEmailProviderMessageId: "should-not-be-allowed", verificationEmailAttemptedAt: new Date() },
      })
    ).rejects.toThrow();
  });

  it("DATABASE CHECK CONSTRAINT: refuses a status with no attempted-at timestamp, even bypassing the repository", async () => {
    const { id } = await createWarrantyOrderLookupVerification(fixtureInput());
    await expect(
      prisma.warrantyOrderLookupVerification.update({
        where: { id },
        data: { verificationEmailStatus: "sent" }, // attemptedAt left null
      })
    ).rejects.toThrow();
  });
});

describe("performDummyWarrantyOrderLookupRoundTrip", () => {
  it("performs a Postgres round trip and creates no row", async () => {
    const before = await prisma.warrantyOrderLookupVerification.count();
    await performDummyWarrantyOrderLookupRoundTrip();
    await expect(prisma.warrantyOrderLookupVerification.count()).resolves.toBe(before);
  });
});

describe("redeemWarrantyOrderLookupVerification", () => {
  it("returns invalid for a token that was never issued", async () => {
    await expect(redeemWarrantyOrderLookupVerification("not-a-real-token")).resolves.toEqual({ outcome: "invalid" });
  });

  it("succeeds exactly once for a freshly issued token, returning the original request's facts", async () => {
    const input = fixtureInput();
    const { token } = await createWarrantyOrderLookupVerification(input);

    const result = await redeemWarrantyOrderLookupVerification(token);
    expect(result).toEqual({
      outcome: "success",
      orderRef: input.orderRef,
      orderName: input.orderName,
      purchaserEmail: input.purchaserEmail,
    });
  });

  it("refuses a second redemption of the same token with already_used", async () => {
    const { token } = await createWarrantyOrderLookupVerification(fixtureInput());
    await redeemWarrantyOrderLookupVerification(token);

    await expect(redeemWarrantyOrderLookupVerification(token)).resolves.toEqual({ outcome: "already_used" });
  });

  it("refuses an expired token, even though it was never redeemed", async () => {
    const { id, token } = await createWarrantyOrderLookupVerification(fixtureInput());
    await prisma.warrantyOrderLookupVerification.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(redeemWarrantyOrderLookupVerification(token)).resolves.toEqual({ outcome: "expired" });
  });

  it("SINGLE-USE UNDER CONCURRENCY: two simultaneous redemptions of the same token — exactly one succeeds", async () => {
    const input = fixtureInput();
    const { token, id } = await createWarrantyOrderLookupVerification(input);

    const [a, b] = await Promise.all([
      redeemWarrantyOrderLookupVerification(token),
      redeemWarrantyOrderLookupVerification(token),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["already_used", "success"]);

    // And the row itself reflects exactly one consumption, not a double-write.
    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { id } });
    expect(row.consumedAt).not.toBeNull();
  });
});
