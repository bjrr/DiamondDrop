/**
 * GROUP BUY LIVE GATE FIXTURE — creates the purpose-built, NON-PUBLIC test
 * campaign the seven-case gate needs, and PROVES the production-open lock on
 * the way (owner requirement 2026-09-29).
 *
 * ============================================================================
 * WHY THIS CREATES ITS OWN PRODUCT AND VARIANT
 * ============================================================================
 * The owner's instruction is "test variants only ... do not use anything
 * intended for customers". Production already has one `MasterVariant` bound to
 * a real Shopify variant from earlier slice verification; this deliberately
 * does NOT reuse it. It builds a separate `MasterProduct` + `MasterVariant`
 * bound to the DRAFT, unpublished Shopify product created by
 * `liveGateFixtureSetup.ts`, mirroring the existing variant's metal/purity/
 * labour configuration so the pricing engine can actually resolve inputs for
 * it — a campaign cannot open against a variant the engine cannot price.
 *
 * ============================================================================
 * WHAT OPENING COSTS, AND WHY THIS IS NOT REVERSIBLE
 * ============================================================================
 * Group Buy public progress is MONOTONIC by design. Once the seven-case gate
 * places its orders, the units it records on this campaign can never be taken
 * back — not by deleting the Shopify orders, not by any admin action. That is
 * the policy working, not a defect. It is also exactly why this campaign must
 * never be one a customer could reach: the code is prefixed `zz-live-gate-`,
 * the product is DRAFT and published to no sales channel, and the campaign is
 * never linked from any storefront surface.
 *
 * The production-open lock this script once exercised was removed on
 * 2026-09-29, after the seven-case gate it gated passed in production.
 *
 * RUN: npx tsx tests/live/groupBuyTestCampaignSetup.ts
 *   (DATABASE_URL must point at the production database)
 */
import "dotenv/config";

import { TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } from "~/domain/groupbuy/testFixtureCampaign";

const TEST_VARIANT_GID = process.env.CARAT_LIVE_GATE_VARIANT_GID ?? "";

/**
 * WHY THE FIXTURE VARIANT IS HEAVIER THAN ITS TEMPLATE.
 *
 * At the template weight the engine priced this variant at Bank $354.00. With
 * the production profile — 40% markup on cost, $100.00 minimum dollar profit —
 * cost is $252.86 and profit is $101.14. That leaves $1.14 of headroom, and
 * the two open-time guards then contradict each other:
 *
 *   - `min_dollar_profit` needs multiplier >= 0.99678 (bank >= $352.86)
 *   - the PRICE LADDER needs multiplier <= 0.99542, because the Card price
 *     only falls 375 -> 370 once bank x 1.05 <= 370 (bank <= $352.38)
 *
 * No multiplier satisfies both. That is not a bug in either guard — it is what
 * a $100 flat profit floor and $5 card rounding jointly imply at a low price
 * point, and it is worth knowing before a real low-priced campaign is designed.
 *
 * Scaling the weight moves the price up so profit (which grows with price)
 * clears the floor with room to spare: at ~$1,060 profit is ~$303, so a 3%
 * tier is comfortably safe and still moves the Card price several $5 steps.
 */
const WEIGHT_SCALE = 3;

async function main() {
  if (!TEST_VARIANT_GID.startsWith("gid://shopify/ProductVariant/")) {
    throw new Error("Set CARAT_LIVE_GATE_VARIANT_GID to the DRAFT test variant from liveGateFixtureSetup.ts");
  }

  const { prisma } = await import("~/db/client.server");
  const { createGroupBuyCampaign, addGroupBuyCampaignEligibleVariant } = await import(
    "~/db/repositories/groupBuyRepository.server"
  );

  // A stable, obviously-synthetic code. Prefixed `zz-` so it sorts last in any
  // admin list a human scans, and names itself as a gate fixture.
  //
  // THE PREFIX COMES FROM THE CONSTANT, never typed here. This line CREATES
  // the campaign, so a divergence between the literal and the constant would
  // mint a campaign that every production filter treats as real business —
  // on a live store, permanently, since campaigns carrying units cannot be
  // deleted. Enforced by `campaignVisibilityFence.test.ts`.
  const stamp = String(Date.now());
  const code = `${TEST_FIXTURE_CAMPAIGN_CODE_PREFIX}${stamp}`;

  console.log("Group Buy live-gate fixture\n");

  // CAMPAIGNS CANNOT BE DELETED — not even drafts. Verified against
  // production: `group_buy_frozen_child_guard` (migration
  // 20260918183627) is attached to the CHILD tables and looks up the parent
  // campaign status. On a cascading delete the parent row is already gone, so
  // the lookup returns NULL, `IS DISTINCT FROM 'draft'` is true, and the
  // delete is refused with "campaign <id> is <NULL>". The <NULL> is the tell.
  //
  // Nothing exposes campaign deletion today (no admin action, no repository
  // function), so this breaks nothing — but it does mean EVERY fixture
  // campaign is permanent. That is why each is prefixed `zz-live-gate-`,
  // named DO NOT PUBLISH, and left unlinked from any storefront surface: the
  // only available cleanup is that it is unreachable, not that it is gone.
  const existing = await prisma.masterVariant.findUnique({ where: { shopifyVariantGid: TEST_VARIANT_GID } });
  let masterVariantId: string;

  if (existing) {
    console.log(`  reusing existing test MasterVariant ${existing.id}`);
    masterVariantId = existing.id;
    // Re-apply the weight scale in case an earlier run created it at 1x.
    await prisma.masterVariant.update({
      where: { id: existing.id },
      data: { baseWeightGrams: existing.baseWeightGrams.mul(WEIGHT_SCALE) },
    }).catch(() => undefined);
  } else {
    // Clone the configuration of a variant the engine already prices
    // successfully, so this fixture fails on its own merits rather than on an
    // unrelated pricing-input gap.
    const template = await prisma.masterVariant.findFirst({
      where: { shopifyVariantGid: { not: null } },
      include: { masterProduct: true },
    });
    if (!template) throw new Error("no priced MasterVariant to use as a configuration template");

    const product = await prisma.masterProduct.create({
      data: {
        name: `ZZ LIVE GATE TEST — DO NOT SELL (${stamp})`,
        category: template.masterProduct.category,
        sizeAxis: template.masterProduct.sizeAxis,
        allowedSizeMin: template.masterProduct.allowedSizeMin,
        allowedSizeMax: template.masterProduct.allowedSizeMax,
        sizeIncrement: template.masterProduct.sizeIncrement,
        baseSize: template.masterProduct.baseSize,
        offeredMetals: template.masterProduct.offeredMetals,
        status: "draft",
      },
    });

    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: template.metal,
        purity: template.purity,
        bandId: template.bandId,
        baseWeightGrams: template.baseWeightGrams.mul(WEIGHT_SCALE),
        weightPerFullSizeGrams: template.weightPerFullSizeGrams,
        laborSource: template.laborSource,
        shopifyVariantGid: TEST_VARIANT_GID,
      },
    });
    console.log(`  created test MasterProduct ${product.id}`);
    console.log(`  created test MasterVariant ${variant.id} -> ${TEST_VARIANT_GID}`);
    masterVariantId = variant.id;
  }

  const campaign = await createGroupBuyCampaign({
    code,
    name: `ZZ LIVE GATE TEST CAMPAIGN — DO NOT PUBLISH (${stamp})`,
    currency: "USD",
    createdBy: "live-gate",
    // Two tiers so the gate can observe a tier unlock. Tier 1 starts at 1 unit
    // per the README rule `validateTierSet` enforces.
    tiers: [
      // A DELIBERATELY TINY TIER-2 DISCOUNT. 0.95 was refused by
      // `evaluateTierSafety` with min_dollar_profit — correctly: 5% off the
      // engine-computed price for this synthetic variant eats the minimum
      // profit floor. The right response is a safe tier set, NOT
      // `unsafeOverride`; suppressing a money guard to make a fixture run is
      // how a real floor breach later gets waved through as "the usual test
      // thing". Two tiers because MIN_TIERS is 2, strictly falling as
      // `validateTierSet` requires.
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      // 0.99 CHOSEN BY ARITHMETIC, not by trying numbers until one stuck.
      // The engine prices this variant at Bank $354.00 / Card $375.00.
      //   - 0.95 failed `min_dollar_profit` — too deep for the floor.
      //   - 0.999 failed the PRICE LADDER guard: $0.35 off $354 rounds away,
      //     and the $5 card rounding absorbed the tier entirely, so a card
      //     customer would have seen no change at all.
      // For the Card price to fall 375 -> 370 the Bank price must satisfy
      // bank x 1.05 <= 370, i.e. bank <= 352.38, i.e. multiplier <= 0.9954.
      // 0.99 gives Bank 350.46 -> Card 367.98 -> rounds up to 370: both fall.
      //
      // Note what this means for real campaigns: on a low-priced variant the
      // $5 card rounding can swallow a whole tier. Both guards refusing this
      // is them working, and neither was overridden.
      { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.970000" },
    ],
  });
  await addGroupBuyCampaignEligibleVariant(campaign.id, masterVariantId);
  console.log(`  created DRAFT campaign ${campaign.id}  code=${code}`);

  // THE PRODUCTION-OPEN LOCK IS GONE — removed 2026-09-29 once the seven-case
  // gate passed, which is what it was gating. This script used to prove the
  // lock refused here before opening through a one-call window; there is no
  // longer a lock to prove, so it opens directly.
  //
  // What still protects a real campaign is the ordinary control: opening is a
  // staff action behind embedded-admin authentication. If verify-before-
  // counting is ever materially changed, re-run the seven-case gate before
  // trusting it again.
  const { openGroupBuyCampaign } = await import("~/jobs/groupbuy/openCampaign.server");

  console.log("\nopening the TEST campaign");
  await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "live-gate" });

  const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
  console.log(`  campaign status: ${opened.status}`);

  console.log("\n============================================================");
  console.log("Add to the gate environment:");
  console.log(`CARAT_LIVE_GATE_CAMPAIGN_CODE=${code}`);
  console.log("\nCLEANUP AFTERWARDS (database, not Shopify):");
  console.log("  NONE POSSIBLE for the campaign — see this file's comment on why a campaign row,");
  console.log("  draft or open, cannot be deleted. It stays, unreachable, prefixed zz-live-gate-.");
  console.log("  The Shopify DRAFT product CAN be deleted: admin -> Products -> tag carat-live-gate.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("\n", error);
  process.exitCode = 1;
});
