import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  GroupBuyCampaignNotClosedError,
  GroupBuyCampaignNotDraftForConfigurationError,
  GroupBuyCampaignNotFoundError,
  GroupBuyRefundAlreadyIssuedError,
  addGroupBuyCampaignEligibleVariant,
  createGroupBuyCampaign,
  getGroupBuyCampaignForStaff,
  getGroupBuyRefundForLine,
  listGroupBuyRefundsForCampaign,
  recordGroupBuyRefundOverride,
  recordGroupBuyTierRefund,
  removeGroupBuyCampaignEligibleVariant,
  replaceGroupBuyCampaignTiers,
  transitionGroupBuyRefundStatus,
} from "~/db/repositories/groupBuyRepository.server";
import { InvalidRefundTransitionError } from "~/domain/groupbuy/refunds";
import { InvalidTierSetError, tierBankPaymentPriceExact, type TierDefinition } from "~/domain/groupbuy/tiers";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";

/**
 * The two things this task actually added: draft-only campaign/tier/variant
 * configuration, and the settlement-time refund ledger. `openGroupBuyCampaign`
 * and the unit ledger (freeze, monotonic progress, idempotent unit events,
 * close-lock) are exercised for real here only as fixture setup — their own
 * guarantees are already proven in `openCampaign.test.ts` and
 * `unitLedger.test.ts` and are not re-tested.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

async function eligibleVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });
}

const TIERS: readonly TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
];

describe("createGroupBuyCampaign / tier & variant configuration — draft only", () => {
  it("creates a draft campaign with its tiers", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    expect(campaign.status).toBe("draft");

    const full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.tiers).toHaveLength(2);
  });

  it("refuses an invalid tier set before writing anything", async () => {
    await expect(
      createGroupBuyCampaign({
        code: `gb-repo-badtiers-${uniq()}`,
        name: "bad tiers",
        currency: "USD",
        createdBy: "integration-test",
        tiers: [{ tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" }], // only 1 — below MIN_TIERS
      })
    ).rejects.toBeInstanceOf(InvalidTierSetError);
  });

  it("replaceGroupBuyCampaignTiers overwrites a draft campaign's tier set", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    const replaced = await replaceGroupBuyCampaignTiers(campaign.id, [
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 8, priceMultiplier: "0.950000" },
      { tierNumber: 3, minQualifyingUnits: 20, priceMultiplier: "0.900000" },
    ]);
    expect(replaced).toHaveLength(3);

    const full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.tiers.map((t) => t.tierNumber)).toEqual([1, 2, 3]);
  });

  it("adds and removes an eligible variant on a draft campaign", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();

    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    let full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.variants.map((v) => v.masterVariantId)).toContain(variant.id);

    await removeGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.variants.map((v) => v.masterVariantId)).not.toContain(variant.id);
  });

  it("REFUSES tier/variant configuration once the campaign is open — even though the database trigger would refuse it too", async () => {
    const variant = await eligibleVariant();
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-open-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });

    await expect(replaceGroupBuyCampaignTiers(campaign.id, TIERS)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
    await expect(addGroupBuyCampaignEligibleVariant(campaign.id, variant.id)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
    await expect(removeGroupBuyCampaignEligibleVariant(campaign.id, variant.id)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
  });

  it("getGroupBuyCampaignForStaff returns null for a nonexistent campaign", async () => {
    await expect(getGroupBuyCampaignForStaff(randomUUID())).resolves.toBeNull();
  });
});

async function openAndCloseCampaign(qualifyingUnits: number) {
  const variant = await eligibleVariant();
  const campaign = await createGroupBuyCampaign({
    code: `gb-refund-${uniq()}`,
    name: "refund fixture",
    currency: "USD",
    createdBy: "integration-test",
    tiers: TIERS,
  });
  await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
  await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });

  const lineRef = `line-${uniq()}`;
  await recordUnitEvent({
    campaignId: campaign.id,
    masterVariantId: variant.id,
    kind: "purchased",
    quantity: qualifyingUnits,
    orderRef: `order-${uniq()}`,
    lineRef,
    externalRef: `ext-${uniq()}`,
    occurredAt: ASOF,
    recordedBy: "integration-test",
  });

  await closeGroupBuyCampaign({ campaignId: campaign.id, closedBy: "staff" });

  const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    include: { tiers: true },
  });
  const profile = await prisma.pricingProfile.findUniqueOrThrow({ where: { id: opened.pricingProfileId! } });
  const frozenVariant = await prisma.groupBuyCampaignVariant.findFirstOrThrow({ where: { campaignId: campaign.id } });

  // Independently derive tier 1's bank price — the same pipeline the
  // repository uses — so the test has a REAL expected value, not a guess.
  const tier1 = opened.tiers.find((t) => t.tierNumber === 1)!;
  const exact = tierBankPaymentPriceExact(new MoneyDecimal(frozenVariant.frozenBaseBankPaymentPriceMinorUnits.toString()), {
    tierNumber: tier1.tierNumber,
    minQualifyingUnits: tier1.minQualifyingUnits,
    priceMultiplier: tier1.priceMultiplier.toString(),
  });
  const rounded = Money.fromDecimalMinorUnits(exact, opened.currency, profile.roundingRuleId as RoundingRuleId);
  const tier1BankPerUnitMinorUnits = applyPriceEnding(rounded.amountMinorUnits, profile.priceEndingRuleId as PriceEndingRuleId);

  return { campaignId: campaign.id, variantId: variant.id, lineRef, tier1BankPerUnitMinorUnits, profile, opened };
}

describe("recordGroupBuyTierRefund — settlement, only after close", () => {
  it("refuses before the campaign is closed", async () => {
    const variant = await eligibleVariant();
    const campaign = await createGroupBuyCampaign({
      code: `gb-refund-open-${uniq()}`,
      name: "refund fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });

    await expect(
      recordGroupBuyTierRefund({
        campaignId: campaign.id,
        masterVariantId: variant.id,
        orderRef: "o1",
        lineRef: "l1",
        paymentBasis: "bank_payment",
        paidPerUnitMinorUnits: 100_00n,
        currency: "USD",
        actor: "staff",
      })
    ).rejects.toBeInstanceOf(GroupBuyCampaignNotClosedError);
  });

  it("computes the refund as (paid - final) x qualifyingUnits, in bank_payment basis", async () => {
    // 6 units reaches tier 2 (threshold 5) — a customer who paid at tier 1
    // is owed the tier-1-to-tier-2 difference on their qualifying units.
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);

    const result = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    expect(result.created).toBe(true);
    expect(result.refund.qualifyingUnits).toBe(6);
    expect(result.refund.paidPerUnitMinorUnits).toBe(tier1BankPerUnitMinorUnits);
    // Tier 2 is 0.99x tier 1 — strictly less, so a real, positive refund is owed.
    expect(result.refund.finalPerUnitMinorUnits).toBeLessThan(tier1BankPerUnitMinorUnits);
    expect(result.refund.refundAmountMinorUnits).toBe(
      (tier1BankPerUnitMinorUnits - result.refund.finalPerUnitMinorUnits) * 6n
    );
    expect(result.refund.status).toBe("pending");
    expect(typeof result.refund.refundAmountMinorUnits).toBe("bigint");
  });

  it("derives the CARD final price from the frozen card rule when paymentBasis is 'card'", async () => {
    const { campaignId, variantId, lineRef, profile } = await openAndCloseCampaign(6);

    const result = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "card",
      paidPerUnitMinorUnits: 999_99n, // whatever the customer's card-basis receipt said
      currency: "USD",
      actor: "staff",
    });

    // Independently derive the expected card price from the SAME frozen
    // tier-2 bank price this campaign settled at, to prove the repository
    // used the frozen rule rather than inventing one.
    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { tiers: true } });
    const frozenVariant = await prisma.groupBuyCampaignVariant.findFirstOrThrow({ where: { campaignId } });
    const tier2 = opened.tiers.find((t) => t.tierNumber === opened.finalTierNumber)!;
    const exact = tierBankPaymentPriceExact(new MoneyDecimal(frozenVariant.frozenBaseBankPaymentPriceMinorUnits.toString()), {
      tierNumber: tier2.tierNumber,
      minQualifyingUnits: tier2.minQualifyingUnits,
      priceMultiplier: tier2.priceMultiplier.toString(),
    });
    const rounded = Money.fromDecimalMinorUnits(exact, opened.currency, profile.roundingRuleId as RoundingRuleId);
    const bankFinal = applyPriceEnding(rounded.amountMinorUnits, profile.priceEndingRuleId as PriceEndingRuleId);
    const expectedCard = deriveRegularCardPrice(
      bankFinal,
      new MoneyDecimal(profile.fixedCardUpliftRate.toString()),
      profile.regularCardPriceRuleId as RegularCardPriceRuleId
    ).regularCardPriceMinorUnits;

    expect(result.refund.finalPerUnitMinorUnits).toBe(expectedCard);
  });

  it("IDEMPOTENT — a second call for the same line reads back the same row rather than computing a new one", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);

    const first = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });
    const second = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);

    const rowCount = await prisma.groupBuyRefund.count({ where: { campaignId, lineRef } });
    expect(rowCount).toBe(1);
  });

  it("records a `not_owed` status, never a negative refund, when the customer paid at or below the final price", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(1); // stays at tier 1

    const result = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits, // paid exactly the final (tier 1) price
      currency: "USD",
      actor: "staff",
    });

    expect(result.refund.status).toBe("not_owed");
    expect(result.refund.refundAmountMinorUnits).toBe(0n);
  });

  it("appends the initial GroupBuyRefundEvent (fromStatus null)", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    const withEvents = await getGroupBuyRefundForLine(campaignId, lineRef);
    expect(withEvents?.events).toHaveLength(1);
    expect(withEvents?.events[0]).toMatchObject({ fromStatus: null, toStatus: "pending", actor: "staff" });
  });
});

describe("transitionGroupBuyRefundStatus — the only place status may change", () => {
  async function refundedLine() {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    const { refund } = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });
    return { campaignId, lineRef, refund };
  }

  it("walks pending -> releasable -> processing -> issued, recording an event at each step", async () => {
    const { refund } = await refundedLine();

    const releasable = await transitionGroupBuyRefundStatus(refund.id, { to: "releasable", actor: "staff" });
    expect(releasable.status).toBe("releasable");
    expect(releasable.releasedAt).not.toBeNull();

    const processing = await transitionGroupBuyRefundStatus(releasable.id, { to: "processing", actor: "staff" });
    expect(processing.status).toBe("processing");

    const issued = await transitionGroupBuyRefundStatus(processing.id, {
      to: "issued",
      actor: "staff",
      processorReference: "proc-ref-123",
    });
    expect(issued.status).toBe("issued");
    expect(issued.processorReference).toBe("proc-ref-123");
    expect(issued.issuedAt).not.toBeNull();

    const events = await prisma.groupBuyRefundEvent.findMany({ where: { refundId: refund.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["pending", "releasable", "processing", "issued"]);
  });

  it("REFUSES an illegal transition (pending straight to issued), refused before any write", async () => {
    const { refund } = await refundedLine();
    await expect(
      transitionGroupBuyRefundStatus(refund.id, { to: "issued", actor: "staff", processorReference: "x" })
    ).rejects.toBeInstanceOf(InvalidRefundTransitionError);

    const unchanged = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(unchanged.status).toBe("pending");
  });

  it("`issued` is TERMINAL — refused even after reaching it, both by the domain check and the database trigger", async () => {
    const { refund } = await refundedLine();
    const releasable = await transitionGroupBuyRefundStatus(refund.id, { to: "releasable", actor: "staff" });
    const processing = await transitionGroupBuyRefundStatus(releasable.id, { to: "processing", actor: "staff" });
    const issued = await transitionGroupBuyRefundStatus(processing.id, {
      to: "issued",
      actor: "staff",
      processorReference: "proc-ref-1",
    });

    // The domain check refuses first — this function never reaches the database.
    await expect(
      transitionGroupBuyRefundStatus(issued.id, { to: "releasable", actor: "staff" })
    ).rejects.toBeInstanceOf(InvalidRefundTransitionError);

    // And bypassing this function entirely, the database's own trigger holds too.
    await expect(
      prisma.groupBuyRefund.update({ where: { id: issued.id }, data: { status: "pending" } })
    ).rejects.toThrow(/already issued/);
  });

  it("a failed processing attempt can retry through the same `releasable` state", async () => {
    const { refund } = await refundedLine();
    const releasable = await transitionGroupBuyRefundStatus(refund.id, { to: "releasable", actor: "staff" });
    const processing = await transitionGroupBuyRefundStatus(releasable.id, { to: "processing", actor: "staff" });
    const failed = await transitionGroupBuyRefundStatus(processing.id, {
      to: "failed",
      actor: "staff",
      failureReason: "processor timeout",
    });
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("processor timeout");

    const retried = await transitionGroupBuyRefundStatus(failed.id, { to: "releasable", actor: "staff" });
    expect(retried.status).toBe("releasable");
  });

  it("refuses a nonexistent refund", async () => {
    await expect(
      transitionGroupBuyRefundStatus(randomUUID(), { to: "releasable", actor: "staff" })
    ).rejects.toThrow();
  });
});

describe("recordGroupBuyRefundOverride — manual intervention, attributed", () => {
  it("overrides an INPUT (the final price) and the amount is RECOMPUTED from it — never set independently", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    const { refund } = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    // The database's own group_buy_refund_amount_matches_inputs CHECK holds
    // refundAmount = (paid - final) x units at all times, with no exception
    // for a manual override — so overriding "the amount" directly is not a
    // capability this function offers. It overrides the FINAL PRICE input,
    // by $0.50, and the amount is recomputed from the new figure.
    const correctedFinal = refund.finalPerUnitMinorUnits - 50n;
    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "goodwill adjustment to the settled final price",
      finalPerUnitMinorUnits: correctedFinal,
    });

    expect(overridden.finalPerUnitMinorUnits).toBe(correctedFinal);
    expect(overridden.refundAmountMinorUnits).toBe((refund.paidPerUnitMinorUnits - correctedFinal) * 6n);
    expect(overridden.overrideBy).toBe("owner");
    expect(overridden.overrideReason).toBe("goodwill adjustment to the settled final price");
    expect(overridden.overrideAt).not.toBeNull();
  });

  it("leaves an omitted input unchanged — overriding only the paid price does not disturb the final price", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    const { refund } = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    const correctedPaid = refund.paidPerUnitMinorUnits + 10n;
    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "paid amount was recorded 10 cents low",
      paidPerUnitMinorUnits: correctedPaid,
    });

    expect(overridden.paidPerUnitMinorUnits).toBe(correctedPaid);
    expect(overridden.finalPerUnitMinorUnits).toBe(refund.finalPerUnitMinorUnits);
    expect(overridden.refundAmountMinorUnits).toBe((correctedPaid - refund.finalPerUnitMinorUnits) * 6n);
  });

  it("refuses to override an already-issued refund", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    const { refund } = await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });
    const releasable = await transitionGroupBuyRefundStatus(refund.id, { to: "releasable", actor: "staff" });
    const processing = await transitionGroupBuyRefundStatus(releasable.id, { to: "processing", actor: "staff" });
    const issued = await transitionGroupBuyRefundStatus(processing.id, {
      to: "issued",
      actor: "staff",
      processorReference: "proc-ref-9",
    });

    await expect(
      recordGroupBuyRefundOverride(issued.id, {
        overrideBy: "owner",
        overrideReason: "too late",
        finalPerUnitMinorUnits: 1n,
      })
    ).rejects.toBeInstanceOf(GroupBuyRefundAlreadyIssuedError);
  });
});

describe("reads", () => {
  it("listGroupBuyRefundsForCampaign returns every refund for a campaign", async () => {
    const { campaignId, variantId, lineRef, tier1BankPerUnitMinorUnits } = await openAndCloseCampaign(6);
    await recordGroupBuyTierRefund({
      campaignId,
      masterVariantId: variantId,
      orderRef: "order-1",
      lineRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: tier1BankPerUnitMinorUnits,
      currency: "USD",
      actor: "staff",
    });

    const list = await listGroupBuyRefundsForCampaign(campaignId);
    expect(list).toHaveLength(1);
    expect(list[0]?.lineRef).toBe(lineRef);
  });

  it("getGroupBuyRefundForLine returns null when no refund has been computed", async () => {
    const { campaignId } = await openAndCloseCampaign(1);
    await expect(getGroupBuyRefundForLine(campaignId, "no-such-line")).resolves.toBeNull();
  });
});

describe("GroupBuyCampaignNotFoundError", () => {
  it("is thrown for a nonexistent campaign on configuration functions", async () => {
    await expect(addGroupBuyCampaignEligibleVariant(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      GroupBuyCampaignNotFoundError
    );
  });
});
