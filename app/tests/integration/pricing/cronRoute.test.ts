import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import { action } from "~/routes/internal.jobs.price-recalculation";

/**
 * Unique-but-collision-free identifiers for fixtures.
 *
 * Deliberately avoids Math.floor/Math.random: the money-safety scan bans
 * ad-hoc rounding REPOSITORY-WIDE including test files, precisely so a test
 * cannot normalise a value in a way production would not. A monotonic
 * millisecond base plus a sequence gives uniqueness across runs and within a
 * run without any rounding at all.
 */
let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

/**
 * CRITERION 27, 28, 31 — the cron trigger's authentication and the approval
 * surface (spec §9.1, §9.5).
 *
 * The route is the only externally reachable surface this slice adds, so its
 * rejection behaviour is the security boundary of the whole job.
 */

const HEADER = "x-carat-cron-secret";

function request(secret?: string, method = "POST"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== undefined) headers.set(HEADER, secret);
  return new Request("https://example.com/internal/jobs/price-recalculation", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ trigger: "test" }) : undefined,
  });
}

const call = (req: Request) => action({ request: req, params: {}, context: {} } as any);

describe("criterion 27 — cron authentication", () => {
  it("rejects a request with NO secret header", async () => {
    const response = await call(request(undefined));
    expect(response.status).toBe(401);
  });

  it("rejects a WRONG secret", async () => {
    const response = await call(request("definitely-not-the-cron-secret-value"));
    expect(response.status).toBe(401);
  });

  it("rejects an EMPTY secret", async () => {
    const response = await call(request(""));
    expect(response.status).toBe(401);
  });

  it("rejects a secret that is a PREFIX of the real one", async () => {
    // A naive startsWith or a truncated comparison would accept this.
    const { CRON_SECRET } = getEnv();
    const response = await call(request(CRON_SECRET.slice(0, -1)));
    expect(response.status).toBe(401);
  });

  it("rejects a secret LONGER than the real one", async () => {
    // timingSafeEqual throws on a length mismatch; the route must compare
    // lengths first and return the same 401 rather than surfacing an error.
    const { CRON_SECRET } = getEnv();
    const response = await call(request(`${CRON_SECRET}extra`));
    expect(response.status).toBe(401);
  });

  it("does not write anything when rejecting", async () => {
    const before = await prisma.priceCalculation.count();
    await call(request("wrong"));
    expect(await prisma.priceCalculation.count()).toBe(before);
  });
});

describe("criterion 28 — approval requires an explicit actor", () => {
  it("records the actor and writes an audit event", async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await prisma.masterProduct.create({
      data: {
        name: `approval fixture ${suffix}`,
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
        code: "buy_now",
        version: uniqueInt(),
        marginModel: "TARGET_GROSS_MARGIN_V1",
        targetGrossMarginRate: "0.420000",
        minGrossMarginRate: "0.350000",
        minDollarProfitMinorUnits: 15000n,
        currency: "USD",
        roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
        cardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
        cardUpliftRate: "0.050000",
        priceEndingRuleId: "NONE_V1",
        autoApplyToleranceBps: 50,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        createdBy: "integration-test",
        isPlaceholder: false,
      },
    });
    const snapshot = await prisma.snapshot.create({
      data: { kind: "pricing.it", payload: {}, contentHash: `approval-${suffix}` },
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
        computedPriceMinorUnits: 2000n,
        currency: "USD",
        status: "computed",
      },
    });
    const intent = await prisma.priceSyncIntent.create({
      data: {
        masterVariantId: variant.id,
        priceCalculationId: calc.id,
        decision: "needs_approval",
        status: "pending_approval",
        attemptCount: 0,
      },
    });

    const { decideIntent } = await import("~/jobs/pricing/intentTransitions.server");

    // No anonymous approval: an unattributable sign-off is not a sign-off.
    await expect(
      decideIntent({ intentId: intent.id, status: "approved", actor: "" })
    ).rejects.toThrow(/actor is required/i);

    // Still pending after the refused attempt.
    const stillPending = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(stillPending?.status).toBe("pending_approval");

    await decideIntent({
      intentId: intent.id,
      status: "approved",
      actor: "staff-42",
      reason: "reviewed against supplier quote",
    });

    const approved = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("staff-42");

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("price_sync_intent.approved");
    expect(audit[0]!.actorRef).toBe("staff-42");
  });
});
