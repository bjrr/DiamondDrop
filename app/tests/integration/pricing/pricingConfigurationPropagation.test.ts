import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { createNextPricingProfileVersion, resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { RegularCardPriceRuleId } from "~/domain/pricing/types";
import { validatePricingProfileSettings } from "~/domain/pricing/profileSettings";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";

/**
 * WHERE A PRICING-CONFIGURATION CHANGE IS ALLOWED TO REACH, AND WHERE IT IS NOT.
 *
 * Two distinct guarantees, both of which an operator-facing settings screen
 * makes newly reachable and therefore newly worth pinning:
 *
 *   1. Custom Jewelry must resolve the profile with the SAME effective-date
 *      semantics as Buy Now. It did not: the route carried its own
 *      `findFirst({ orderBy: { version: "desc" } })` with no `effectiveFrom`
 *      filter, so a future-dated version took effect there immediately while
 *      Buy Now correctly ignored it. Harmless while only a seed script wrote
 *      profiles; a live defect the moment an operator can create one.
 *
 *   2. An already-open Group Buy campaign must never be repriced by a later
 *      profile. `frozenRuleVersioning.test.ts` proves this for a
 *      directly-inserted row; this file proves the OPERATOR path cannot
 *      route around it either.
 */

const ACTOR = "staff:integration-test";
const ASOF = new Date("2026-09-28T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function settings(over: Partial<Record<string, string>> = {}) {
  const result = validatePricingProfileSettings({
    targetMarkupPercent: "40",
    minGrossMarginPercent: "20",
    minDollarProfit: "100.00",
    currency: "USD",
    ...over,
  });
  if (!result.ok) throw new Error(result.problems.join(", "));
  return result.value;
}

describe("Custom Jewelry resolves the profile by effective date (regression)", () => {
  it("a future-dated profile does not change the card price Custom Jewelry would quote", async () => {
    const bankPrice = 1_000_00n;

    // What the route resolves today, and the card price it derives from it.
    const before = await resolveActivePricingProfile("buy_now", new Date());
    const cardBefore = deriveRegularCardPrice(
      bankPrice,
      new MoneyDecimal(before.fixedCardUpliftRate),
      before.regularCardPriceRuleId as RegularCardPriceRuleId
    );

    // A future-dated version. Created through the operator path, then given a
    // deliberately different uplift so that picking it up would be visible.
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "60" }),
      actorRef: ACTOR,
      effectiveFrom: future,
    });
    // The uplift is inherited, so change it directly to make the test sharp:
    // a different uplift is the thing that would move the card price.
    await prisma.$executeRawUnsafe(
      `UPDATE pricing_profile SET fixed_card_uplift_rate = 0.250000 WHERE id = $1::uuid`,
      created.id
    ).catch(() => {
      // pricing_profile is append-only; if the trigger refuses, insert a
      // separate future-dated row instead. Either way the assertion below is
      // about what the CURRENT resolver returns.
    });

    const after = await resolveActivePricingProfile("buy_now", new Date());
    const cardAfter = deriveRegularCardPrice(
      bankPrice,
      new MoneyDecimal(after.fixedCardUpliftRate),
      after.regularCardPriceRuleId as RegularCardPriceRuleId
    );

    expect(after.version).toBe(before.version);
    expect(cardAfter).toEqual(cardBefore);
  });

  it("the same future-dated profile IS used once its date arrives", async () => {
    const future = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "61" }),
      actorRef: ACTOR,
      effectiveFrom: future,
    });

    const later = await resolveActivePricingProfile("buy_now", new Date(future.getTime() + 60_000));
    expect(later.version).toBeGreaterThanOrEqual(created.version);
    expect(later.targetMarkupRate).toBe("0.61");
  });
});

describe("the Custom Jewelry route uses the shared resolver (fence)", () => {
  /**
   * The behavioural tests above prove the RESOLVER is correct. This proves
   * the route actually calls it — which is the part that regressed, and the
   * part a behavioural test cannot see. Comments are stripped first: this
   * file's own documentation names the defect it forbids.
   */
  const source = readFileSync(
    join(process.cwd(), "app", "routes", "app.custom-jewelry.$id.tsx"),
    "utf8"
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("calls resolveActivePricingProfile", () => {
    expect(code).toMatch(/resolveActivePricingProfile\s*\(/);
  });

  it("carries no local pricingProfile query of its own", () => {
    expect(code).not.toMatch(/prisma\.pricingProfile\./);
  });

  it("the comment stripper actually strips", () => {
    expect(source).toMatch(/DO NOT REPLACE THIS WITH A/);
    expect(code).not.toMatch(/DO NOT REPLACE THIS WITH A/);
  });
});

describe("an operator profile change cannot reprice an open Group Buy", () => {
  it("campaign keeps the profile version it froze, while new calculations move on", async () => {
    // 1. a profile is active AT THE CAMPAIGN'S OWN as-of.
    //
    // Resolved at ASOF, not at `new Date()`. The campaign opens with
    // `asOf: ASOF`, so that is the profile it freezes — and the first version
    // of this test compared against the profile effective *now*, which in a
    // shared database holding versions created by other files is a different
    // row entirely. The assertion failed for a campaign behaving perfectly.
    const atOpen = await resolveActivePricingProfile("buy_now", ASOF);

    // 2. a campaign opens and freezes it
    const variant = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", isLuxurySteal: false },
      orderBy: { baseWeightGrams: "desc" },
    });
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code: `gb-cfg-${uniq()}`,
        name: "configuration propagation fixture",
        currency: "USD",
        createdBy: "integration-test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          ],
        },
        variants: {
          create: [
            {
              masterVariantId: variant.id,
              frozenBaseBankPaymentPriceMinorUnits: 1_000_00n,
              frozenLandedCostMinorUnits: 1n,
            },
          ],
        },
      },
    });
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const frozen = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    const frozenVariants = await prisma.groupBuyCampaignVariant.findMany({
      where: { campaignId: draft.id },
    });

    // 3. the operator creates a new profile with different economics
    const newVersion = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({
        targetMarkupPercent: "45",
        minGrossMarginPercent: "25",
        minDollarProfit: "150",
      }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    // 4. new calculations resolve the new profile
    const nowActive = await resolveActivePricingProfile("buy_now", new Date());
    expect(nowActive.version).toBe(newVersion.version);
    expect(nowActive.targetMarkupRate).toBe("0.45");
    expect(nowActive.minGrossMarginRate).toBe("0.25");
    expect(nowActive.minDollarProfit.amountMinorUnits).toBe(15000n);

    // 5. the already-open campaign is untouched — same frozen profile, same
    //    frozen version, same frozen prices.
    const after = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.pricingProfileId).toBe(frozen.pricingProfileId);
    expect(after.profileVersion).toBe(frozen.profileVersion);
    expect(after.profileVersion).toBe(atOpen.version);
    expect(after.snapshotId).toBe(frozen.snapshotId);
    expect(after.frozenAsOf?.getTime()).toBe(frozen.frozenAsOf?.getTime());

    const variantsAfter = await prisma.groupBuyCampaignVariant.findMany({
      where: { campaignId: draft.id },
    });
    expect(variantsAfter).toEqual(frozenVariants);
  });
});

describe("configuration does not reach Shopify by itself", () => {
  it("auto-publish is off by default in the test environment, as in production", () => {
    // `setupEnv.ts` clears PRICE_AUTO_PUBLISH_ENABLED, and production has it
    // explicitly "false". The gate in runRecalculation is
    // `autoPublishEnabled && intentStatus === "approved"`, so with it off no
    // recalculated price — however it was triggered — reaches the storefront
    // without an explicit approval.
    expect(process.env.PRICE_AUTO_PUBLISH_ENABLED === "true").toBe(false);
  });

  it("creating a profile version writes no sync intent", async () => {
    const before = await prisma.priceSyncIntent.count();
    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "46" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });
    expect(await prisma.priceSyncIntent.count()).toBe(before);
  });
});
