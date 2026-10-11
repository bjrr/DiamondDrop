import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";
import type { RedemptionLineInput } from "~/domain/beatyourquote/redemptionCalculation";
import { Money } from "~/domain/money/money";
import {
  attachRedemptionDraftOrder,
  releaseBeatQuoteRedemption,
  reserveBeatQuoteRedemption,
  verifyAndCompleteBeatQuoteRedemption,
} from "~/jobs/beatyourquote/redeemFallbackBenefit.server";

/**
 * Redemption of the 10%-off fallback benefit, against real Postgres.
 *
 * The owner's required cases are each named in the test that proves them. The
 * properties that matter most are the ones a function alone cannot guarantee:
 * that two concurrent checkouts converge on ONE usable purchase, that a
 * duplicate order delivery cannot redeem twice, and that a discount which does
 * not match what we promised fails closed to a human rather than to
 * "redeemed".
 */

const CUSTOMER = "gid://shopify/Customer/4242";
const OTHER_CUSTOMER = "gid://shopify/Customer/9999";
const ISSUED_AT = new Date("2026-10-10T12:00:00.000Z");
const DURING = new Date("2026-11-01T12:00:00.000Z");

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

function line(overrides: Partial<RedemptionLineInput> = {}): RedemptionLineInput {
  return {
    reference: `gid://shopify/ProductVariant/${uniq()}`,
    quantity: 1,
    unitPrice: usd(50_000n),
    ineligibleBecause: null,
    ...overrides,
  };
}

/** A submission that qualified, plus the benefit it earned. */
async function benefit(
  overrides: { customerRef?: string; expiresAt?: Date; redeemedAt?: Date; revokedAt?: Date } = {}
) {
  const submission = await prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-${uniq()}`,
      customerRef: overrides.customerRef ?? CUSTOMER,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${uniq()}@example.com`,
      kind: "custom_quote",
      quoteIssuedOn: new Date("2026-10-05T00:00:00.000Z"),
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      submittedAt: new Date("2026-10-09T15:00:00.000Z"),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays: 4,
      treatment: "guarantee",
      verification: "verified",
      verifiedAt: ISSUED_AT,
      verifiedByActorRef: "staff:reviewer",
      status: "declined_cannot_beat",
      decisionReason: "below floor",
    },
  });
  return prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId: submission.id,
      benefitCode: `BQ10-${uniq()}`,
      customerRef: overrides.customerRef ?? CUSTOMER,
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt: ISSUED_AT,
      expiresAt: overrides.expiresAt ?? fallbackExpiresAt(ISSUED_AT),
      issuedByActorType: "staff",
      issuedByActorRef: "staff:reviewer",
      ...(overrides.redeemedAt
        ? {
            redeemedAt: overrides.redeemedAt,
            redemptionOrderRef: `gid://shopify/Order/prior-${uniq()}`,
            redemptionDiscountMinorUnits: 5_000n,
          }
        : {}),
      ...(overrides.revokedAt ? { revokedAt: overrides.revokedAt, revokedReason: "fabricated quote found" } : {}),
    },
  });
}

function reserve(code: string, overrides: Record<string, unknown> = {}) {
  return reserveBeatQuoteRedemption({
    benefitCode: code,
    customerRef: CUSTOMER,
    surface: "buy_now",
    lines: [line({ unitPrice: usd(50_000n) })],
    otherPromotionApplied: false,
    stackingExpresslyAuthorized: false,
    now: DURING,
    ...overrides,
  } as Parameters<typeof reserveBeatQuoteRedemption>[0]);
}

describe("the owner's worked amounts, end to end through a reservation", () => {
  it.each([
    [50_000n, 5_000n, "$500 -> $50"],
    [100_000n, 10_000n, "$1,000 -> $100"],
    [500_000n, 10_000n, "$5,000 -> still $100"],
  ])("%s", async (unit, expected) => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { lines: [line({ unitPrice: usd(unit) })] });
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved") return;
    expect(result.intent.discountMinorUnits).toBe(expected);
    expect(result.intent.eligibleSubtotalMinorUnits).toBe(unit);
    // The benefit's own cap is copied onto the intent, so a CHECK can enforce
    // it and so this intent is judged against the terms it was created under.
    expect(result.intent.benefitMaxDiscountMinorUnits).toBe(10_000n);
    expect(result.intent.status).toBe("reserved");
  });
});

describe("every pre-condition is checked before anything is written", () => {
  it("refuses an EXPIRED benefit", async () => {
    const b = await benefit({ expiresAt: new Date("2026-10-20T00:00:00.000Z") });
    const result = await reserve(b.benefitCode);
    expect(result).toMatchObject({ outcome: "refused", refusal: "expired" });
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(0);
  });

  it("refuses a REVOKED benefit", async () => {
    const b = await benefit({ revokedAt: new Date("2026-10-15T00:00:00.000Z") });
    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "revoked" });
  });

  it("refuses the WRONG CUSTOMER — possession of the code is not entitlement", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { customerRef: OTHER_CUSTOMER });
    expect(result).toMatchObject({ outcome: "refused", refusal: "not_transferable" });
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(0);
  });

  it("refuses an ALREADY-REDEEMED benefit", async () => {
    const b = await benefit({ redeemedAt: new Date("2026-10-25T00:00:00.000Z") });
    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "already_redeemed" });
  });

  it("refuses an unknown code with the SAME answer as someone else's", async () => {
    // Distinguishing them would make this an oracle for guessing another
    // customer's benefit.
    const unknown = await reserve(`BQ10-NOSUCH-${uniq()}`);
    expect(unknown).toMatchObject({ outcome: "refused", refusal: "benefit_not_found" });
  });
});

describe("surfaces — amendment §3", () => {
  it("ACCEPTS regular Buy Now", async () => {
    const b = await benefit();
    expect((await reserve(b.benefitCode, { surface: "buy_now" })).outcome).toBe("reserved");
  });

  it("ACCEPTS Custom Jewelry — the same benefit on the final approved purchase", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { surface: "custom_jewelry" });
    expect(result.outcome).toBe("reserved");
    if (result.outcome === "reserved") expect(result.intent.surface).toBe("custom_jewelry");
  });

  it.each(["group_buy", "luxury_steals"] as const)("REFUSES %s", async (surface) => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { surface });
    expect(result).toMatchObject({ outcome: "refused", refusal: "surface_not_eligible" });
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(0);
  });

  it("the DATABASE has no enum member for the excluded surfaces", async () => {
    // Unrepresentable, not merely refused. A direct INSERT cannot name them.
    const b = await benefit();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "beat_quote_redemption_intent"
          ("id","benefit_id","customer_ref","surface","eligible_subtotal_minor_units","discount_minor_units",
           "currency","benefit_max_discount_minor_units","benefit_expires_at","eligible_lines")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${CUSTOMER}, 'group_buy', 50000, 5000, 'USD', 10000, now(), '[]'::jsonb)`
    ).rejects.toThrow();
  });
});

describe("stacking is refused by default", () => {
  it("REFUSES when another promotion is applied", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { otherPromotionApplied: true });
    expect(result).toMatchObject({ outcome: "refused", refusal: "stacking_not_authorized" });
  });

  it("ALLOWS it when expressly authorized", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, {
      otherPromotionApplied: true,
      stackingExpresslyAuthorized: true,
    });
    expect(result.outcome).toBe("reserved");
  });
});

describe("excluded merchandise never receives the benefit", () => {
  it("a Group Buy line is left out of the eligible subtotal", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, {
      lines: [
        line({ reference: "gb", unitPrice: usd(900_000n), ineligibleBecause: "group_buy" }),
        line({ reference: "ok", unitPrice: usd(20_000n) }),
      ],
    });
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved") return;
    // Without the exclusion the $9,000 line would have capped this at $100.
    expect(result.intent.eligibleSubtotalMinorUnits).toBe(20_000n);
    expect(result.intent.discountMinorUnits).toBe(2_000n);
    // And the frozen snapshot records ONLY what was actually discounted.
    expect(JSON.stringify(result.intent.eligibleLines)).toContain("ok");
    expect(JSON.stringify(result.intent.eligibleLines)).not.toContain("gb");
  });

  it("a Luxury Steal line likewise", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, {
      lines: [
        line({ reference: "ls", unitPrice: usd(400_000n), ineligibleBecause: "luxury_steal" }),
        line({ reference: "ok", unitPrice: usd(30_000n) }),
      ],
    });
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    expect(result.intent.discountMinorUnits).toBe(3_000n);
  });

  it("refuses when nothing is eligible rather than reserving a zero discount", async () => {
    // Reserving would spend the customer's one use on nothing.
    const b = await benefit();
    const result = await reserve(b.benefitCode, {
      lines: [line({ ineligibleBecause: "group_buy" })],
    });
    expect(result).toMatchObject({ outcome: "refused", refusal: "calculation_refused" });
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(0);
  });
});

describe("single use and concurrency", () => {
  it("a SECOND reservation while one is live is refused", async () => {
    const b = await benefit();
    expect((await reserve(b.benefitCode)).outcome).toBe("reserved");
    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "already_reserved" });
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(1);
  });

  it("CONCURRENT reservations converge on ONE usable redemption", async () => {
    // Both pass every pre-check before either writes; the partial UNIQUE index
    // on (benefit_id) WHERE status='reserved' is what decides it.
    const b = await benefit();
    const [a, c] = await Promise.all([reserve(b.benefitCode), reserve(b.benefitCode)]);
    const outcomes = [a.outcome, c.outcome].sort();
    expect(outcomes).toEqual(["refused", "reserved"]);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "reserved" } })
    ).toBe(1);
  });

  it("a released reservation makes the benefit usable again", async () => {
    const b = await benefit();
    const first = await reserve(b.benefitCode);
    if (first.outcome !== "reserved") throw new Error("expected a reservation");

    const released = await releaseBeatQuoteRedemption({
      intentId: first.intent.id,
      reason: "abandoned",
      detail: "checkout not completed within the window",
      now: DURING,
    });
    expect(released.released).toBe(true);

    const second = await reserve(b.benefitCode);
    expect(second.outcome).toBe("reserved");
    // Two intents exist as history, but only one is live.
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id } })).toBe(2);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "reserved" } })
    ).toBe(1);
  });

  it("a COMPLETED redemption cannot be released back into usability", async () => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");
    await complete(r.intent.id, b.benefitCode);

    const released = await releaseBeatQuoteRedemption({
      intentId: r.intent.id,
      reason: "staff_released",
      detail: "attempted",
      now: DURING,
    });
    // The conditional WHERE refuses it, and the trigger would too.
    expect(released.released).toBe(false);
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "status" = 'released', "released_at" = now(), "release_reason" = 'forced' WHERE "id" = ${r.intent.id}::uuid`
    ).rejects.toThrow(/terminal/i);
  });
});

/** Completes a reservation with an order that matches it exactly. */
async function complete(intentId: string, _code: string, overrides: Record<string, unknown> = {}) {
  const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
  return verifyAndCompleteBeatQuoteRedemption({
    intentId,
    orderGid: `gid://shopify/Order/${uniq()}`,
    orderCustomerRef: intent.customerRef,
    observedDiscountMinorUnits: intent.discountMinorUnits,
    observedCurrency: intent.currency,
    otherPromotionOnOrder: false,
    containsExcludedMerchandise: false,
    now: DURING,
    ...overrides,
  });
}

describe("order-time verification", () => {
  it("COMPLETES when everything agrees, and spends the benefit exactly once", async () => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");
    await attachRedemptionDraftOrder({ intentId: r.intent.id, draftOrderGid: `gid://shopify/DraftOrder/${uniq()}` });

    const result = await complete(r.intent.id, b.benefitCode);
    expect(result.outcome).toBe("completed");

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.redeemedAt).not.toBeNull();
    expect(after.redemptionDiscountMinorUnits).toBe(r.intent.discountMinorUnits);
    expect(after.redemptionOrderRef).not.toBeNull();
  });

  it("DUPLICATE order delivery does not redeem twice", async () => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: r.intent.id } });
    const orderGid = `gid://shopify/Order/${uniq()}`;
    const delivery = () =>
      verifyAndCompleteBeatQuoteRedemption({
        intentId: r.intent.id,
        orderGid,
        orderCustomerRef: intent.customerRef,
        observedDiscountMinorUnits: intent.discountMinorUnits,
        observedCurrency: intent.currency,
        otherPromotionOnOrder: false,
        containsExcludedMerchandise: false,
        now: DURING,
      });

    expect((await delivery()).outcome).toBe("completed");
    expect((await delivery()).outcome).toBe("already_completed");
    expect((await delivery()).outcome).toBe("already_completed");

    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "completed" } })
    ).toBe(1);
  });

  it("CONCURRENT deliveries of the same order complete exactly once", async () => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");
    const orderGid = `gid://shopify/Order/${uniq()}`;
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: r.intent.id } });
    const delivery = () =>
      verifyAndCompleteBeatQuoteRedemption({
        intentId: r.intent.id,
        orderGid,
        orderCustomerRef: intent.customerRef,
        observedDiscountMinorUnits: intent.discountMinorUnits,
        observedCurrency: intent.currency,
        otherPromotionOnOrder: false,
        containsExcludedMerchandise: false,
        now: DURING,
      });

    const results = await Promise.all([delivery(), delivery()]);
    expect(results.map((r2) => r2.outcome).sort()).toEqual(["already_completed", "completed"]);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "completed" } })
    ).toBe(1);
  });
});

describe("any mismatch fails closed to STAFF REVIEW, never to redeemed", () => {
  it.each([
    [
      "the discount does not equal what we reserved",
      { observedDiscountMinorUnits: 9_999n },
      /does not equal the reserved/i,
    ],
    [
      "the order is attached to another customer",
      { orderCustomerRef: OTHER_CUSTOMER },
      /is not the reserving customer/i,
    ],
    ["the currency differs", { observedCurrency: "CAD" }, /currency/i],
    [
      "the order contains excluded merchandise",
      { containsExcludedMerchandise: true },
      /Group Buy or Luxury Steals/i,
    ],
    [
      "the order carries another promotion",
      { otherPromotionOnOrder: true },
      /another promotional discount/i,
    ],
    [
      "the benefit expired before the order completed",
      { now: new Date("2027-06-01T00:00:00.000Z") },
      /expired/i,
    ],
  ])("%s", async (_label, overrides, pattern) => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");

    const result = await complete(r.intent.id, b.benefitCode, overrides);
    expect(result.outcome).toBe("failed_review");
    if (result.outcome === "failed_review") expect(result.reason).toMatch(pattern);

    // NOT redeemed — a wrong discount must not consume the customer's one use.
    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.redeemedAt).toBeNull();
    // AND NOT released either: the order may already have been honoured, so
    // handing the benefit back would be the other way to be wrong.
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: r.intent.id } });
    expect(intent.status).toBe("failed_review");
    expect(intent.reviewReason).toBeTruthy();
    // The order is still recorded, so a reviewer can find it.
    expect(intent.orderGid).not.toBeNull();
  });

  it("reports EVERY mismatch, not just the first", async () => {
    // A reviewer needs the whole picture; fixing one problem and rediscovering
    // the next is how a review takes three passes.
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");

    const result = await complete(r.intent.id, b.benefitCode, {
      observedDiscountMinorUnits: 1n,
      orderCustomerRef: OTHER_CUSTOMER,
      containsExcludedMerchandise: true,
    });
    expect(result.outcome).toBe("failed_review");
    if (result.outcome !== "failed_review") return;
    expect(result.reason).toMatch(/does not equal the reserved/i);
    expect(result.reason).toMatch(/is not the reserving customer/i);
    expect(result.reason).toMatch(/Group Buy or Luxury Steals/i);
  });
});

describe("the reserved calculation is immutable", () => {
  it("REFUSES editing the discount, the subtotal or the frozen lines", async () => {
    // Order-time verification compares against it; a mutable expectation
    // verifies nothing.
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");

    for (const sql of [
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "discount_minor_units" = 1 WHERE "id" = ${r.intent.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "eligible_subtotal_minor_units" = 1 WHERE "id" = ${r.intent.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "customer_ref" = ${OTHER_CUSTOMER} WHERE "id" = ${r.intent.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "benefit_expires_at" = now() + interval '1 year' WHERE "id" = ${r.intent.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "eligible_lines" = '[]'::jsonb WHERE "id" = ${r.intent.id}::uuid`,
    ]) {
      await expect(sql).rejects.toThrow(/immutable/i);
    }
  });

  it("REFUSES a discount above the benefit's own cap, even by direct SQL", async () => {
    const b = await benefit();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "beat_quote_redemption_intent"
          ("id","benefit_id","customer_ref","surface","eligible_subtotal_minor_units","discount_minor_units",
           "currency","benefit_max_discount_minor_units","benefit_expires_at","eligible_lines")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${CUSTOMER}, 'buy_now', 500000, 10001, 'USD', 10000, now(), '[]'::jsonb)`
    ).rejects.toThrow(/amounts_sane/i);
  });

  it("REFUSES a discount larger than the merchandise it discounts", async () => {
    const b = await benefit();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "beat_quote_redemption_intent"
          ("id","benefit_id","customer_ref","surface","eligible_subtotal_minor_units","discount_minor_units",
           "currency","benefit_max_discount_minor_units","benefit_expires_at","eligible_lines")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${CUSTOMER}, 'buy_now', 500, 1000, 'USD', 10000, now(), '[]'::jsonb)`
    ).rejects.toThrow(/amounts_sane/i);
  });

  it("REFUSES deleting an intent — a reservation that should not have happened is RELEASED", async () => {
    const b = await benefit();
    const r = await reserve(b.benefitCode);
    if (r.outcome !== "reserved") throw new Error("expected a reservation");
    await expect(
      prisma.$executeRaw`DELETE FROM "beat_quote_redemption_intent" WHERE "id" = ${r.intent.id}::uuid`
    ).rejects.toThrow(/append-only/i);
  });
});
