import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  InvalidIntentTransitionError,
  MissingActorError,
  PlaceholderProfileApprovalError,
  decideIntent,
} from "~/jobs/pricing/intentTransitions.server";

/**
 * CRITERION 28 and the D14 guard — the single approval path.
 *
 * There were two divergent implementations of "approve": the repository's and
 * the CLI's inline transaction. Only the CLI carried the D14 placeholder
 * guard, so the exported repository version — importable, and the one a future
 * admin UI would reach for — would approve a price computed from invented
 * margins. These tests pin the behaviour of the one module that remains.
 */

let sequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (sequence += 1);

async function intentWith(isPlaceholder: boolean) {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `transition fixture ${suffix}`,
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
    },
  });
  const profile = await prisma.pricingProfile.create({
    data: {
      // A deliberately non-buy_now code so these fixtures cannot outrank the
      // real seeded profile in resolution (the pollution problem F-29).
      code: "buy_now",
      version: uniqueInt(),
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: isPlaceholder ? "0.999900" : "0.420000",
      minGrossMarginRate: isPlaceholder ? "0.999800" : "0.350000",
      minDollarProfitMinorUnits: 15000n,
      currency: "USD",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 50,
      // Far in the past so it never wins resolution against the seeded rows.
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `transition-${suffix}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variant.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits: 2000n,
      currency: "USD",
      status: "computed",
    },
  });
  return prisma.priceSyncIntent.create({
    data: {
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      decision: "needs_approval",
      status: "pending_approval",
      reason: "queued because the change exceeded tolerance",
      attemptCount: 0,
    },
  });
}

describe("an actor is required", () => {
  it("refuses an empty actor and leaves the intent pending", async () => {
    const intent = await intentWith(false);
    await expect(
      decideIntent({ intentId: intent.id, status: "approved", actor: "" })
    ).rejects.toBeInstanceOf(MissingActorError);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("pending_approval");
  });

  it("refuses whitespace as an actor", async () => {
    const intent = await intentWith(false);
    await expect(
      decideIntent({ intentId: intent.id, status: "approved", actor: "   " })
    ).rejects.toBeInstanceOf(MissingActorError);
  });
});

describe("the D14 placeholder guard", () => {
  it("refuses to APPROVE a price computed from a placeholder profile", async () => {
    // While D14 is unresolved the margins are invented, so no price derived
    // from them may clear review by any route.
    const intent = await intentWith(true);
    await expect(
      decideIntent({ intentId: intent.id, status: "approved", actor: "staff-1" })
    ).rejects.toBeInstanceOf(PlaceholderProfileApprovalError);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("pending_approval");
  });

  it("still allows REJECTING one — clearing a bad intent is always safe", async () => {
    const intent = await intentWith(true);
    const rejected = await decideIntent({
      intentId: intent.id,
      status: "rejected",
      actor: "staff-1",
      reason: "placeholder margins",
    });
    expect(rejected.status).toBe("rejected");
  });

  it("approves normally when the profile is real", async () => {
    const intent = await intentWith(false);
    const approved = await decideIntent({
      intentId: intent.id,
      status: "approved",
      actor: "staff-2",
    });
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("staff-2");
  });
});

describe("the transition table is enforced", () => {
  it("refuses to approve an intent that is already terminal", async () => {
    const intent = await intentWith(false);
    await decideIntent({ intentId: intent.id, status: "rejected", actor: "staff-3", reason: "no" });

    await expect(
      decideIntent({ intentId: intent.id, status: "approved", actor: "staff-3" })
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError);
  });
});

describe("the queuing reason survives a decision", () => {
  it("does not overwrite why review was requested", async () => {
    // Approving without --reason previously wrote `reason: null`, destroying
    // the record of why the intent was queued in the first place.
    const intent = await intentWith(false);
    const approved = await decideIntent({
      intentId: intent.id,
      status: "approved",
      actor: "staff-4",
    });
    expect(approved.reason).toBe("queued because the change exceeded tolerance");
  });

  it("appends a supplied reason rather than replacing", async () => {
    const intent = await intentWith(false);
    const approved = await decideIntent({
      intentId: intent.id,
      status: "approved",
      actor: "staff-5",
      reason: "checked against supplier quote",
    });
    expect(approved.reason).toContain("queued because the change exceeded tolerance");
    expect(approved.reason).toContain("checked against supplier quote");
  });
});

describe("every decision is audited", () => {
  it("writes exactly one audit event naming the actor", async () => {
    const intent = await intentWith(false);
    await decideIntent({ intentId: intent.id, status: "approved", actor: "staff-6" });

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("price_sync_intent.approved");
    expect(audit[0]!.actorRef).toBe("staff-6");
  });
});
