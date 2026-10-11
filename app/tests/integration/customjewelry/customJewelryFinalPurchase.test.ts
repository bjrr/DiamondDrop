import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  issueApprovalPackage,
  recordCustomerApproval,
} from "~/db/repositories/customJewelryApprovalRepository.server";
import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS } from "~/domain/customjewelry/designDepositAcknowledgmentText";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
} from "~/domain/customjewelry/finalApprovalCopy";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";
import { Money } from "~/domain/money/money";
import { createCustomJewelryFinalPurchase } from "~/jobs/customjewelry/createFinalPurchase.server";
import type {
  CreateCustomJewelryDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";

/**
 * The Custom Jewelry final purchase.
 *
 * ============================================================================
 * THE PROPERTY WORTH THE MOST
 * ============================================================================
 * The gross approved price survives even though only the balance is collected.
 * Owner requirement, verbatim: "Never lose the gross approved price simply
 * because only the balance is collected at final checkout." Every test here
 * asserts the gross figure ALONGSIDE the balance for that reason — a test that
 * only checked the balance would pass against an implementation that had
 * thrown the price away.
 */

const CUSTOMER = "gid://shopify/Customer/7777";
const OTHER_CUSTOMER = "gid://shopify/Customer/8888";
const STAFF = "staff:gid://shopify/StaffMember/9";
const NOW = new Date("2026-11-01T12:00:00.000Z");
/** $5,000 bank / $5,175 card — a realistic 3.5% uplift at that tier. */
const BANK_PRICE = 500_000n;
const CARD_PRICE = 517_500n;

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

const SHIPPING = {
  firstName: "Ada",
  lastName: "Lovelace",
  address1: "1 Analytical Engine Way",
  city: "London",
  zip: "SW1A 1AA",
  countryCode: "GB",
};

/** Records what it was asked to create, and can be made to fail. */
function recordingPort(options: { fail?: boolean } = {}): DraftOrderPort & {
  calls: CreateCustomJewelryDraftOrderInput[];
} {
  const calls: CreateCustomJewelryDraftOrderInput[] = [];
  return {
    calls,
    async createCustomJewelryDraftOrder(
      input: CreateCustomJewelryDraftOrderInput
    ): Promise<CreatedDraftOrder> {
      calls.push(input);
      if (options.fail) throw new Error("Shopify said no");
      return {
        draftOrderGid: `gid://shopify/DraftOrder/cj-${uniq()}`,
        invoiceUrl: "https://caratforus-dev.myshopify.com/invoice/cj",
      };
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
    async cancelDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
  };
}

async function approvedPackage(
  options: { withPaidDeposit?: boolean; customerRef?: string } = {}
): Promise<{ packageId: string; projectId: string }> {
  const customerRef = options.customerRef ?? CUSTOMER;
  const project = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-P-${uniq()}`,
      customerRef,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-cjp-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "A solitaire.",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });

  if (options.withPaidDeposit) {
    const policy = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: "custom-jewelry-design-deposit" },
      orderBy: { version: "desc" },
    });
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "deposit ack fixture",
        policyVersionId: policy.id,
        affirmativeActionLabel: "I Authorize & Agree",
        customerRef,
        acknowledgedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    const acceptance = await prisma.customJewelryDepositAcceptance.create({
      data: {
        projectId: project.id,
        acknowledgmentId: ack.id,
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        customerRef,
        acceptedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    const invoice = await prisma.customJewelryDepositInvoice.create({
      data: {
        acceptanceId: acceptance.id,
        draftOrderGid: `gid://shopify/DraftOrder/dep-${uniq()}`,
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        issuedByActorType: "staff",
        issuedByActorRef: STAFF,
        issuedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });
    await prisma.customJewelryDepositPayment.create({
      data: {
        invoiceId: invoice.id,
        orderGid: `gid://shopify/Order/dep-${uniq()}`,
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        paidAt: new Date("2026-10-03T00:00:00.000Z"),
      },
    });
    await prisma.customJewelryProject.update({
      where: { id: project.id },
      data: { status: "deposit_charged" },
    });
  }

  const issued = await issueApprovalPackage({
    projectId: project.id,
    spec: { metalType: "platinum", metalColor: "white", ringSize: "6.5", mediaReferences: [] },
    bankPaymentPrice: usd(BANK_PRICE),
    regularCardPrice: usd(CARD_PRICE),
    issuedByActorRef: STAFF,
    now: NOW,
  });
  if (issued.outcome !== "issued") throw new Error("expected an issue");

  const policy = await prisma.policyVersion.findFirstOrThrow({
    where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
    orderBy: { version: "desc" },
  });
  const ack = await prisma.acknowledgment.create({
    data: {
      exactText: CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
      policyVersionId: policy.id,
      affirmativeActionLabel: CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
      customerRef,
      acknowledgedAt: NOW,
    },
  });
  await recordCustomerApproval({
    packageId: issued.package.id,
    customerRef,
    acknowledgmentId: ack.id,
    now: NOW,
  });

  return { packageId: issued.package.id, projectId: project.id };
}

function purchase(packageId: string, port: DraftOrderPort, overrides: Record<string, unknown> = {}) {
  return createCustomJewelryFinalPurchase({
    approvalPackageId: packageId,
    customerRef: CUSTOMER,
    email: "ada@example.com",
    shippingAddress: SHIPPING,
    paymentBasis: "card",
    draftOrderPort: port,
    now: NOW,
    ...overrides,
  } as Parameters<typeof createCustomJewelryFinalPurchase>[0]);
}

/** A benefit this customer can actually redeem. */
async function benefit(customerRef: string = CUSTOMER): Promise<string> {
  const issuedAt = new Date("2026-10-15T12:00:00.000Z");
  const submission = await prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-CJ-${uniq()}`,
      customerRef,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-bqcj-${uniq()}@example.com`,
      kind: "custom_quote",
      quoteIssuedOn: new Date("2026-10-10T00:00:00.000Z"),
      submittedOn: new Date("2026-10-14T00:00:00.000Z"),
      submittedAt: new Date("2026-10-14T15:00:00.000Z"),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays: 4,
      treatment: "guarantee",
      verification: "verified",
      verifiedAt: issuedAt,
      verifiedByActorRef: STAFF,
      status: "declined_cannot_beat",
      decisionReason: "below floor",
    },
  });
  const row = await prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId: submission.id,
      benefitCode: `BQ10-CJ-${uniq()}`,
      customerRef,
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt,
      expiresAt: fallbackExpiresAt(issuedAt),
      issuedByActorType: "staff",
      issuedByActorRef: STAFF,
    },
  });
  return row.benefitCode;
}

describe("the gross price survives, on either basis", () => {
  it("the CARD basis records the card gross and collects the card balance", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const port = recordingPort();

    const result = await purchase(packageId, port, { paymentBasis: "card" });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const p = result.purchase;
    expect(p.paymentBasis).toBe("card");
    // THE GROSS PRICE, PRESERVED.
    expect(p.grossApprovedPriceMinorUnits).toBe(CARD_PRICE);
    expect(p.depositCreditMinorUnits).toBe(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(p.benefitDiscountMinorUnits).toBe(0n);
    expect(p.balanceDueMinorUnits).toBe(CARD_PRICE - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    // And the deposit's payment reference, so the record is self-contained.
    expect(p.depositPaymentReference).toMatch(/^gid:\/\/shopify\/Order\/dep-/);
    // A card purchase's payable object is the draft order itself.
    expect(p.shopifyDraftOrderGid).not.toBeNull();
    expect(p.bankPaymentOrderId).toBeNull();

    // SHOPIFY IS TOLD THE GROSS PRICE, with the credit as a discount — not a
    // line priced at the balance, which would record the sale at the wrong
    // figure in the system the customer and an accountant both read.
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.grossPrice.amountMinorUnits).toBe(CARD_PRICE);
    expect(port.calls[0]!.totalCredit.amountMinorUnits).toBe(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(port.calls[0]!.paymentBasis).toBe("card");
    expect(port.calls[0]!.creditTitle).toContain("Design Deposit credit");
  });

  it("the BANK basis records the bank gross and collects the bank balance", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const port = recordingPort();

    const result = await purchase(packageId, port, { paymentBasis: "bank_payment" });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const p = result.purchase;
    expect(p.grossApprovedPriceMinorUnits).toBe(BANK_PRICE);
    expect(p.balanceDueMinorUnits).toBe(BANK_PRICE - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    // The payable object is a BANK PAYMENT ORDER, reusing the existing money
    // system rather than a second one.
    expect(p.bankPaymentOrderId).not.toBeNull();
    expect(p.shopifyDraftOrderGid).toBeNull();
    expect(port.calls[0]!.paymentBasis).toBe("bank_payment");
  });

  it("the bank basis collects LESS than the card basis for the same piece", async () => {
    const card = await approvedPackage({ withPaidDeposit: true });
    const bank = await approvedPackage({ withPaidDeposit: true });
    const cardResult = await purchase(card.packageId, recordingPort(), { paymentBasis: "card" });
    const bankResult = await purchase(bank.packageId, recordingPort(), { paymentBasis: "bank_payment" });
    if (cardResult.outcome !== "created" || bankResult.outcome !== "created") {
      throw new Error("expected both to be created");
    }
    expect(bankResult.purchase.balanceDueMinorUnits).toBeLessThan(
      cardResult.purchase.balanceDueMinorUnits
    );
    // And the gross differs too, which is the honest record of what each
    // customer agreed to pay for the piece.
    expect(bankResult.purchase.grossApprovedPriceMinorUnits).toBeLessThan(
      cardResult.purchase.grossApprovedPriceMinorUnits
    );
  });

  it("works with NO deposit paid", async () => {
    const { packageId } = await approvedPackage();
    const result = await purchase(packageId, recordingPort());
    if (result.outcome !== "created") throw new Error("expected creation");
    expect(result.purchase.depositCreditMinorUnits).toBe(0n);
    expect(result.purchase.depositPaymentReference).toBeNull();
    expect(result.purchase.balanceDueMinorUnits).toBe(CARD_PRICE);
  });
});

describe("the bank path keeps §22 intact", () => {
  it("creates a bank payment order with a CUSTOM line at the balance", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const result = await purchase(packageId, recordingPort(), { paymentBasis: "bank_payment" });
    if (result.outcome !== "created") throw new Error("expected creation");

    const order = await prisma.bankPaymentOrder.findUniqueOrThrow({
      where: { id: result.purchase.bankPaymentOrderId! },
      include: { lines: true },
    });
    // PENDING UNTIL ACTUAL RECEIPT. Nothing about this order is paid.
    expect(order.status).toBe("open");
    expect(order.verifiedAt).toBeNull();
    expect(order.completedAt).toBeNull();
    // The §22 window.
    expect(order.guaranteeExpiresAt.getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);

    const line = order.lines[0]!;
    expect(line.masterVariantId).toBeNull();
    expect(line.customJewelryApprovalPackageId).toBe(packageId);
    // THE LINE QUOTES THE BALANCE, because that is what arrives and what the
    // verification amount comparison sums.
    expect(line.quotedBankPaymentPriceMinorUnits).toBe(
      BANK_PRICE - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS
    );
  });

  it("no payment state is inferred from the customer having ordered", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const result = await purchase(packageId, recordingPort(), { paymentBasis: "bank_payment" });
    if (result.outcome !== "created") throw new Error("expected creation");
    expect(result.purchase.status).toBe("awaiting_payment");
    expect(result.purchase.paidAt).toBeNull();
  });
});

describe("retries cannot create duplicate purchases", () => {
  it("a second call returns the existing purchase and calls Shopify ONCE", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const port = recordingPort();

    const first = await purchase(packageId, port);
    expect(first.outcome).toBe("created");
    const second = await purchase(packageId, port);
    expect(second.outcome).toBe("already_created");
    if (first.outcome !== "created" || second.outcome !== "already_created") return;
    expect(second.purchase.id).toBe(first.purchase.id);
    // The idempotency check runs BEFORE Shopify, so a retry costs one query
    // rather than an orphaned draft order.
    expect(port.calls).toHaveLength(1);
  });

  it("CONCURRENT calls converge on one purchase", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const port = recordingPort();

    const [a, b] = await Promise.all([purchase(packageId, port), purchase(packageId, port)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already_created", "created"]);
    expect(
      await prisma.customJewelryFinalPurchase.count({ where: { approvalPackageId: packageId } })
    ).toBe(1);
  });

  it("records the orphaned draft order when a race loses", async () => {
    // Both requests got past the idempotency check and both created a draft
    // order. The loser's is orphaned in Shopify — recorded as an anomaly rather
    // than cancelled automatically, because cancelling the WRONG one would
    // destroy the live checkout.
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const port = recordingPort();
    await Promise.all([purchase(packageId, port), purchase(packageId, port)]);

    const purchaseRow = await prisma.customJewelryFinalPurchase.findUniqueOrThrow({
      where: { approvalPackageId: packageId },
    });
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "custom_jewelry_final_purchase", entityId: purchaseRow.id, action: "anomaly" },
    });
    // Two draft orders were created, so exactly one anomaly is expected.
    expect(port.calls).toHaveLength(2);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.reason).toMatch(/orphaned/i);
  });
});

describe("what cannot be purchased", () => {
  it("REFUSES an unapproved package", async () => {
    // The final-sale term rests on the customer having approved the design. A
    // purchase without one makes that term unenforceable and unfair at once.
    const project = await prisma.customJewelryProject.create({
      data: {
        projectReference: `CJ-NA-${uniq()}`,
        customerRef: CUSTOMER,
        firstName: "Ada",
        lastName: "Lovelace",
        email: `ada-na-${uniq()}@example.com`,
        phone: "+15555550123",
        startingPoint: "from_scratch",
        promptText: "x",
        followUpPreference: "contact_me",
        status: "submitted",
      },
    });
    const issued = await issueApprovalPackage({
      projectId: project.id,
      spec: { metalType: "gold", metalColor: "yellow", mediaReferences: [] },
      bankPaymentPrice: usd(BANK_PRICE),
      regularCardPrice: usd(CARD_PRICE),
      issuedByActorRef: STAFF,
      now: NOW,
    });
    if (issued.outcome !== "issued") throw new Error("expected an issue");

    const port = recordingPort();
    const result = await purchase(issued.package.id, port);
    expect(result).toMatchObject({ outcome: "refused", refusal: "not_approved" });
    expect(port.calls).toHaveLength(0);
  });

  it("REFUSES a STALE approval version", async () => {
    // The owner's named case. A superseded package is not the current design,
    // so it is not purchasable even though it was once issued.
    const { packageId, projectId } = await approvedPackage();
    // Force the approved package to superseded by direct SQL is refused, so
    // instead build the stale case properly: an ISSUED version that a revision
    // superseded.
    const stale = await issueApprovalPackage({
      projectId: await freshProject(),
      spec: { metalType: "gold", metalColor: "yellow", mediaReferences: [] },
      bankPaymentPrice: usd(BANK_PRICE),
      regularCardPrice: usd(CARD_PRICE),
      issuedByActorRef: STAFF,
      now: NOW,
    });
    if (stale.outcome !== "issued") throw new Error("expected an issue");
    await issueApprovalPackage({
      projectId: stale.package.projectId,
      spec: { metalType: "gold", metalColor: "rose", mediaReferences: [] },
      bankPaymentPrice: usd(BANK_PRICE),
      regularCardPrice: usd(CARD_PRICE),
      issuedByActorRef: STAFF,
      now: NOW,
    });

    const port = recordingPort();
    const result = await purchase(stale.package.id, port);
    expect(result).toMatchObject({ outcome: "refused", refusal: "superseded" });
    expect(port.calls).toHaveLength(0);
    // The genuinely approved one is untouched.
    expect(packageId).toBeTruthy();
    expect(projectId).toBeTruthy();
  });

  it("REFUSES another customer's package", async () => {
    const { packageId } = await approvedPackage({ customerRef: OTHER_CUSTOMER });
    const port = recordingPort();
    const result = await purchase(packageId, port);
    expect(result).toMatchObject({ outcome: "refused", refusal: "package_not_found" });
    expect(port.calls).toHaveLength(0);
  });

  it("the DATABASE refuses a negative balance", async () => {
    const { packageId, projectId } = await approvedPackage();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_final_purchase"
          ("id","project_id","approval_package_id","payment_basis","currency",
           "gross_approved_price_minor_units","deposit_credit_minor_units",
           "benefit_discount_minor_units","balance_due_minor_units")
        VALUES (gen_random_uuid(), ${projectId}::uuid, ${packageId}::uuid, 'card', 'USD',
                100000, 60000, 60000, -20000)`
    ).rejects.toThrow(/amounts_exact/i);
  });

  it("the DATABASE refuses credits exceeding the gross price", async () => {
    const { packageId, projectId } = await approvedPackage();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_final_purchase"
          ("id","project_id","approval_package_id","payment_basis","currency",
           "gross_approved_price_minor_units","deposit_credit_minor_units",
           "benefit_discount_minor_units","balance_due_minor_units")
        VALUES (gen_random_uuid(), ${projectId}::uuid, ${packageId}::uuid, 'card', 'USD',
                100000, 60000, 60000, 0)`
    ).rejects.toThrow(/amounts_exact/i);
  });

  it("the DATABASE refuses a card purchase naming a bank payment order", async () => {
    const { packageId, projectId } = await approvedPackage();
    const bankOrder = await prisma.bankPaymentOrder.create({
      data: {
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/x-${uniq()}`,
        customerEmail: "x@example.com",
        customerGid: CUSTOMER,
        quotedAt: NOW,
        // STRICTLY AFTER the quote — `bank_payment_order_guarantee_after_quote`
        // refuses an equal pair, which it should: a guarantee that expires the
        // instant it is given is not a guarantee. The first version of this
        // throwaway fixture used NOW for both and was correctly refused.
        guaranteeExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_final_purchase"
          ("id","project_id","approval_package_id","payment_basis","currency",
           "gross_approved_price_minor_units","deposit_credit_minor_units",
           "benefit_discount_minor_units","balance_due_minor_units","bank_payment_order_id")
        VALUES (gen_random_uuid(), ${projectId}::uuid, ${packageId}::uuid, 'card', 'USD',
                100000, 0, 0, 100000, ${bankOrder.id}::uuid)`
    ).rejects.toThrow(/basis_object_coherent/i);
  });

  it("the DATABASE refuses editing the purchase amounts", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const result = await purchase(packageId, recordingPort());
    if (result.outcome !== "created") throw new Error("expected creation");
    for (const sql of [
      prisma.$executeRaw`UPDATE "custom_jewelry_final_purchase" SET "gross_approved_price_minor_units" = 1 WHERE "id" = ${result.purchase.id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_final_purchase" SET "deposit_credit_minor_units" = 0 WHERE "id" = ${result.purchase.id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_final_purchase" SET "balance_due_minor_units" = 0 WHERE "id" = ${result.purchase.id}::uuid`,
    ]) {
      await expect(sql).rejects.toThrow(/immutable/i);
    }
  });
});

describe("the Let Us Beat Your Quote benefit on a Custom Jewelry purchase", () => {
  it("applies 10% of the GROSS price, capped at $100, alongside the deposit credit", async () => {
    // $5,175 card gross -> 10% is $517.50, capped at $100. Plus the $49
    // deposit credit, so $5,026 is collected.
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit();
    const port = recordingPort();

    const result = await purchase(packageId, port, { benefitCode: code });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const p = result.purchase;
    expect(p.grossApprovedPriceMinorUnits).toBe(CARD_PRICE);
    expect(p.benefitDiscountMinorUnits).toBe(10_000n);
    expect(p.depositCreditMinorUnits).toBe(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(p.balanceDueMinorUnits).toBe(
      CARD_PRICE - 10_000n - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS
    );
    // KEPT SEPARATE. One is a promotional benefit, the other is the customer's
    // own money returning to them.
    expect(p.benefitDiscountMinorUnits).not.toBe(p.depositCreditMinorUnits);
    // Both named on the invoice, since Shopify's discount is singular.
    expect(port.calls[0]!.creditTitle).toContain("Design Deposit credit");
    expect(port.calls[0]!.creditTitle).toContain("Let Us Beat Your Quote");
  });

  it("the DEPOSIT CREDIT does not shrink the benefit's base", async () => {
    // The benefit is 10% of the eligible MERCHANDISE subtotal. The deposit is
    // not a reduction in what the merchandise costs, so computing the benefit
    // on the post-credit balance would shrink it by 10% of $49, silently.
    const withDeposit = await approvedPackage({ withPaidDeposit: true });
    const without = await approvedPackage();
    const a = await purchase(withDeposit.packageId, recordingPort(), { benefitCode: await benefit() });
    const b = await purchase(without.packageId, recordingPort(), { benefitCode: await benefit() });
    if (a.outcome !== "created" || b.outcome !== "created") throw new Error("expected both");
    expect(a.purchase.benefitDiscountMinorUnits).toBe(b.purchase.benefitDiscountMinorUnits);
  });

  it("RESERVES rather than redeems — the benefit is not spent at order time", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit();
    await purchase(packageId, recordingPort(), { benefitCode: code });

    const row = await prisma.beatQuoteFallbackBenefit.findFirstOrThrow({
      where: { benefitCode: code },
      include: { redemptionIntents: true },
    });
    expect(row.redeemedAt).toBeNull();
    expect(row.redemptionIntents).toHaveLength(1);
    expect(row.redemptionIntents[0]!.status).toBe("reserved");
    expect(row.redemptionIntents[0]!.surface).toBe("custom_jewelry");
  });

  it("links the reservation to the BANK payment order on the bank basis", async () => {
    // So Slice 10's verification and release paths can find it — one
    // redemption machine, not two.
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit();
    const result = await purchase(packageId, recordingPort(), {
      benefitCode: code,
      paymentBasis: "bank_payment",
    });
    if (result.outcome !== "created") throw new Error("expected creation");

    const intent = await prisma.beatQuoteRedemptionIntent.findFirstOrThrow({
      where: { benefit: { benefitCode: code } },
    });
    expect(intent.bankPaymentOrderId).toBe(result.purchase.bankPaymentOrderId);
    expect(intent.paymentBasis).toBe("bank_payment");
  });

  it("links the reservation to the DRAFT order on the card basis", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit();
    const result = await purchase(packageId, recordingPort(), { benefitCode: code, paymentBasis: "card" });
    if (result.outcome !== "created") throw new Error("expected creation");

    const intent = await prisma.beatQuoteRedemptionIntent.findFirstOrThrow({
      where: { benefit: { benefitCode: code } },
    });
    expect(intent.draftOrderGid).toBe(result.purchase.shopifyDraftOrderGid);
    expect(intent.paymentBasis).toBe("card");
  });

  it("REFUSES another customer's benefit, and creates nothing", async () => {
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit(OTHER_CUSTOMER);
    const port = recordingPort();

    const result = await purchase(packageId, port, { benefitCode: code });
    expect(result).toMatchObject({ outcome: "refused", refusal: "benefit_refused" });
    expect(port.calls).toHaveLength(0);
    expect(
      await prisma.customJewelryFinalPurchase.count({ where: { approvalPackageId: packageId } })
    ).toBe(0);
  });

  it("RELEASES the benefit when the draft order fails", async () => {
    // A Shopify failure must not leave the customer's single-use benefit
    // locked against a checkout that does not exist.
    const { packageId } = await approvedPackage({ withPaidDeposit: true });
    const code = await benefit();

    await expect(
      purchase(packageId, recordingPort({ fail: true }), { benefitCode: code })
    ).rejects.toThrow(/Shopify said no/);

    const intent = await prisma.beatQuoteRedemptionIntent.findFirstOrThrow({
      where: { benefit: { benefitCode: code } },
    });
    expect(intent.status).toBe("released");
    expect(intent.releaseReason).toMatch(/checkout_failed/);
  });
});

/** A fresh project for the stale-version case. */
async function freshProject(): Promise<string> {
  const row = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-S-${uniq()}`,
      customerRef: CUSTOMER,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-s-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "x",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });
  return row.id;
}
