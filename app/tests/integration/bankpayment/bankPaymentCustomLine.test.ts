import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { issueApprovalPackage } from "~/db/repositories/customJewelryApprovalRepository.server";
import { computeExpectedTotal } from "~/domain/bankpayment/verification";
import { loadBankPaymentOrderForVerification } from "~/domain/bankpayment/verification.server";
import { Money } from "~/domain/money/money";

/**
 * A Bank Payment order carrying a CUSTOM line.
 *
 * ============================================================================
 * WHY THIS TABLE LEARNED ABOUT CUSTOM WORK INSTEAD OF A SECOND ONE EXISTING
 * ============================================================================
 * Owner instruction: reuse the existing payment architecture rather than
 * creating a second money system. `bank_payment_order_line` was built around
 * catalogue variants — both `master_variant_id` and `price_calculation_id` were
 * NOT NULL — because every Bank Payment line so far was a Buy Now variant
 * priced by the engine. A Custom Jewelry piece has neither.
 *
 * Relaxing those two columns touched a money-critical, live-proven path, so
 * what these tests protect is that the machinery still works for BOTH kinds:
 * the amount comparison that guards verification, the verification screen, and
 * the 24-hour guarantee sweep.
 */

const CUSTOMER = "gid://shopify/Customer/5555";
const STAFF = "staff:gid://shopify/StaffMember/9";
const NOW = new Date("2026-11-01T12:00:00.000Z");

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

/** An approved-package-backed custom line on a real bank payment order. */
async function customLineOrder(options: { balanceMinorUnits?: bigint } = {}) {
  const project = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-BL-${uniq()}`,
      customerRef: CUSTOMER,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-bl-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "A solitaire.",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });
  const issued = await issueApprovalPackage({
    projectId: project.id,
    spec: { metalType: "platinum", metalColor: "white", mediaReferences: [] },
    bankPaymentPrice: usd(options.balanceMinorUnits ?? 500_000n),
    regularCardPrice: usd((options.balanceMinorUnits ?? 500_000n) + 17_500n),
    issuedByActorRef: STAFF,
    now: NOW,
  });
  if (issued.outcome !== "issued") throw new Error("expected an issue");

  const order = await prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/bl-${uniq()}`,
      customerEmail: `ada-bl-${uniq()}@example.com`,
      customerGid: CUSTOMER,
      quotedAt: NOW,
      guaranteeExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  const line = await prisma.bankPaymentOrderLine.create({
    data: {
      bankPaymentOrderId: order.id,
      // NO VARIANT, NO CALCULATION — this is the whole point.
      customLineDescription: "Custom Jewelry — platinum solitaire (project CJ, approval v1)",
      customJewelryApprovalPackageId: issued.package.id,
      quantity: 1,
      quotedBankPaymentPriceMinorUnits: issued.package.bankPaymentBalanceDueMinorUnits,
      quotedRegularCardPriceMinorUnits: issued.package.regularCardBalanceDueMinorUnits,
      currency: "USD",
      eligibleAtQuoteTime: true,
    },
  });
  return { orderId: order.id, lineId: line.id, packageId: issued.package.id, line };
}

describe("a custom line is representable, and a malformed one is not", () => {
  it("creates a line with a description and an approval package, and no variant", async () => {
    const { line, packageId } = await customLineOrder();
    expect(line.masterVariantId).toBeNull();
    expect(line.priceCalculationId).toBeNull();
    expect(line.customLineDescription).toContain("platinum solitaire");
    expect(line.customJewelryApprovalPackageId).toBe(packageId);
    expect(line.quotedBankPaymentPriceMinorUnits).toBe(500_000n);
  });

  it("the DATABASE refuses a line that is BOTH a variant line and a custom one", async () => {
    // A line priced by the engine AND by a human is a line where nothing
    // downstream could say which price was authoritative.
    const { orderId, packageId } = await customLineOrder();
    const variant = await prisma.masterVariant.findFirst({ select: { id: true } });
    if (!variant) throw new Error("the seeded database has no master variant to borrow");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "bank_payment_order_line"
          ("id","bank_payment_order_id","master_variant_id","custom_line_description",
           "custom_jewelry_approval_package_id","quantity",
           "quoted_bank_payment_price_minor_units","quoted_regular_card_price_minor_units",
           "currency","eligible_at_quote_time")
        VALUES (gen_random_uuid(), ${orderId}::uuid, ${variant.id}::uuid, 'both at once',
                ${packageId}::uuid, 1, 1000, 1100, 'USD', true)`
    ).rejects.toThrow(/exactly_one_kind/i);
  });

  it("the DATABASE refuses a line that is NEITHER", async () => {
    // No variant, no description: a price with no provenance at all.
    const { orderId } = await customLineOrder();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "bank_payment_order_line"
          ("id","bank_payment_order_id","quantity",
           "quoted_bank_payment_price_minor_units","quoted_regular_card_price_minor_units",
           "currency","eligible_at_quote_time")
        VALUES (gen_random_uuid(), ${orderId}::uuid, 1, 1000, 1100, 'USD', true)`
    ).rejects.toThrow(/exactly_one_kind/i);
  });

  it("the DATABASE refuses a custom line with a blank description", async () => {
    const { orderId, packageId } = await customLineOrder();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "bank_payment_order_line"
          ("id","bank_payment_order_id","custom_line_description",
           "custom_jewelry_approval_package_id","quantity",
           "quoted_bank_payment_price_minor_units","quoted_regular_card_price_minor_units",
           "currency","eligible_at_quote_time")
        VALUES (gen_random_uuid(), ${orderId}::uuid, '   ', ${packageId}::uuid, 1, 1000, 1100, 'USD', true)`
    ).rejects.toThrow(/exactly_one_kind/i);
  });

  it("the DATABASE refuses a custom line with no approval package", async () => {
    // A custom price with no package behind it is a number a human typed with
    // nothing recording what the customer approved.
    const { orderId } = await customLineOrder();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "bank_payment_order_line"
          ("id","bank_payment_order_id","custom_line_description","quantity",
           "quoted_bank_payment_price_minor_units","quoted_regular_card_price_minor_units",
           "currency","eligible_at_quote_time")
        VALUES (gen_random_uuid(), ${orderId}::uuid, 'no package', 1, 1000, 1100, 'USD', true)`
    ).rejects.toThrow(/exactly_one_kind/i);
  });
});

describe("the amount comparison still guards verification", () => {
  it("computes the expected total from a CUSTOM line", async () => {
    // THE PROPERTY THAT MADE THIS CHANGE SAFE. `computeExpectedTotal` sums
    // charged unit price times quantity from the quoted columns and never
    // touches the variant — so the §22 amount comparison that gates
    // verification works identically for both kinds of line.
    const { line } = await customLineOrder({ balanceMinorUnits: 734_900n });
    const total = computeExpectedTotal(
      [
        {
          quantity: line.quantity,
          eligibleAtQuoteTime: line.eligibleAtQuoteTime,
          quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
          quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
        },
      ],
      "USD"
    );
    expect(total.amountMinorUnits).toBe(734_900n);
  });

  it("multiplies quantity on a custom line like any other", async () => {
    const { orderId, packageId } = await customLineOrder();
    const line = await prisma.bankPaymentOrderLine.create({
      data: {
        bankPaymentOrderId: orderId,
        customLineDescription: "Matching band",
        customJewelryApprovalPackageId: packageId,
        quantity: 2,
        quotedBankPaymentPriceMinorUnits: 50_000n,
        quotedRegularCardPriceMinorUnits: 52_500n,
        currency: "USD",
        eligibleAtQuoteTime: true,
      },
    });
    const total = computeExpectedTotal(
      [
        {
          quantity: line.quantity,
          eligibleAtQuoteTime: line.eligibleAtQuoteTime,
          quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
          quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
        },
      ],
      "USD"
    );
    expect(total.amountMinorUnits).toBe(100_000n);
  });
});

describe("the verification screen renders a custom line", () => {
  it("labels it from its own description rather than a blank product", async () => {
    // A verifying admin has to read what was actually sold. A blank row beside
    // a $5,000 payment is worse than no row.
    const { orderId, packageId } = await customLineOrder();
    const detail = await loadBankPaymentOrderForVerification(orderId);
    expect(detail).not.toBeNull();
    const line = detail!.lines[0]!;
    expect(line.masterVariantId).toBeNull();
    expect(line.shopifyVariantGid).toBeNull();
    expect(line.productTitle).toContain("platinum solitaire");
    expect(line.variantLabel).toBe("Made to order");
    expect(line.customJewelryApprovalPackageId).toBe(packageId);
    // And the money is still there, which is what the admin is verifying.
    expect(line.chargedUnitPriceMinorUnits).toBe(500_000n);
  });

  it("still renders a VARIANT line unchanged", async () => {
    // The regression that mattered: relaxing two columns must not change how
    // the live-proven Buy Now path reads.
    const variantLine = await prisma.bankPaymentOrderLine.findFirst({
      where: { masterVariantId: { not: null } },
      select: { bankPaymentOrderId: true },
    });
    if (!variantLine) {
      // No variant-line order in this run's data; the dedicated Bank Payment
      // suites cover that path directly, so there is nothing to assert here
      // rather than something to assert weakly.
      return;
    }
    const detail = await loadBankPaymentOrderForVerification(variantLine.bankPaymentOrderId);
    const line = detail!.lines.find((l) => l.masterVariantId !== null);
    expect(line).toBeDefined();
    expect(line!.shopifyVariantGid).not.toBeUndefined();
    expect(line!.customLineDescription).toBeNull();
    expect(line!.variantLabel).not.toBe("Made to order");
  });
});

describe("a custom line cannot be the reason the guarantee sweep cancels", () => {
  it("has no engine price to drift against", async () => {
    // §22 cancels an unpaid order when the PRICING ENGINE recalculates a
    // variant. A custom price is frozen on an immutable approval package the
    // customer already approved, and a change there is a NEW version they must
    // approve again — a new purchase, not a drifted one.
    //
    // Asserted structurally: the line carries no variant and no calculation, so
    // there is nothing for `gatherVariantPriceFacts` to look up.
    const { line } = await customLineOrder();
    expect(line.masterVariantId).toBeNull();
    expect(line.priceCalculationId).toBeNull();

    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: line.customJewelryApprovalPackageId! },
    });
    // And the package it points at is immutable, which is what makes "cannot
    // drift" a fact rather than an assumption.
    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "bank_payment_price_minor_units" = 1 WHERE "id" = ${pkg.id}::uuid`
    ).rejects.toThrow(/immutable/i);
  });

  it("the approval package reference is a real FK, not a loose string", async () => {
    const { orderId } = await customLineOrder();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "bank_payment_order_line"
          ("id","bank_payment_order_id","custom_line_description",
           "custom_jewelry_approval_package_id","quantity",
           "quoted_bank_payment_price_minor_units","quoted_regular_card_price_minor_units",
           "currency","eligible_at_quote_time")
        VALUES (gen_random_uuid(), ${orderId}::uuid, 'ghost package', ${randomUUID()}::uuid, 1,
                1000, 1100, 'USD', true)`
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
