import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { findReleasableHoldForSubmission } from "~/db/repositories/beatQuoteReviewRepository.server";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";
import type { RedemptionLineInput } from "~/domain/beatyourquote/redemptionCalculation";
import { Money } from "~/domain/money/money";
import {
  attachBankPaymentOrderToRedemption,
  redeemBankPaymentRedemptionOnVerifiedFunds,
  releaseBankPaymentRedemptionOnCancellation,
  type PaymentOutcome,
} from "~/jobs/beatyourquote/bankPaymentRedemption.server";
import { reserveBeatQuoteRedemption } from "~/jobs/beatyourquote/redeemFallbackBenefit.server";
import { staffReleaseRedemptionHold } from "~/jobs/beatyourquote/staffReleaseRedemption.server";
import type { CancelDraftOrderInput, DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * The fallback benefit on a Bank Payment order, and the staff release control
 * (owner decision 2026-10-11).
 *
 * ============================================================================
 * WHAT IS ACTUALLY AT RISK HERE
 * ============================================================================
 * A Bank Payment order is not paid by Shopify — the money moves outside it and
 * a human verifies the transfer. So the benefit is held across a window that
 * can last days, ended by a staff action, a cancellation, or nothing at all.
 * Every failure mode in that window costs the same thing: one benefit funding
 * two purchases, or a customer losing a benefit they never got to use.
 *
 * The owner's named cases are each the title of the test that proves them.
 */

const CUSTOMER = "gid://shopify/Customer/4242";
const ISSUED_AT = new Date("2026-10-11T12:00:00.000Z");
const DURING = new Date("2026-11-01T12:00:00.000Z");
const STAFF = "staff:gid://shopify/StaffMember/77";

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

function line(overrides: Partial<RedemptionLineInput> = {}): RedemptionLineInput {
  return {
    reference: `gid://shopify/ProductVariant/${uniq()}`,
    quantity: 1,
    unitPrice: usd(47_620n),
    ineligibleBecause: null,
    ...overrides,
  };
}

async function benefit(overrides: { expiresAt?: Date } = {}) {
  const submission = await prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-BK-${uniq()}`,
      customerRef: CUSTOMER,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-bk-${uniq()}@example.com`,
      kind: "custom_quote",
      quoteIssuedOn: new Date("2026-10-06T00:00:00.000Z"),
      submittedOn: new Date("2026-10-10T00:00:00.000Z"),
      submittedAt: new Date("2026-10-10T15:00:00.000Z"),
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
  const created = await prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId: submission.id,
      benefitCode: `BQ10-BK-${uniq()}`,
      customerRef: CUSTOMER,
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt: ISSUED_AT,
      expiresAt: overrides.expiresAt ?? fallbackExpiresAt(ISSUED_AT),
      issuedByActorType: "staff",
      issuedByActorRef: "staff:reviewer",
    },
  });
  return Object.assign(created, { submissionId: submission.id });
}

/** A bank payment order row, minimal but real. */
async function bankOrder(): Promise<string> {
  const row = await prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/bk-${uniq()}`,
      customerEmail: `ada-bk-${uniq()}@example.com`,
      customerGid: CUSTOMER,
      quotedAt: DURING,
      guaranteeExpiresAt: new Date(DURING.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  return row.id;
}

function reserve(
  code: string,
  overrides: Record<string, unknown> = {}
) {
  return reserveBeatQuoteRedemption({
    benefitCode: code,
    customerRef: CUSTOMER,
    surface: "buy_now",
    paymentBasis: "bank_payment",
    lines: [line()],
    otherPromotionApplied: false,
    stackingExpresslyAuthorized: false,
    now: DURING,
    ...overrides,
  } as Parameters<typeof reserveBeatQuoteRedemption>[0]);
}

/** A reserved bank redemption with its order attached — the normal starting state. */
async function reservedBankRedemption(overrides: { expiresAt?: Date } = {}) {
  const b = await benefit(overrides);
  const result = await reserve(b.benefitCode);
  if (result.outcome !== "reserved") throw new Error(`expected a reservation, got ${JSON.stringify(result)}`);
  const orderId = await bankOrder();
  const attached = await attachBankPaymentOrderToRedemption({
    intentId: result.intent.id,
    bankPaymentOrderId: orderId,
  });
  expect(attached.outcome).toBe("attached");
  return { benefit: b, intentId: result.intent.id, bankPaymentOrderId: orderId, intent: result.intent };
}

function verify(bankPaymentOrderId: string, at: Date = DURING) {
  return prisma.$transaction((tx) =>
    redeemBankPaymentRedemptionOnVerifiedFunds(tx, {
      bankPaymentOrderId,
      verifiedAt: at,
      verifiedByActorRef: STAFF,
    })
  );
}

function cancel(bankPaymentOrderId: string, paymentOutcome: PaymentOutcome, now: Date = DURING) {
  return releaseBankPaymentRedemptionOnCancellation({
    bankPaymentOrderId,
    paymentOutcome,
    cancellationReason: "unpaid after the payment window",
    actorRef: "job:bank-payment-guarantee-sweep",
    now,
  });
}

/** A draft-order port that records cancellations, and can be made to fail. */
function cancellingPort(options: { fail?: boolean; confirmDifferentId?: string } = {}): DraftOrderPort & {
  cancelled: string[];
} {
  const cancelled: string[] = [];
  return {
    cancelled,
    async cancelDraftOrder(input: CancelDraftOrderInput) {
      if (options.fail) throw new Error("Shopify said no");
      cancelled.push(input.draftOrderGid);
      return {
        cancelledDraftOrderGid: options.confirmDifferentId ?? input.draftOrderGid,
      };
    },
    // The Custom Jewelry final-purchase path. Refused rather than stubbed
    // permissively: no Bank Payment, Group Buy, redemption or deposit flow
    // should ever create a custom jewelry draft order, so a call here is a
    // defect worth failing on.
    async createCustomJewelryDraftOrder(): Promise<never> {
      throw new Error("createCustomJewelryDraftOrder is not expected in this test");
    },
    async createRedemptionDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async createServiceDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("not expected");
    },
    async completeDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
  };
}

// ============================================================================
// THE BASIS
// ============================================================================

describe("the benefit is calculated on the basis the customer chose", () => {
  it("a BANK reservation freezes the bank subtotal and records the basis", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { lines: [line({ unitPrice: usd(47_620n) })] });
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved") return;
    expect(result.intent.paymentBasis).toBe("bank_payment");
    expect(result.intent.eligibleSubtotalMinorUnits).toBe(47_620n);
    expect(result.intent.discountMinorUnits).toBe(4_762n);
  });

  it("a CARD reservation on the same goods freezes the card subtotal", async () => {
    const b = await benefit();
    const result = await reserve(b.benefitCode, {
      paymentBasis: "card",
      lines: [line({ unitPrice: usd(50_000n) })],
    });
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    expect(result.intent.paymentBasis).toBe("card");
    expect(result.intent.discountMinorUnits).toBe(5_000n);
  });

  it("both bases remain capped at the benefit's maximum", async () => {
    for (const paymentBasis of ["card", "bank_payment"] as const) {
      const b = await benefit();
      const result = await reserve(b.benefitCode, {
        paymentBasis,
        lines: [line({ unitPrice: usd(900_000n) })],
      });
      if (result.outcome !== "reserved") throw new Error("expected a reservation");
      expect(result.intent.discountMinorUnits, paymentBasis).toBe(10_000n);
    }
  });

  it("the DATABASE refuses a card intent that names a bank payment order", async () => {
    // Unrepresentable rather than merely avoided: a card redemption has no
    // bank order, and a row claiming both would be audited against the wrong
    // subtotal.
    const b = await benefit();
    const orderId = await bankOrder();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "beat_quote_redemption_intent"
          ("id","benefit_id","customer_ref","surface","payment_basis","bank_payment_order_id",
           "eligible_subtotal_minor_units","discount_minor_units","currency",
           "benefit_max_discount_minor_units","benefit_expires_at","eligible_lines")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${CUSTOMER}, 'buy_now', 'card', ${orderId}::uuid,
                50000, 5000, 'USD', 10000, now() + interval '30 days', '[]'::jsonb)`
    ).rejects.toThrow(/basis_coherent/i);
  });

  it("the DATABASE refuses re-pointing a reservation at a different bank order", async () => {
    const { intentId } = await reservedBankRedemption();
    const other = await bankOrder();
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "bank_payment_order_id" = ${other}::uuid WHERE "id" = ${intentId}::uuid`
    ).rejects.toThrow(/immutable/i);
  });

  it("the DATABASE refuses changing the frozen basis", async () => {
    const { intentId } = await reservedBankRedemption();
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "payment_basis" = 'card' WHERE "id" = ${intentId}::uuid`
    ).rejects.toThrow(/immutable/i);
  });
});

// ============================================================================
// RESERVE, THEN REDEEM ON VERIFIED FUNDS
// ============================================================================

describe("a bank order reserves but does NOT redeem", () => {
  it("leaves the benefit unspent at order creation", async () => {
    // The owner's instruction, asserted directly: the benefit becomes redeemed
    // only when the payment is actually received and manually verified.
    const { benefit: b, intentId } = await reservedBankRedemption();

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.redeemedAt).toBeNull();
    expect(after.redemptionOrderRef).toBeNull();
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("reserved");
  });

  it("prevents a SECOND reservation while the bank hold is live", async () => {
    const { benefit: b } = await reservedBankRedemption();
    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "already_reserved" });
  });

  it("CONCURRENT BANK AND CARD attempts cannot consume the same benefit twice", async () => {
    // The owner's named case. Both paths create an intent against the same
    // benefit, so the single active-hold index is what decides it — whichever
    // basis each attempt chose.
    const b = await benefit();
    const [bank, card] = await Promise.all([
      reserve(b.benefitCode, { paymentBasis: "bank_payment", lines: [line({ unitPrice: usd(47_620n) })] }),
      reserve(b.benefitCode, { paymentBasis: "card", lines: [line({ unitPrice: usd(50_000n) })] }),
    ]);
    expect([bank.outcome, card.outcome].sort()).toEqual(["refused", "reserved"]);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({
        where: { benefitId: b.id, status: { in: ["reserved", "failed_review"] } },
      })
    ).toBe(1);
  });
});

describe("manual payment verification redeems exactly once", () => {
  it("redeems on verified funds", async () => {
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();

    const result = await verify(bankPaymentOrderId);
    expect(result.outcome).toBe("redeemed");

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.redeemedAt).not.toBeNull();
    expect(after.redemptionDiscountMinorUnits).toBe(4_762n);
    expect(after.redemptionOrderRef).toBe(`bank_payment_order:${bankPaymentOrderId}`);
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("completed");
  });

  it("a SECOND verification writes nothing", async () => {
    const { benefit: b, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await verify(bankPaymentOrderId)).outcome).toBe("redeemed");
    const firstRedeemedAt = (
      await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })
    ).redeemedAt;

    expect((await verify(bankPaymentOrderId)).outcome).toBe("already_redeemed");
    expect((await verify(bankPaymentOrderId)).outcome).toBe("already_redeemed");

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.redeemedAt?.toISOString()).toBe(firstRedeemedAt?.toISOString());
  });

  it("CONCURRENT verifications redeem exactly once", async () => {
    const { benefit: b, bankPaymentOrderId } = await reservedBankRedemption();
    const results = await Promise.all([verify(bankPaymentOrderId), verify(bankPaymentOrderId)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_redeemed", "redeemed"]);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "completed" } })
    ).toBe(1);
  });

  it("IGNORES a bank order with no benefit on it", async () => {
    // Every ordinary Bank Payment order takes this path.
    expect((await verify(await bankOrder())).outcome).toBe("no_redemption");
  });

  it("HOLDS FOR REVIEW when funds are verified at or after expiry", async () => {
    // Not refused outright: the bank record's own value date decides whether
    // the transfer was in time, and only a person can read it. Judging a bank
    // payment more harshly than a card one would be the wrong way round.
    const { benefit: b, intentId } = await reservedBankRedemption({
      expiresAt: new Date("2026-11-05T00:00:00.000Z"),
    });
    const result = await verify(
      (await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } }))
        .bankPaymentOrderId!,
      new Date("2026-12-01T00:00:00.000Z")
    );
    expect(result.outcome).toBe("held_for_review");

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("failed_review");
    expect(intent.reviewReason).toMatch(/value date/i);
    // Not redeemed, and not released either.
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).toBeNull();
  });
});

// ============================================================================
// UNPAID CANCELLATION
// ============================================================================

describe("unpaid cancellation releases the reservation", () => {
  it("releases on CONFIRMED non-receipt", async () => {
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();

    const result = await cancel(bankPaymentOrderId, "confirmed_not_received");
    expect(result.outcome).toBe("released");

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("released");
    expect(intent.releaseReason).toMatch(/unpaid_cancellation/);
    // The benefit was never spent.
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).toBeNull();
  });

  it("the released benefit is USABLE AGAIN, and recalculates for the new order", async () => {
    // The owner's instruction: a cancelled bank order does not permanently
    // freeze the benefit calculation. A new eligible order recalculates against
    // its own current subtotal.
    const { benefit: b, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await cancel(bankPaymentOrderId, "confirmed_not_received")).outcome).toBe("released");

    // A different cart, at a different price.
    const second = await reserve(b.benefitCode, { lines: [line({ unitPrice: usd(80_000n) })] });
    expect(second.outcome).toBe("reserved");
    if (second.outcome !== "reserved") return;
    // Recalculated — NOT the $47.62 the first reservation froze.
    expect(second.intent.discountMinorUnits).toBe(8_000n);
    expect(second.intent.eligibleSubtotalMinorUnits).toBe(80_000n);
  });

  it("the released benefit RETAINS ITS ORIGINAL EXPIRATION", async () => {
    // The 90-day clock is not restarted or extended by a release. Asserted on
    // the benefit row itself, because that is where expiry lives and where a
    // bug would show.
    const b = await benefit();
    const originalExpiry = b.expiresAt;
    const result = await reserve(b.benefitCode);
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    const orderId = await bankOrder();
    await attachBankPaymentOrderToRedemption({ intentId: result.intent.id, bankPaymentOrderId: orderId });

    const released = await cancel(orderId, "confirmed_not_received", new Date("2026-12-20T00:00:00.000Z"));
    expect(released.outcome).toBe("released");
    if (released.outcome === "released") {
      expect(released.benefitExpiresAt.toISOString()).toBe(originalExpiry.toISOString());
    }

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.expiresAt.toISOString()).toBe(originalExpiry.toISOString());
  });

  it("a benefit that EXPIRED WHILE RESERVED comes back expired", async () => {
    // Releasing restores availability, not validity. The result says so out
    // loud so staff do not promise a customer a second go the benefit will
    // refuse.
    const b = await benefit({ expiresAt: new Date("2026-11-10T00:00:00.000Z") });
    const result = await reserve(b.benefitCode);
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    const orderId = await bankOrder();
    await attachBankPaymentOrderToRedemption({ intentId: result.intent.id, bankPaymentOrderId: orderId });

    const released = await cancel(orderId, "confirmed_not_received", new Date("2026-12-01T00:00:00.000Z"));
    expect(released.outcome).toBe("released");
    if (released.outcome === "released") expect(released.benefitExpiredWhileReserved).toBe(true);

    // And a fresh attempt is refused as expired — the release did not revive it.
    expect(await reserve(b.benefitCode, { now: new Date("2026-12-01T00:00:00.000Z") })).toMatchObject({
      outcome: "refused",
      refusal: "expired",
    });
  });

  it("REFUSES to un-redeem a completed redemption", async () => {
    const { intentId, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await verify(bankPaymentOrderId)).outcome).toBe("redeemed");

    const result = await cancel(bankPaymentOrderId, "confirmed_not_received");
    expect(result.outcome).toBe("refused_completed");
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("completed");
  });

  it("is idempotent across repeated cancellations", async () => {
    const { bankPaymentOrderId } = await reservedBankRedemption();
    expect((await cancel(bankPaymentOrderId, "confirmed_not_received")).outcome).toBe("released");
    expect((await cancel(bankPaymentOrderId, "confirmed_not_received")).outcome).toBe("already_released");
  });
});

describe("AMBIGUOUS payment blocks release", () => {
  it.each(["uncertain", "confirmed_received"] as const)(
    "does NOT release on a %s payment outcome",
    async (paymentOutcome) => {
      // The owner's rule: only positive confirmation that payment was not
      // received releases. Everything else routes to a person, with the
      // benefit still held.
      const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();

      const result = await cancel(bankPaymentOrderId, paymentOutcome);
      expect(result.outcome).toBe("held_for_review");

      const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(intent.status).toBe("failed_review");
      expect(intent.reviewReason).toMatch(/not a positive confirmation/i);
      // NOT released — the benefit is still unavailable.
      expect(intent.releasedAt).toBeNull();
      // And still not spent.
      expect(
        (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
      ).toBeNull();
    }
  );

  it("an AMBIGUOUS hold still blocks a second reservation", async () => {
    // THE REASON `failed_review` HAD TO BECOME AN ACTIVE HOLD. If review sat
    // outside the single-hold index, flagging an ambiguous payment would have
    // freed the benefit while its discounted checkout was still payable —
    // exactly the double-use the reservation exists to prevent.
    const { benefit: b, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await cancel(bankPaymentOrderId, "uncertain")).outcome).toBe("held_for_review");

    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "already_reserved" });
  });

  it("the DATABASE refuses a second active hold beside a reviewed one", async () => {
    // Not merely refused by the application: unrepresentable.
    //
    // ASSERTED ON THE UNIQUE VIOLATION ITSELF, not on the index name. Postgres
    // reports a CHECK breach with its constraint name but a unique-index
    // breach only as `23505` plus the duplicated key — so matching the index
    // name here would have failed while the index was working perfectly, which
    // is exactly what the first version of this test did. The key named in the
    // error is what proves it was the per-benefit hold that fired and not some
    // other uniqueness.
    const { benefit: b, bankPaymentOrderId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "uncertain");
    await expect(
      prisma.$executeRaw`
        INSERT INTO "beat_quote_redemption_intent"
          ("id","benefit_id","customer_ref","surface","payment_basis",
           "eligible_subtotal_minor_units","discount_minor_units","currency",
           "benefit_max_discount_minor_units","benefit_expires_at","eligible_lines")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${CUSTOMER}, 'buy_now', 'card',
                50000, 5000, 'USD', 10000, now() + interval '30 days', '[]'::jsonb)`
    ).rejects.toThrow(new RegExp(`23505[\\s\\S]*benefit_id[\\s\\S]*${b.id}`));
  });

  it("but ALLOWS a new hold once the reviewed one is resolved to released", async () => {
    // The counterpart, so the index above is not read as "a review blocks the
    // benefit forever". Resolving a review is what frees it — which is the
    // whole purpose of the staff release control.
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "uncertain");

    await prisma.beatQuoteRedemptionIntent.update({
      where: { id: intentId },
      data: {
        status: "released",
        releasedAt: DURING,
        releaseReason: "staff_released: resolved after reconciling the bank record",
        releasedByActorRef: STAFF,
      },
    });

    expect((await reserve(b.benefitCode)).outcome).toBe("reserved");
  });

  it("verification does NOT pre-empt a reservation under review", async () => {
    const { bankPaymentOrderId, intentId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "uncertain");

    const result = await verify(bankPaymentOrderId);
    expect(result.outcome).toBe("held_for_review");
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("failed_review");
  });
});

describe("a LATE PAYMENT after release goes to reconciliation", () => {
  it("does not resurrect the reservation or consume the benefit", async () => {
    // Owner decision, verbatim in substance. The benefit may already have been
    // re-reserved or spent elsewhere; consuming it here could take it twice,
    // and resurrecting this intent could hand out two discounts.
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await cancel(bankPaymentOrderId, "confirmed_not_received")).outcome).toBe("released");

    const result = await verify(bankPaymentOrderId, new Date("2026-11-15T00:00:00.000Z"));
    expect(result.outcome).toBe("reconciliation_required");
    if (result.outcome === "reconciliation_required") {
      expect(result.reason).toMatch(/already been released/i);
    }

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    // STILL RELEASED. Not resurrected.
    expect(intent.status).toBe("released");
    expect(intent.reconciliationRequiredAt).not.toBeNull();
    expect(intent.reconciliationReason).toMatch(/Reconcile the order and the payment/i);
    // NOT consumed.
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).toBeNull();
  });

  it("records the discrepancy ONCE — a second late payment does not erase the first", async () => {
    const { intentId, bankPaymentOrderId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "confirmed_not_received");

    await verify(bankPaymentOrderId, new Date("2026-11-15T00:00:00.000Z"));
    const first = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });

    await verify(bankPaymentOrderId, new Date("2026-11-20T00:00:00.000Z"));
    const second = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(second.reconciliationRequiredAt?.toISOString()).toBe(
      first.reconciliationRequiredAt?.toISOString()
    );
  });

  it("the DATABASE refuses overwriting a recorded reconciliation", async () => {
    const { intentId, bankPaymentOrderId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "confirmed_not_received");
    await verify(bankPaymentOrderId, new Date("2026-11-15T00:00:00.000Z"));

    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_redemption_intent" SET "reconciliation_reason" = 'nothing to see here' WHERE "id" = ${intentId}::uuid`
    ).rejects.toThrow(/recorded once/i);
  });

  it("a late payment on a benefit RE-USED elsewhere leaves both records intact", async () => {
    // The worst case the rule exists for, spelled out: released, re-reserved on
    // a new order, redeemed there — and then the old transfer lands.
    const { benefit: b, bankPaymentOrderId: firstOrder } = await reservedBankRedemption();
    await cancel(firstOrder, "confirmed_not_received");

    const second = await reserve(b.benefitCode);
    if (second.outcome !== "reserved") throw new Error("expected a second reservation");
    const secondOrder = await bankOrder();
    await attachBankPaymentOrderToRedemption({
      intentId: second.intent.id,
      bankPaymentOrderId: secondOrder,
    });
    expect((await verify(secondOrder)).outcome).toBe("redeemed");

    // Now the first order's money turns up.
    const late = await verify(firstOrder, new Date("2026-11-20T00:00:00.000Z"));
    expect(late.outcome).toBe("reconciliation_required");

    // The legitimate redemption stands, untouched.
    const benefitRow = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(benefitRow.redemptionOrderRef).toBe(`bank_payment_order:${secondOrder}`);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: b.id, status: "completed" } })
    ).toBe(1);
  });
});

// ============================================================================
// THE STAFF RELEASE CONTROL
// ============================================================================

describe("staff release — Shopify first, database second", () => {
  async function cardHold() {
    const b = await benefit();
    const result = await reserve(b.benefitCode, { paymentBasis: "card", lines: [line({ unitPrice: usd(50_000n) })] });
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    const draftOrderGid = `gid://shopify/DraftOrder/staff-${uniq()}`;
    await prisma.beatQuoteRedemptionIntent.update({
      where: { id: result.intent.id },
      data: { draftOrderGid },
    });
    return { benefit: b, intentId: result.intent.id, draftOrderGid };
  }

  function release(intentId: string, port: DraftOrderPort, overrides: Record<string, unknown> = {}) {
    return staffReleaseRedemptionHold({
      intentId,
      reason: "customer abandoned the checkout and confirmed by email they never sent a transfer",
      actorRef: STAFF,
      paymentConfirmedNotReceived: true,
      draftOrderPort: port,
      now: DURING,
      ...overrides,
    } as Parameters<typeof staffReleaseRedemptionHold>[0]);
  }

  it("CANCELS the Shopify draft order BEFORE releasing", async () => {
    const { intentId, draftOrderGid } = await cardHold();
    const port = cancellingPort();

    const result = await release(intentId, port);
    expect(result.outcome).toBe("released");
    expect(port.cancelled).toEqual([draftOrderGid]);

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("released");
    expect(intent.releasedByActorRef).toBe(STAFF);
    expect(intent.releaseShopifyRef).toBe(`draft_order_deleted:${draftOrderGid}`);
    expect(intent.releaseReason).toMatch(/staff_released: customer abandoned/);
  });

  it("KEEPS THE BENEFIT RESERVED when Shopify cancellation fails", async () => {
    // The owner's central requirement, and the case worth the most: do not make
    // the benefit available while an old discounted checkout can still be paid.
    const { benefit: b, intentId } = await cardHold();

    const result = await release(intentId, cancellingPort({ fail: true }));
    expect(result).toMatchObject({ outcome: "refused", refusal: "shopify_invalidation_failed" });

    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).not.toBe("released");
    expect(intent.releasedAt).toBeNull();
    // Flagged for a person rather than silently retried.
    expect(intent.status).toBe("failed_review");
    expect(intent.reviewReason).toMatch(/must not become available while that checkout/i);
    // AND the benefit is still unavailable to a new reservation.
    expect(await reserve(b.benefitCode)).toMatchObject({ outcome: "refused", refusal: "already_reserved" });
  });

  it("KEEPS THE BENEFIT RESERVED when Shopify confirms a DIFFERENT object", async () => {
    // Not merely "did not throw": the confirmation has to be about the object
    // we asked about.
    const { intentId } = await cardHold();
    const result = await release(
      intentId,
      cancellingPort({ confirmDifferentId: "gid://shopify/DraftOrder/somebody-else" })
    );
    expect(result).toMatchObject({ outcome: "refused", refusal: "shopify_invalidation_failed" });
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.releasedAt).toBeNull();
  });

  it("REQUIRES a non-empty reason, before touching Shopify", async () => {
    const { intentId } = await cardHold();
    const port = cancellingPort();
    for (const reason of ["", "   ", "\n\t"]) {
      const result = await release(intentId, port, { reason });
      expect(result).toMatchObject({ outcome: "refused", refusal: "reason_required" });
    }
    expect(port.cancelled).toEqual([]);
  });

  it("REQUIRES positive confirmation that payment was not received", async () => {
    const { intentId } = await cardHold();
    const port = cancellingPort();

    const result = await release(intentId, port, { paymentConfirmedNotReceived: false });
    expect(result).toMatchObject({ outcome: "refused", refusal: "payment_not_confirmed_absent" });
    // Shopify was never asked: an ambiguous payment is refused before any
    // irreversible action.
    expect(port.cancelled).toEqual([]);
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.releasedAt).toBeNull();
  });

  it("REFUSES to release a COMPLETED redemption", async () => {
    const { intentId, bankPaymentOrderId } = await reservedBankRedemption();
    expect((await verify(bankPaymentOrderId)).outcome).toBe("redeemed");
    const port = cancellingPort();

    const result = await release(intentId, port);
    expect(result).toMatchObject({ outcome: "refused", refusal: "already_redeemed" });
    expect(port.cancelled).toEqual([]);
    const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("completed");
  });

  it("is IDEMPOTENT — a double-click writes nothing the second time", async () => {
    const { intentId } = await cardHold();
    const port = cancellingPort();

    expect((await release(intentId, port)).outcome).toBe("released");
    const first = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });

    expect((await release(intentId, port)).outcome).toBe("already_released");
    const second = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });

    // The release is not re-stamped: who released it and when must not be
    // rewritten by somebody clicking again.
    expect(second.releasedAt?.toISOString()).toBe(first.releasedAt?.toISOString());
    expect(second.releaseReason).toBe(first.releaseReason);
    // And Shopify was not asked to cancel an already-cancelled draft.
    expect(port.cancelled).toHaveLength(1);
  });

  it("RELEASES a hold that never reached draft-order creation, and says so", async () => {
    // No payable object exists, so nothing can complete with the benefit. The
    // recorded reference states that explicitly rather than leaving a blank
    // that reads like a skipped step.
    const b = await benefit();
    const result = await reserve(b.benefitCode, { paymentBasis: "card" });
    if (result.outcome !== "reserved") throw new Error("expected a reservation");
    const port = cancellingPort();

    const released = await release(result.intent.id, port);
    expect(released.outcome).toBe("released");
    if (released.outcome === "released") expect(released.shopifyRef).toMatch(/no_payable_object/);
    expect(port.cancelled).toEqual([]);
  });

  it("can release a reservation that is under REVIEW", async () => {
    // Review is an active hold, so it is exactly what this control exists to
    // resolve — and it still goes through the full Shopify-first sequence.
    const { intentId } = await cardHold();
    await prisma.beatQuoteRedemptionIntent.update({
      where: { id: intentId },
      data: { status: "failed_review", reviewReason: "payment outcome was uncertain" },
    });

    const result = await release(intentId, cancellingPort());
    expect(result.outcome).toBe("released");
  });

  it("the released benefit becomes usable again, with its ORIGINAL expiry", async () => {
    const { benefit: b, intentId } = await cardHold();
    expect((await release(intentId, cancellingPort())).outcome).toBe("released");

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.expiresAt.toISOString()).toBe(b.expiresAt.toISOString());
    expect((await reserve(b.benefitCode)).outcome).toBe("reserved");
  });

  it("refuses an intent that does not exist", async () => {
    const result = await release(randomUUID(), cancellingPort());
    expect(result).toMatchObject({ outcome: "refused", refusal: "intent_not_found" });
  });
});

describe("a hold belongs to exactly one submission", () => {
  it("REFUSES a hold from a DIFFERENT submission", async () => {
    // The staff detail route is keyed on a submission; its release form posts
    // an intent id. Without this check a staff member viewing one submission
    // could release someone else's hold by editing a hidden field — freeing a
    // benefit while its discounted checkout is still payable.
    const mine = await benefit();
    const theirs = await benefit();
    const theirHold = await reserve(theirs.benefitCode);
    if (theirHold.outcome !== "reserved") throw new Error("expected a reservation");

    const found = await findReleasableHoldForSubmission({
      submissionId: mine.submissionId,
      redemptionIntentId: theirHold.intent.id,
    });
    expect(found).toBeNull();
  });

  it("FINDS a hold that does belong to the submission", async () => {
    const b = await benefit();
    const hold = await reserve(b.benefitCode);
    if (hold.outcome !== "reserved") throw new Error("expected a reservation");

    const found = await findReleasableHoldForSubmission({
      submissionId: b.submissionId,
      redemptionIntentId: hold.intent.id,
    });
    expect(found?.id).toBe(hold.intent.id);
    expect(found?.status).toBe("reserved");
  });

  it("FINDS a hold under review — that is what the control is for", async () => {
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();
    await cancel(bankPaymentOrderId, "uncertain");

    const found = await findReleasableHoldForSubmission({
      submissionId: b.submissionId,
      redemptionIntentId: intentId,
    });
    expect(found?.status).toBe("failed_review");
  });

  it.each(["completed", "released"] as const)("does NOT find a %s hold", async (finalStatus) => {
    // Offering a release beside a finished redemption invites a click the
    // service correctly refuses, turning a clear "not yours" into a confusing
    // "already done".
    const { benefit: b, intentId, bankPaymentOrderId } = await reservedBankRedemption();
    if (finalStatus === "completed") {
      await verify(bankPaymentOrderId);
    } else {
      await cancel(bankPaymentOrderId, "confirmed_not_received");
    }

    const found = await findReleasableHoldForSubmission({
      submissionId: b.submissionId,
      redemptionIntentId: intentId,
    });
    expect(found).toBeNull();
  });

  it("refuses an id that is not a redemption intent at all", async () => {
    const b = await benefit();
    expect(
      await findReleasableHoldForSubmission({
        submissionId: b.submissionId,
        redemptionIntentId: randomUUID(),
      })
    ).toBeNull();
  });
});
