import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { assignLuxurySteal, isMasterVariantLuxurySteal } from "~/db/repositories/luxuryStealRepository.server";
import { getOpenLuxuryStealSyncFailure } from "~/db/repositories/luxuryStealSyncFailureRepository.server";
import { RecordingLuxuryStealMetafieldSyncPort } from "~/jobs/luxurysteals/ports";
import {
  LuxuryStealVariantNotFoundError,
  syncLuxuryStealAssignment,
  syncLuxuryStealAssignments,
} from "~/jobs/luxurysteals/syncAssignment.server";

/**
 * Slice 3 task 3-2b, criterion 152 — the job-layer sequencing that wires
 * `setLuxuryStealMetafields` behind a port. Money-critical/evidence-critical
 * per the assigning message: "sync failure is recorded durably and does NOT
 * change purchasability" is the load-bearing assertion of this file.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

async function createVariant(overrides: { shopifyVariantGid?: string | null; isLuxurySteal?: boolean } = {}) {
  const product = await prisma.masterProduct.create({
    data: {
      name: `syncAssignment fixture ${uniq()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid:
        overrides.shopifyVariantGid === null ? undefined : (overrides.shopifyVariantGid ?? `gid://shopify/ProductVariant/${uniq()}`),
    },
  });
  if (overrides.isLuxurySteal) await assignLuxurySteal(variant.id);
  return variant;
}

describe("syncLuxuryStealAssignment — the happy path", () => {
  it("syncs on the first attempt and sends the variant's current assignment", async () => {
    const variant = await createVariant({ isLuxurySteal: true });
    const port = new RecordingLuxuryStealMetafieldSyncPort();

    const outcome = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    expect(outcome).toEqual({ kind: "synced", masterVariantId: variant.id, attempts: 1, resolvedPriorFailure: false });
    expect(port.calls).toEqual([[{ shopifyVariantGid: variant.shopifyVariantGid, isLuxurySteal: true }]]);
  });

  it("sends an explicit false for an unassigned variant (never omits the write)", async () => {
    const variant = await createVariant({ isLuxurySteal: false });
    const port = new RecordingLuxuryStealMetafieldSyncPort();

    await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    expect(port.calls[0]).toEqual([{ shopifyVariantGid: variant.shopifyVariantGid, isLuxurySteal: false }]);
  });

  it("skips a variant with no Shopify linkage yet, without recording a failure", async () => {
    const variant = await createVariant({ shopifyVariantGid: null });
    const port = new RecordingLuxuryStealMetafieldSyncPort();

    const outcome = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    expect(outcome).toEqual({ kind: "skipped_not_linked", masterVariantId: variant.id });
    expect(port.calls).toHaveLength(0);
    expect(await getOpenLuxuryStealSyncFailure(variant.id)).toBeNull();
  });

  it("throws LuxuryStealVariantNotFoundError for an id with no row at all", async () => {
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    await expect(
      syncLuxuryStealAssignment(randomUUID(), { port, trigger: "automatic-retry" })
    ).rejects.toBeInstanceOf(LuxuryStealVariantNotFoundError);
  });
});

describe("syncLuxuryStealAssignment — the bounded immediate retry", () => {
  it("retries once immediately and succeeds — recorded as a normal success, no open failure left behind", async () => {
    const variant = await createVariant();
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.failNextWith = new Error("transient 500");

    const outcome = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    expect(outcome.kind).toBe("synced");
    if (outcome.kind === "synced") expect(outcome.attempts).toBe(2);
    expect(port.calls).toHaveLength(2);
    expect(await getOpenLuxuryStealSyncFailure(variant.id)).toBeNull();
  });

  it("BOTH attempts failing records a durable failure — never marks resolved before Shopify confirms", async () => {
    const variant = await createVariant();
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.alwaysFailWith = new Error("Shopify Admin API metafieldsSet failed: userErrors present");

    const outcome = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.attemptCount).toBe(1);
      expect(outcome.error).toMatch(/userErrors present/);
    }
    expect(port.calls).toHaveLength(2); // both bounded attempts were made

    const failure = await getOpenLuxuryStealSyncFailure(variant.id);
    expect(failure).not.toBeNull();
    expect(failure?.resolvedAt).toBeNull();
  });

  it("a later successful call accumulates attemptCount and then resolves the SAME episode", async () => {
    const variant = await createVariant();
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.alwaysFailWith = new Error("still down");

    const first = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });
    expect(first.kind).toBe("failed");
    const openAfterFirst = await getOpenLuxuryStealSyncFailure(variant.id);
    // recordLuxuryStealSyncFailure is called ONCE per syncLuxuryStealAssignment
    // invocation (after both bounded port attempts are exhausted), not once
    // per port call — attemptCount counts INVOCATIONS of this function, not
    // raw Admin API calls.
    expect(openAfterFirst?.attemptCount).toBe(1);

    const second = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });
    expect(second.kind).toBe("failed");
    const openAfterSecond = await getOpenLuxuryStealSyncFailure(variant.id);
    expect(openAfterSecond?.failureId).toBe(openAfterFirst?.failureId); // same episode, not a new one
    expect(openAfterSecond?.attemptCount).toBe(2);

    port.alwaysFailWith = null;
    const third = await syncLuxuryStealAssignment(variant.id, { port, trigger: "staff:9001" });
    expect(third.kind).toBe("synced");
    if (third.kind === "synced") expect(third.resolvedPriorFailure).toBe(true);

    const resolvedRow = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({
      where: { id: openAfterSecond!.failureId },
    });
    expect(resolvedRow.resolvedAt).not.toBeNull();
    expect(resolvedRow.resolvedTrigger).toBe("staff:9001");
    await expect(getOpenLuxuryStealSyncFailure(variant.id)).resolves.toBeNull();
  });
});

describe("criterion 152 — a failing sync never changes purchasability", () => {
  it("the variant's assignment, status and updatedAt are untouched by a failed sync", async () => {
    const variant = await createVariant({ isLuxurySteal: true });
    const before = await prisma.masterVariant.findUniqueOrThrow({ where: { id: variant.id } });

    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.alwaysFailWith = new Error("Shopify unreachable");
    await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });

    const after = await prisma.masterVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.status).toBe(before.status); // still "active" — never withdrawn
    expect(after.updatedAt).toEqual(before.updatedAt); // no write to master_variant happened at all
    await expect(isMasterVariantLuxurySteal(variant.id)).resolves.toBe(true); // the assignment itself is unaffected
  });

  it("nothing in the outcome or the failure repository offers a way to suspend the variant", async () => {
    const variant = await createVariant();
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.alwaysFailWith = new Error("down");

    const outcome = await syncLuxuryStealAssignment(variant.id, { port, trigger: "automatic-retry" });
    expect(Object.keys(outcome)).not.toContain("suspended");
    expect(Object.keys(outcome)).not.toContain("suspendedAt");

    const failure = await getOpenLuxuryStealSyncFailure(variant.id);
    expect(failure && Object.keys(failure)).not.toContain("suspendedAt");
  });
});

describe("syncLuxuryStealAssignments — the bulk 'apply to all variants' convenience", () => {
  it("syncs every id given, sequentially, and returns one outcome per variant", async () => {
    const v1 = await createVariant({ isLuxurySteal: true });
    const v2 = await createVariant({ isLuxurySteal: true });
    const v3 = await createVariant({ isLuxurySteal: true });
    const port = new RecordingLuxuryStealMetafieldSyncPort();

    const outcomes = await syncLuxuryStealAssignments([v1.id, v2.id, v3.id], {
      port,
      trigger: "automatic-retry",
    });

    expect(outcomes.map((o) => o.masterVariantId)).toEqual([v1.id, v2.id, v3.id]);
    expect(outcomes.every((o) => o.kind === "synced")).toBe(true);
    expect(port.calls).toHaveLength(3);
  });

  it("one variant's failure does not stop the others from being attempted", async () => {
    const v1 = await createVariant();
    const v2 = await createVariant();
    const port = new RecordingLuxuryStealMetafieldSyncPort();
    port.alwaysFailWith = new Error("down for v1 and its retry");

    // Only the first two calls (both of v1's bounded attempts) fail; clear before v2's calls.
    const originalSyncAssignments = port.syncAssignments.bind(port);
    let callIndex = 0;
    port.syncAssignments = async (assignments) => {
      callIndex += 1;
      if (callIndex > 2) port.alwaysFailWith = null;
      return originalSyncAssignments(assignments);
    };

    const outcomes = await syncLuxuryStealAssignments([v1.id, v2.id], { port, trigger: "automatic-retry" });

    expect(outcomes[0]?.kind).toBe("failed");
    expect(outcomes[1]?.kind).toBe("synced");
  });
});
