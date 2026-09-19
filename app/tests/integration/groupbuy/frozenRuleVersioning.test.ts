import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { computeRefundsAtClose } from "~/jobs/groupbuy/refundLedger.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { loader } from "~/routes/apps.carat.group-buy.$code";
import { createHmac } from "node:crypto";

/**
 * A FROZEN CAMPAIGN IS PRICED BY THE RULES IT FROZE WITH — forever.
 *
 * Everything else in this suite tests one rule doing the right thing. These
 * tests are about the opposite: that changing the rules later cannot reach
 * backwards. A campaign quotes prices customers join at, and a refund settles
 * against those prices; both must be reproducible from what was recorded, not
 * recomputed from whatever the pricing profile says today.
 *
 * WHY THIS NEEDS ITS OWN FILE. The failure mode is silent by construction. Every
 * individual number stays plausible — a campaign quoted under today's rules
 * looks exactly like a campaign quoted correctly, and only a comparison against
 * the frozen profile reveals it. Several call sites had today's rule ids
 * hardcoded and no test noticed, because with one live rule the hardcoded value
 * and the frozen value agreed.
 *
 * The two profiles used here are the seeded ones: v3 carries the superseded
 * fixed 5% / whole-dollar card rule, v5 the tiered / $5 one. Campaigns are
 * opened with an explicit `asOf` on either side of the 2026-09-18 switch, which
 * is what selects between them.
 */

const BEFORE_SWITCH = new Date("2026-09-17T19:00:00.000Z"); // resolves v3
const AFTER_SWITCH = new Date("2026-09-19T00:00:00.000Z"); //  resolves v5

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

async function openCampaignAt(asOf: Date, units = 0) {
  // The heaviest eligible piece: a light variant clears the $100 minimum profit
  // only narrowly, and the tier below would breach it before anything this file
  // cares about could be observed.
  const variant = await prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", masterProduct: { isLuxurySteal: false } },
    orderBy: { baseWeightGrams: "desc" },
  });

  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-frozen-${uniq()}`,
      name: "frozen-rule fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.950000" },
        ],
      },
      variants: {
        create: [
          {
            masterVariantId: variant.id,
            frozenBaseBankPaymentPriceMinorUnits: 1n,
            frozenLandedCostMinorUnits: 0n,
          },
        ],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf });

  if (units > 0) {
    await recordUnitEvent({
      campaignId: draft.id,
      masterVariantId: variant.id,
      kind: "purchased",
      quantity: units,
      orderRef: `order-${uniq()}`,
      lineRef: `line-${uniq()}`,
      externalRef: `ext-${uniq()}`,
      occurredAt: asOf,
      recordedBy: "test",
    });
  }

  const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: draft.id },
    include: { pricingProfile: true, variants: true },
  });

  return { campaign: opened, variantId: variant.id };
}

function callProxy(code: string) {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const params = { shop: "caratforus-dev.myshopify.com" };
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com/apps/carat/group-buy/${code}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return loader({
    request: new Request(url),
    params: { code },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

/** ceil_to_whole_dollar(bank x 1.05) — the SUPERSEDED rule, written out here. */
function legacyCard(bank: bigint): bigint {
  const exact = (bank * 105n) / 100n + ((bank * 105n) % 100n === 0n ? 0n : 1n);
  return exact % 100n === 0n ? exact : exact + (100n - (exact % 100n));
}

/** The TIERED rule, written out here rather than imported from the implementation. */
function tieredCard(bank: bigint): bigint {
  const rate =
    bank >= 500_000n
      ? 1030n
      : bank >= 250_000n
        ? 1035n
        : bank >= 100_000n
          ? 1040n
          : bank >= 50_000n
            ? 1045n
            : 1050n;
  const scaled = bank * rate;
  const cents = scaled / 1000n + (scaled % 1000n === 0n ? 0n : 1n);
  return cents % 500n === 0n ? cents : cents + (500n - (cents % 500n));
}

describe("a campaign freezes the rule version it opened under", () => {
  it("an OLD campaign records the superseded fixed card rule", async () => {
    const { campaign } = await openCampaignAt(BEFORE_SWITCH);

    expect(campaign.pricingProfile?.regularCardPriceRuleId).toBe(
      "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1"
    );
  });

  it("a NEW campaign records BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1", async () => {
    const { campaign } = await openCampaignAt(AFTER_SWITCH);

    expect(campaign.pricingProfile?.regularCardPriceRuleId).toBe(
      "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1"
    );
  });

  it("the two campaigns quote DIFFERENT card prices for the same bank price", async () => {
    // The point of the whole exercise, in one assertion. Both campaigns price
    // the same variant off the same costs; only the frozen rule differs, and
    // the storefront figures differ accordingly.
    const old = await openCampaignAt(BEFORE_SWITCH, 1);
    const fresh = await openCampaignAt(AFTER_SWITCH, 1);

    const oldBody = (await (await callProxy(old.campaign.code)).json()) as Record<string, string>;
    const newBody = (await (await callProxy(fresh.campaign.code)).json()) as Record<string, string>;

    const oldBank = BigInt(oldBody.groupBuyBankPaymentPriceMinorUnits!);
    const newBank = BigInt(newBody.groupBuyBankPaymentPriceMinorUnits!);

    // Same variant, same cost inputs, so the BANK price is identical — the
    // bank-vs-card feature does not touch it (policy §2).
    expect(oldBank).toBe(newBank);

    // But the advertised prices differ, each following its own frozen rule.
    expect(BigInt(oldBody.groupBuyRegularCardPriceMinorUnits!)).toBe(legacyCard(oldBank));
    expect(BigInt(newBody.groupBuyRegularCardPriceMinorUnits!)).toBe(tieredCard(newBank));
    expect(oldBody.groupBuyRegularCardPriceMinorUnits).not.toBe(
      newBody.groupBuyRegularCardPriceMinorUnits
    );
  });

  it("the OLD campaign's card prices are whole dollars, not $5 multiples", () => {
    // A cheap structural tell that the legacy rule really ran, independent of
    // the arithmetic above: its ceiling is a dollar, the current one is $5.
    const check = async () => {
      const { campaign } = await openCampaignAt(BEFORE_SWITCH, 1);
      const body = (await (await callProxy(campaign.code)).json()) as Record<string, string>;

      const card = BigInt(body.groupBuyRegularCardPriceMinorUnits!);
      expect(card % 100n).toBe(0n);
      // Would be a $5 multiple only by coincidence; this fixture's is not.
      expect(card % 500n).not.toBe(0n);
    };
    return check();
  });

  it("every tier marker follows the frozen rule, not just the current tier", () => {
    const check = async () => {
      const { campaign } = await openCampaignAt(BEFORE_SWITCH, 1);
      const body = (await (await callProxy(campaign.code)).json()) as {
        tierMarkers: { bankPaymentPriceMinorUnits: string; regularCardPriceMinorUnits: string }[];
      };

      expect(body.tierMarkers.length).toBeGreaterThan(1);
      for (const marker of body.tierMarkers) {
        expect(BigInt(marker.regularCardPriceMinorUnits)).toBe(
          legacyCard(BigInt(marker.bankPaymentPriceMinorUnits))
        );
      }
    };
    return check();
  });
});

describe("a later profile change cannot reach a frozen campaign", () => {
  it("adding a newer profile does not move an open campaign's prices", async () => {
    const { campaign } = await openCampaignAt(BEFORE_SWITCH, 1);

    const before = (await (await callProxy(campaign.code)).json()) as Record<string, string>;

    // A NEW profile version, effective now, with a different card rule and a
    // different uplift rate. This is exactly what a future pricing change looks
    // like, and it must not touch a campaign customers have already joined.
    await prisma.pricingProfile.create({
      data: {
        code: "buy_now",
        version: 900 + ++seq,
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.400000",
        minGrossMarginRate: "0.200000",
        minDollarProfitMinorUnits: 10000n,
        currency: "USD",
        roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
        priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
        autoApplyToleranceBps: 200,
        regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
        fixedCardUpliftRate: "0.250000",
        effectiveFrom: new Date("2999-01-01T00:00:00.000Z"),
        createdBy: "integration-test (later profile)",
        isPlaceholder: false,
      },
    });

    const after = (await (await callProxy(campaign.code)).json()) as Record<string, string>;

    expect(after.groupBuyBankPaymentPriceMinorUnits).toBe(
      before.groupBuyBankPaymentPriceMinorUnits
    );
    expect(after.groupBuyRegularCardPriceMinorUnits).toBe(
      before.groupBuyRegularCardPriceMinorUnits
    );
    expect(after.groupBuyBankPaymentSavingsMinorUnits).toBe(
      before.groupBuyBankPaymentSavingsMinorUnits
    );
  });
});

describe("refunds settle under the frozen rules and the payment basis", () => {
  async function closedCampaignAt(asOf: Date) {
    const { campaign, variantId } = await openCampaignAt(asOf, 5);
    const closed = await closeGroupBuyCampaign({ campaignId: campaign.id, closedBy: "staff" });
    const frozen = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    return {
      campaignId: campaign.id,
      variantId,
      basePrice: frozen.frozenBaseBankPaymentPriceMinorUnits,
      finalTier: closed.finalTierNumber,
      ruleId: campaign.pricingProfile?.regularCardPriceRuleId,
    };
  }

  /** The tier-2 bank price: base x 0.95, HALF_UP to minor units then whole-dollar up. */
  const finalBank = (base: bigint): bigint => {
    const exact = (base * 95n) / 100n + ((base * 95n) % 100n >= 50n ? 1n : 0n);
    return exact % 100n === 0n ? exact : exact + (100n - (exact % 100n));
  };

  it("a CARD line on an OLD campaign settles against the OLD card rule", async () => {
    const c = await closedCampaignAt(BEFORE_SWITCH);
    expect(c.ruleId).toBe("CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1");
    expect(c.finalTier).toBe(2);

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-legacy-card",
          lineRef: "line-legacy-card",
          paymentBasis: "card",
          paidPerUnitMinorUnits: legacyCard(c.basePrice),
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-legacy-card" },
    });

    // Settled against the LEGACY card price of the final tier — not the tiered
    // one, and not the bank price.
    expect(refund.finalPerUnitMinorUnits).toBe(legacyCard(finalBank(c.basePrice)));
    expect(refund.finalPerUnitMinorUnits).not.toBe(tieredCard(finalBank(c.basePrice)));
    expect(refund.finalPerUnitMinorUnits).not.toBe(finalBank(c.basePrice));
  });

  it("a CARD line on a NEW campaign settles against the TIERED rule", async () => {
    const c = await closedCampaignAt(AFTER_SWITCH);
    expect(c.ruleId).toBe("BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1");

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-tiered-card",
          lineRef: "line-tiered-card",
          paymentBasis: "card",
          paidPerUnitMinorUnits: tieredCard(c.basePrice),
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-tiered-card" },
    });

    expect(refund.finalPerUnitMinorUnits).toBe(tieredCard(finalBank(c.basePrice)));
    expect(refund.finalPerUnitMinorUnits % 500n).toBe(0n);
  });

  it("a BANK line settles against the bank price under either rule", async () => {
    // The card rule is irrelevant to a bank-paid line, and must stay so.
    for (const asOf of [BEFORE_SWITCH, AFTER_SWITCH]) {
      const c = await closedCampaignAt(asOf);

      await computeRefundsAtClose({
        campaignId: c.campaignId,
        computedBy: "staff",
        paidLines: [
          {
            masterVariantId: c.variantId,
            orderRef: `order-bank-${uniq()}`,
            lineRef: "line-bank",
            paymentBasis: "bank_payment",
            paidPerUnitMinorUnits: c.basePrice,
            qualifyingUnits: 1,
          },
        ],
      });

      const refund = await prisma.groupBuyRefund.findFirstOrThrow({
        where: { campaignId: c.campaignId, lineRef: "line-bank" },
      });

      expect(refund.finalPerUnitMinorUnits, `asOf ${asOf.toISOString()}`).toBe(
        finalBank(c.basePrice)
      );
      expect(refund.paymentBasis).toBe("bank_payment");
    }
  });

  it("a later profile change cannot alter a refund already computed", async () => {
    const c = await closedCampaignAt(BEFORE_SWITCH);

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-stable",
          lineRef: "line-stable",
          paymentBasis: "card",
          paidPerUnitMinorUnits: legacyCard(c.basePrice),
          qualifyingUnits: 1,
        },
      ],
    });

    const before = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-stable" },
    });

    await prisma.pricingProfile.create({
      data: {
        code: "buy_now",
        version: 950 + ++seq,
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.400000",
        minGrossMarginRate: "0.200000",
        minDollarProfitMinorUnits: 10000n,
        currency: "USD",
        roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
        priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
        autoApplyToleranceBps: 200,
        regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
        fixedCardUpliftRate: "0.400000",
        effectiveFrom: new Date("2999-01-02T00:00:00.000Z"),
        createdBy: "integration-test (later profile)",
        isPlaceholder: false,
      },
    });

    // Recomputing is a no-op by design (one row per line), so the stored figures
    // must be untouched — and a fresh computation must not produce different
    // ones either.
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-stable",
          lineRef: "line-stable",
          paymentBasis: "card",
          paidPerUnitMinorUnits: legacyCard(c.basePrice),
          qualifyingUnits: 1,
        },
      ],
    });

    const after = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-stable" },
    });

    expect(after.finalPerUnitMinorUnits).toBe(before.finalPerUnitMinorUnits);
    expect(after.refundAmountMinorUnits).toBe(before.refundAmountMinorUnits);
    expect(after.id).toBe(before.id);
  });
});

describe("the PRICE-ENDING rule is frozen too, not just the card rule", () => {
  /**
   * The other half of the frozen-rule fix, and the half nothing else here can
   * discriminate.
   *
   * Every seeded profile carries the same rounding and price-ending pair, so a
   * campaign opened before the card-rule switch and one opened after differ
   * only in the card rule — restoring the hardcoded `"WHOLE_DOLLAR_UP_V1"` to
   * the proxy and the refund ledger would leave every other test in this
   * repository green.
   *
   * These open a campaign under a profile whose price ending is `NONE_V1`, so
   * the Bank Payment Price keeps its cents. A hardcoded whole-dollar rule
   * rounds those cents away and the assertions fail.
   *
   * (The ROUNDING rule cannot be tested the same way: `RoundingRuleId` is a
   * single-member union today, so there is no second rule to freeze against.
   * It is correct by construction until a second one exists.)
   */

  /** A real-margin profile with NO price ending, dated between seeded v3 and v5. */
  async function centsProfile() {
    const version = 800 + ++seq;
    return prisma.pricingProfile.create({
      data: {
        code: "buy_now",
        version,
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.400000",
        minGrossMarginRate: "0.200000",
        minDollarProfitMinorUnits: 10000n,
        currency: "USD",
        roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
        // The distinguishing field. Every seeded profile from v2 on uses
        // WHOLE_DOLLAR_UP_V1; this one keeps the cents.
        priceEndingRuleId: "NONE_V1",
        autoApplyToleranceBps: 200,
        regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
        fixedCardUpliftRate: "0.050000",
        // After seeded v3 (2026-09-17T18:00) and before v5 (2026-09-18T00:00),
        // so it is resolved only by the deliberate as-of below and never by a
        // wall-clock read.
        effectiveFrom: new Date("2026-09-17T20:00:00.000Z"),
        createdBy: "integration-test (NONE_V1 price ending)",
        isPlaceholder: false,
      },
    });
  }

  const AT_CENTS_PROFILE = new Date("2026-09-17T21:00:00.000Z");

  it("the storefront quotes a campaign frozen on NONE_V1 with its cents intact", async () => {
    await centsProfile();
    const { campaign } = await openCampaignAt(AT_CENTS_PROFILE, 1);

    expect(campaign.pricingProfile?.priceEndingRuleId).toBe("NONE_V1");

    const body = (await (await callProxy(campaign.code)).json()) as {
      groupBuyBankPaymentPriceMinorUnits: string;
      tierMarkers: { bankPaymentPriceMinorUnits: string }[];
    };

    // Tier 2 is x0.95 of a price that is not a round number of dollars, so the
    // result has cents — unless something rounded it to whole dollars, which is
    // exactly the hardcoded rule this asserts is gone.
    const bank = BigInt(body.groupBuyBankPaymentPriceMinorUnits);
    expect(bank % 100n).not.toBe(0n);

    // And every tier marker, not only the current one.
    const anyMarkerHasCents = body.tierMarkers.some(
      (m) => BigInt(m.bankPaymentPriceMinorUnits) % 100n !== 0n
    );
    expect(anyMarkerHasCents).toBe(true);
  });

  it("a refund on that campaign settles at the un-rounded price", async () => {
    await centsProfile();
    const { campaign, variantId } = await openCampaignAt(AT_CENTS_PROFILE, 5);
    await closeGroupBuyCampaign({ campaignId: campaign.id, closedBy: "staff" });

    const frozen = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });

    await computeRefundsAtClose({
      campaignId: campaign.id,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: variantId,
          orderRef: `order-cents-${uniq()}`,
          lineRef: "line-cents",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: frozen.frozenBaseBankPaymentPriceMinorUnits,
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: campaign.id, lineRef: "line-cents" },
    });

    // x0.95 with no price ending: the settled figure keeps its cents. A
    // hardcoded WHOLE_DOLLAR_UP_V1 would round it up and shrink the refund.
    expect(refund.finalPerUnitMinorUnits % 100n).not.toBe(0n);
    expect(refund.refundAmountMinorUnits).toBeGreaterThan(0n);
  });
});
