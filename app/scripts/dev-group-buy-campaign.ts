/**
 * DEVELOPMENT ONLY — creates one Group Buy campaign for visual testing of the
 * storefront theme block.
 *
 * Run with: npm run dev:group-buy
 *
 * WHY A SCRIPT AND NOT A SEED. The seed describes the fixture data every
 * environment starts from. This creates a campaign bound to one specific
 * Shopify test product on one specific development store, which belongs in
 * neither the seed nor production. Keeping it separate means nothing here can
 * reach a real environment by being run at the wrong moment.
 *
 * IDEMPOTENT. Re-running reuses the existing campaign rather than creating a
 * second one with the same code, so it is safe to run again after a reset.
 *
 * REFUSES TO RUN IN PRODUCTION, because a script that creates open Group Buy
 * campaigns has no business being runnable against a real store.
 */
import "dotenv/config";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { getCurrentTier, getQualifyingUnits, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";

/** A clearly Shopify-generated test product on the development store. */
const SHOPIFY_PRODUCT_TITLE = "The Complete Snowboard";
const SHOPIFY_VARIANT_TITLE = "Ice";
const SHOPIFY_VARIANT_GID = "gid://shopify/ProductVariant/52375385309485";

const CAMPAIGN_CODE = "dev-gb-1";

/**
 * Units to have on the campaign. Override to watch the tier change live:
 *
 *   npm run dev:group-buy -- --units 10
 *
 * Only ever ADDS units — removing them would mean recording a cancellation,
 * and a cancellation invented to tidy a demo is exactly the kind of entry the
 * append-only ledger exists to keep out.
 */
const QUALIFYING_UNITS = (() => {
  const flag = process.argv.indexOf("--units");
  const value = flag === -1 ? null : Number(process.argv[flag + 1]);
  return value && Number.isInteger(value) && value > 0 ? value : 4;
})();

/**
 * TIER BOUNDARY IS TEST DATA, NOT A LOCKED DECISION.
 *
 * The "Tier 1 = 1-9, Tier 2 = 10+" reading has never been formally confirmed,
 * so it is configured HERE as one campaign's data rather than encoded
 * anywhere. The engine hard-codes no threshold and no multiplier — see
 * app/domain/groupbuy/tiers.ts — so changing these numbers changes this
 * campaign and nothing else.
 *
 * WHY 7% AND NOT THE 10% THAT READING ASSUMES. It will not open at 10%, and
 * that is arithmetic rather than a fixture problem:
 *
 *   a 40% markup ON COST yields a ~28.6% gross margin before fees, and ~25.7%
 *   after payment processing. Taking 10% off the PRICE drops that to 17.8% —
 *   under the owner's 20% minimum — so evaluateTierSafety refuses to open the
 *   campaign.
 *
 * Measured against this variant, the deepest tier that clears the floor is
 * x0.93 (20.30% margin); x0.92 already breaches. The constraint is structural,
 * not specific to this piece: with markup m and floor f, the deepest safe
 * multiplier is roughly 1 / ((1 + m) x (1 - f)).
 */
const TIERS = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.930000" },
];

async function main() {
  if (getEnv().APP_ENV === "production") {
    throw new Error("Refusing to run: this creates an open Group Buy campaign.");
  }

  // A master product/variant representing the Shopify test product. The
  // physical attributes are OURS (a Group Buy needs a weight and a metal to
  // price); the shopifyVariantGid is the association the theme block resolves
  // through, since a theme knows only Shopify ids.
  //
  // 30g of 14k gold, chosen so the 10% second tier clears the $100 minimum
  // profit comfortably. A light piece cannot sustain a 10% tier at all, which
  // is the safety check working rather than a limitation of the campaign.
  const product = await prisma.masterProduct.upsert({
    where: { id: "00000000-0000-4000-8000-00000000dbb1" },
    update: {},
    create: {
      // All-zero prefix so dev rows are obvious at a glance; "dbb" is hex,
      // unlike the "dev"/"gb" spelling this started with, which Postgres
      // rejected outright.
      id: "00000000-0000-4000-8000-00000000dbb1",
      name: `DEV Group Buy test piece (${SHOPIFY_PRODUCT_TITLE})`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      isLuxurySteal: false,
    },
  });

  const variant = await prisma.masterVariant.upsert({
    where: { id: "00000000-0000-4000-8000-00000000dbb2" },
    update: { shopifyVariantGid: SHOPIFY_VARIANT_GID },
    create: {
      id: "00000000-0000-4000-8000-00000000dbb2",
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "30.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: SHOPIFY_VARIANT_GID,
    },
  });

  let campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code: CAMPAIGN_CODE },
    include: { tiers: true, variants: true },
  });

  if (!campaign) {
    campaign = await prisma.groupBuyCampaign.create({
      data: {
        code: CAMPAIGN_CODE,
        name: "DEV Group Buy — theme block test",
        currency: "USD",
        createdBy: "dev-group-buy-campaign script",
        // Two weeks out, so the block has a countdown to render.
        scheduledCloseAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        tiers: { create: TIERS },
        variants: {
          create: [
            {
              masterVariantId: variant.id,
              // Placeholders; the freeze at open replaces them with real
              // prices. They exist only to satisfy NOT NULL while drafting.
              frozenBasePriceMinorUnits: 1n,
              frozenLandedCostMinorUnits: 0n,
            },
          ],
        },
      },
      include: { tiers: true, variants: true },
    });
  }

  // Reconcile tiers while the campaign is STILL A DRAFT.
  //
  // Without this, a campaign left in draft by a failed open keeps whatever
  // tiers it was created with, and editing the constants above silently has no
  // effect — which is exactly what happened on the first run here. Tiers are
  // editable only until open; the database refuses afterwards.
  if (campaign.status === "draft") {
    await prisma.groupBuyCampaignTier.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.groupBuyCampaignTier.createMany({
      data: TIERS.map((t) => ({ ...t, campaignId: campaign!.id })),
    });
  }

  if (campaign.status === "draft") {
    await openGroupBuyCampaign({
      campaignId: campaign.id,
      openedBy: "dev-group-buy-campaign script",
    });
  }

  const existingUnits = (await getQualifyingUnits(campaign.id)).total;
  if (existingUnits < QUALIFYING_UNITS) {
    await recordUnitEvent({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      kind: "purchased",
      quantity: QUALIFYING_UNITS - existingUnits,
      orderRef: "dev-order-1",
      lineRef: "dev-line-1",
      // Stable, so re-running cannot double-count.
      // Keyed by the resulting total, so asking for the same count twice is a
      // no-op while asking for more tops up.
      externalRef: `dev-seed-units-to-${QUALIFYING_UNITS}`,
      occurredAt: new Date(),
      recordedBy: "dev-group-buy-campaign script",
    });
  }

  const frozen = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  const { tier, qualifyingUnits } = await getCurrentTier(campaign.id);
  const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    include: { tiers: { orderBy: { tierNumber: "asc" } } },
  });

  const dollars = (minor: bigint) => `$${(Number(minor) / 100).toFixed(2)}`;

  console.log("");
  console.log("  campaign code      ", CAMPAIGN_CODE);
  console.log("  status             ", opened.status);
  console.log("  Shopify product    ", SHOPIFY_PRODUCT_TITLE);
  console.log("  Shopify variant    ", `${SHOPIFY_VARIANT_TITLE}  ${SHOPIFY_VARIANT_GID}`);
  console.log("  master variant     ", variant.id);
  console.log("  frozen base price  ", dollars(frozen.frozenBasePriceMinorUnits));
  console.log("  qualifying units   ", qualifyingUnits);
  console.log("  active tier        ", tier.tierNumber);
  console.log("  closes at          ", opened.scheduledCloseAt?.toISOString() ?? "(open-ended)");
  for (const t of opened.tiers) {
    console.log(
      `  tier ${t.tierNumber}             threshold ${t.minQualifyingUnits}+ units, multiplier ${t.priceMultiplier}`
    );
  }
  console.log("");

  await prisma.$disconnect();
}

await main();
