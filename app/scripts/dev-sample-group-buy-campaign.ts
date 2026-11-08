/**
 * DEVELOPMENT ONLY — builds the COMPREHENSIVE sample Group Buy campaign that
 * the isolated dev environment exists to show.
 *
 * Run with:  npm run dev:sample-group-buy
 * (reads app/.env.dev, which points at the dev Postgres through
 *  `flyctl proxy 15432:5432 -a caratforus-dev-db`)
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE dev-group-buy-campaign.ts
 * ===========================================================================
 * That script predates the campaign builder. It creates a campaign with ONE
 * variant and NO options contract, which was all the old theme block needed.
 * It therefore exercises none of what the redesigned storefront actually
 * renders: option dimensions, size bands, disabled combinations, per-variant
 * pricing, tier ladders, galleries. It is left alone rather than rewritten,
 * because its own header explains that its campaign is already open and
 * frozen and must not be re-priced.
 *
 * This script is the comprehensive case: every option ROLE, a real band
 * mapping, genuinely unavailable combinations, 15 separately priced variant
 * groups and a three-tier ladder.
 *
 * ===========================================================================
 * IT GOES THROUGH THE REAL CODE, NOT AROUND IT
 * ===========================================================================
 * The builder state is assessed by `assessCampaignBuilderCompleteness` and
 * the options contract is produced by `buildCampaignOptionsJson`, which
 * routes through the REAL validator. The campaign is opened by
 * `openGroupBuyCampaign`, so tier safety, the price ladder check and the
 * freeze are the production ones. If this script can create a campaign the
 * admin could not, the script is wrong — so it refuses rather than
 * work around a complaint.
 *
 * IDEMPOTENT. Re-running reuses the campaign with the same code.
 *
 * REFUSES TO RUN IN PRODUCTION, twice over: on APP_ENV, and on the campaign
 * code, which must be a `dev-` code. Opening a campaign freezes pricing and
 * counts units monotonically; neither can be undone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config as loadEnvFile } from "dotenv";

/**
 * `.env.dev` BY NAME, not `dotenv/config`.
 *
 * Every other entry point in this repository does `import "dotenv/config"`,
 * which loads `.env` — and `.env` is whatever the developer happens to have
 * pointed at locally. This script opens a Group Buy campaign, which freezes
 * pricing and starts a monotonic unit count that cannot be undone. Letting it
 * inherit an ambient `.env` is the one way it could do that to the wrong
 * database despite every other guard below.
 *
 * So the dev-only script names the dev-only file. `override: true` because
 * the point is for this file to WIN over anything already in the environment,
 * which is the opposite of dotenv's default and the whole reason it is
 * spelled out here.
 */
loadEnvFile({ path: join(process.cwd(), ".env.dev"), override: true });

import { Metal, Purity, LaborSource, MasterProductStatus, MasterVariantStatus, SizeAxis } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import {
  assessCampaignBuilderCompleteness,
  buildCampaignOptionsJson,
  enumerateConfigurations,
  isReadyToOpen,
  variantGroupsOf,
  type BuilderImageRef,
  type BuilderOption,
  type CampaignBuilderState,
} from "~/domain/groupbuy/campaignBuilder";
import {
  saveGroupBuyCampaignBuilderState,
  saveGroupBuyCampaignOptionsUpload,
} from "~/db/repositories/groupBuyRepository.server";
import { CampaignOpenTierPublishError, openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { getCurrentTier, getQualifyingUnits, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";

const ACTOR = "dev-sample-group-buy-campaign script";

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

/**
 * Overridable so a second campaign can be opened for the hub, which needs
 * more than one to be worth looking at and which the detail page's "related
 * campaigns" section cannot populate from a single open campaign.
 *
 * MUST START `dev-`, checked in `main`. A campaign code is the one thing
 * standing between this script and a real campaign.
 */
const CAMPAIGN_CODE = flag("code") ?? "dev-sample-gb-1";

const CAMPAIGN_NAME = flag("name") ?? "DEV SAMPLE — Aurora Halo Engagement Ring";

/** Days until close, so two campaigns can differ and the hub's sort is visible. */
const CLOSE_IN_DAYS = Number.parseInt(flag("close-in-days") ?? "21", 10);

/**
 * Units to seed. 12 puts the campaign INTO tier 2 with tier 3 still ahead, so
 * the storefront has both an unlocked tier and a next-tier message to render.
 *
 * ONLY EVER ADDS. Removing units would mean recording a cancellation, and a
 * cancellation invented to tidy a demo is exactly what the append-only unit
 * ledger exists to keep out.
 */
const QUALIFYING_UNITS = Number.parseInt(flag("units") ?? "12", 10);

/**
 * Deterministic, obviously-synthetic ids so re-running upserts the same rows.
 * Hex only — Postgres rejects a uuid containing letters past `f`, which an
 * earlier dev script learned by trying to spell "dev" in one.
 */
const PRODUCT_ID = "00000000-0000-4000-8000-00000bb00000";
const variantId = (n: number) => `00000000-0000-4000-8000-00000bb000${n.toString(16).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// The option set — one option per ROLE the builder supports, so the storefront
// has all three behaviours to render.
// ---------------------------------------------------------------------------

const METALS = [
  { value: "gold_14k_yellow", label: "14k Yellow Gold", sku: "YG", metal: Metal.gold, purity: Purity.GOLD_14K, extraGrams: 0 },
  { value: "gold_14k_white", label: "14k White Gold", sku: "WG", metal: Metal.gold, purity: Purity.GOLD_14K, extraGrams: 0 },
  { value: "platinum", label: "Platinum", sku: "PT", metal: Metal.platinum, purity: Purity.PLATINUM_950, extraGrams: 6 },
] as const;

const SHAPES = [
  { value: "round", label: "Round Brilliant", sku: "RD", extraGrams: 0 },
  { value: "oval", label: "Oval", sku: "OV", extraGrams: 1 },
] as const;

/**
 * BANDS ARE A PRICING CONSTRUCT AND STAY ONE. The customer picks an exact
 * ring size; `bandValue` is what the price is taken from. The band never
 * reaches the options contract (`toContractDimension` drops it) and must
 * never reach the page — see the storefront launch gate's "no size-band
 * terminology appears anywhere" check. The Shopify product's third option is
 * spelled as a plain range ("4 - 6") for the same reason.
 */
const BANDS = [
  { band: "small", sku: "S", grams: "22.0000", sizes: ["4", "4.5", "5", "5.5", "6"] },
  { band: "medium", sku: "M", grams: "24.0000", sizes: ["6.5", "7", "7.5", "8", "8.5", "9"] },
  { band: "large", sku: "L", grams: "26.0000", sizes: ["9.5", "10", "10.5", "11", "11.5", "12"] },
] as const;

/** No arithmetic on money or weight: every gram figure is a literal. */
const GRAMS: Readonly<Record<string, string>> = {
  "small|0|0": "22.0000", "medium|0|0": "24.0000", "large|0|0": "26.0000",
  "small|0|1": "23.0000", "medium|0|1": "25.0000", "large|0|1": "27.0000",
  "small|6|0": "28.0000", "medium|6|0": "30.0000", "large|6|0": "32.0000",
};

const SIZE_VALUES = BANDS.flatMap((b) => b.sizes.map((size) => ({ value: size, label: size, bandValue: b.band })));

const OPTIONS: readonly BuilderOption[] = [
  {
    key: "metal",
    label: "Metal",
    required: true,
    displayOrder: 1,
    role: "variant_defining",
    allowedValues: METALS.map((m) => ({ value: m.value, label: m.label })),
  },
  {
    key: "center_shape",
    label: "Center Stone Shape",
    required: true,
    displayOrder: 2,
    role: "variant_defining",
    allowedValues: SHAPES.map((s) => ({ value: s.value, label: s.label })),
  },
  {
    key: "ring_size",
    label: "Ring Size",
    required: true,
    displayOrder: 3,
    role: "variant_defining_band",
    allowedValues: SIZE_VALUES,
  },
  {
    key: "engraving",
    label: "Inside Engraving",
    required: true,
    displayOrder: 4,
    role: "customer_preference",
    allowedValues: [
      { value: "none", label: "No engraving" },
      { value: "initials", label: "Two initials" },
      { value: "date", label: "A date" },
    ],
  },
  {
    key: "gift_box",
    label: "Presentation Box",
    required: true,
    displayOrder: 5,
    role: "customer_preference",
    allowedValues: [
      { value: "standard", label: "Standard box" },
      { value: "premium", label: "Premium presentation box" },
    ],
  },
];

/**
 * THE UNAVAILABLE COMBINATIONS, and both kinds are represented deliberately.
 *
 *  1. Platinum + Oval — an entire pairing is not offered. This REMOVES three
 *     variant groups, so the campaign has 15 rather than 18, and the
 *     storefront must disable Oval once Platinum is chosen (and Platinum once
 *     Oval is chosen).
 *
 *  2. White Gold + Round in sizes 11.5 and 12 — a PARTIAL exclusion inside a
 *     band. The (white gold, round, large) group survives, because the other
 *     sizes in that band are still sellable. This is the case a naive
 *     implementation gets wrong, by either dropping the whole group or
 *     offering the two sizes anyway.
 */
function isDisabled(values: Readonly<Record<string, string>>): boolean {
  if (values.metal === "platinum" && values.center_shape === "oval") return true;
  if (
    values.metal === "gold_14k_white" &&
    values.center_shape === "round" &&
    (values.ring_size === "11.5" || values.ring_size === "12")
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

interface DevImages {
  readonly images: readonly { readonly gid: string; readonly url: string; readonly from: string }[];
}

function loadContent(): CampaignBuilderState["content"] {
  const { images } = JSON.parse(
    readFileSync(join(process.cwd(), "prisma", "devSampleShopifyImages.json"), "utf8")
  ) as DevImages;
  if (images.length < 4) throw new Error("devSampleShopifyImages.json needs at least 4 images");

  // ALT TEXT SAYS WHAT THE PICTURE ACTUALLY IS. These are the dev store's
  // built-in Shopify sample photographs, not jewellery. Labelling them
  // honestly is what keeps a screenshot of this campaign from ever being
  // mistaken for a real product shot.
  const ref = (i: number, role: string): BuilderImageRef => ({
    fileGid: images[i]!.gid,
    url: images[i]!.url,
    altText: `DEV PLACEHOLDER (${role}) — Shopify sample image "${images[i]!.from}", not jewellery`,
  });

  return {
    headline: "DEV SAMPLE — Aurora Halo, together",
    shortDescription:
      "A development-only Group Buy used to exercise the campaign builder and storefront. Not a real CaratForUs offer.",
    highlights: [
      "DEV SAMPLE campaign — nothing here is for sale",
      "Three metals, two centre shapes, 17 ring sizes",
      "Price falls as more people join, down three tiers",
      "Bank Payment pricing available at every tier",
    ],
    heroImage: ref(0, "hero"),
    mobileHeroImage: ref(1, "mobile hero"),
    cardImage: ref(2, "card"),
    galleryImages: images
      .slice(3)
      .map((_, offset) => ref(3 + offset, `gallery ${offset + 1}`)),
    displayDetails: [
      { label: "Centre stone", value: "DEV placeholder — 1.50ct lab-grown equivalent" },
      { label: "Accent stones", value: "DEV placeholder — pavé halo and shoulders" },
      { label: "Production time", value: "DEV placeholder — 4 to 6 weeks after campaign close" },
      { label: "Warranty", value: "1-year limited manufacturing warranty" },
      { label: "Environment", value: "DEVELOPMENT SAMPLE — not a production campaign" },
    ],
  };
}

/**
 * TIER LADDER. Multipliers apply to the frozen Bank Payment Price, and the
 * open path checks each against the gross-margin floor and the $100 minimum
 * profit before it will freeze anything. With markup x1.40 and a 20% floor
 * the deepest arithmetically safe multiplier is about 0.8929, so 0.96 and
 * 0.93 sit inside it with room — and the dollar floor is cleared by every
 * variant being 22g or heavier. If a floor is ever breached the open REFUSES,
 * and the right response is a shallower tier, never an unsafe override.
 */
const TIERS = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.960000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.930000" },
];

interface ShopifyVariantMap {
  readonly productGid: string;
  readonly skuToVariantGid: Readonly<Record<string, string>>;
}

async function main() {
  if (getEnv().APP_ENV === "production") {
    throw new Error("Refusing to run: this opens a Group Buy campaign, which freezes pricing irreversibly.");
  }
  if (!/^dev-[a-z0-9-]+$/.test(CAMPAIGN_CODE)) {
    throw new Error(`Refusing to run: campaign code ${CAMPAIGN_CODE} is not a dev- code.`);
  }
  if (!Number.isInteger(QUALIFYING_UNITS) || QUALIFYING_UNITS < 1) {
    throw new Error("Refusing to run: --units must be a positive integer.");
  }
  if (!Number.isInteger(CLOSE_IN_DAYS) || CLOSE_IN_DAYS < 1) {
    throw new Error("Refusing to run: --close-in-days must be a positive integer.");
  }

  const { productGid, skuToVariantGid } = JSON.parse(
    readFileSync(join(process.cwd(), "prisma", "devSampleShopifyVariants.json"), "utf8")
  ) as ShopifyVariantMap;

  // ---- Master product and the 15 priced variants -------------------------
  //
  // sizeAxis `none` because the BAND carries the size here: each band is its
  // own variant with its own gram weight, which is exactly what
  // `variant_defining_band` means. Giving the product a ring-size axis as
  // well would price the size twice.
  //
  // BOTH Shopify ids are recorded, not just the variant's. `tierPriceSync`
  // requires masterVariant.shopifyVariantGid AND
  // masterProduct.shopifyProductGid together, and treats either being absent
  // as "not yet linked" — a warning, not a failure. Setting only the variant
  // id produced exactly that: fifteen
  // `groupbuy.tier_sync_missing_shopify_linkage` warnings and a campaign
  // whose prices could never publish even once a session existed.
  await prisma.masterProduct.upsert({
    where: { id: PRODUCT_ID },
    update: { shopifyProductGid: productGid },
    create: {
      id: PRODUCT_ID,
      shopifyProductGid: productGid,
      name: "DEV SAMPLE Group Buy — Aurora Halo Engagement Ring",
      category: "ring",
      sizeAxis: SizeAxis.none,
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: [Metal.gold, Metal.platinum],
      status: MasterProductStatus.active,
    },
  });

  // One master variant per (metal, shape, band) that the campaign can sell.
  const variantByGroupKey = new Map<string, string>();
  let n = 0;
  for (const metal of METALS) {
    for (const shape of SHAPES) {
      if (metal.value === "platinum" && shape.value === "oval") continue;
      for (const band of BANDS) {
        n += 1;
        const id = variantId(n);
        const sku = `DEVSAMPLE-GB-${metal.sku}-${shape.sku}-${band.sku}`;
        const shopifyVariantGid = skuToVariantGid[sku];
        if (!shopifyVariantGid) throw new Error(`No dev Shopify variant for ${sku}`);
        const grams = GRAMS[`${band.band}|${metal.extraGrams}|${shape.extraGrams}`];
        if (!grams) throw new Error(`No gram weight for ${sku}`);

        await prisma.masterVariant.upsert({
          where: { id },
          update: { shopifyVariantGid },
          create: {
            id,
            masterProductId: PRODUCT_ID,
            metal: metal.metal,
            purity: metal.purity,
            baseWeightGrams: grams,
            weightPerFullSizeGrams: "0.0000",
            status: MasterVariantStatus.active,
            laborSource: LaborSource.india,
            shopifyVariantGid,
          },
        });
        variantByGroupKey.set(`${metal.value}|${shape.value}|${band.band}`, id);
      }
    }
  }

  // ---- Builder state ----------------------------------------------------
  // Built WITHOUT mappings first, so the variant-group signatures come from
  // `variantGroupsOf` — the same function the admin mapping table uses —
  // rather than from this script re-deriving a signature format of its own.
  const disabledConfigurations: string[] = [];
  const base: CampaignBuilderState = {
    productType: "Engagement ring",
    title: "DEV SAMPLE — Aurora Halo Engagement Ring",
    description:
      "A development-only sample campaign. Every option role, a real size-band mapping, two kinds of unavailable combination and three price tiers.",
    options: OPTIONS,
    content: loadContent(),
    disabledConfigurations: [],
    variantMappings: {},
  };

  // Enumerate once to collect the signatures to switch off.
  for (const configuration of enumerateConfigurations(base)) {
    if (isDisabled(configuration.values)) disabledConfigurations.push(configuration.signature);
  }

  const withDisabled: CampaignBuilderState = { ...base, disabledConfigurations };
  const variantMappings: Record<string, string> = {};
  for (const group of variantGroupsOf(withDisabled)) {
    const key = `${group.values.metal}|${group.values.center_shape}|${group.values.ring_size}`;
    const masterVariantId = variantByGroupKey.get(key);
    if (!masterVariantId) throw new Error(`No master variant for variant group ${key}`);
    variantMappings[group.signature] = masterVariantId;
  }

  const state: CampaignBuilderState = { ...withDisabled, variantMappings };

  // ---- Refuse anything the admin would refuse ---------------------------
  const problems = assessCampaignBuilderCompleteness(state);
  for (const problem of problems) {
    console.log(`  ${problem.blocking ? "BLOCKING" : "advisory"}  [${problem.section}] ${problem.message}`);
  }
  if (!isReadyToOpen(problems)) {
    throw new Error("Refusing to continue: the builder state is not ready to open.");
  }
  const contract = buildCampaignOptionsJson(state);
  if (!contract.ok) throw new Error(`Options contract invalid: ${contract.problems.join("; ")}`);

  // ---- Campaign ---------------------------------------------------------
  let campaign = await prisma.groupBuyCampaign.findUnique({ where: { code: CAMPAIGN_CODE } });
  if (!campaign) {
    campaign = await prisma.groupBuyCampaign.create({
      data: {
        code: CAMPAIGN_CODE,
        name: CAMPAIGN_NAME,
        currency: "USD",
        createdBy: ACTOR,
        scheduledCloseAt: new Date(Date.now() + CLOSE_IN_DAYS * 24 * 60 * 60 * 1000),
        tiers: { create: TIERS },
        variants: {
          create: [...new Set(Object.values(variantMappings))].map((masterVariantId) => ({
            masterVariantId,
            // Placeholders satisfying NOT NULL while the campaign drafts; the
            // freeze at open replaces them with real computed prices.
            frozenBaseBankPaymentPriceMinorUnits: 1n,
            frozenLandedCostMinorUnits: 0n,
          })),
        },
      },
    });
  }

  if (campaign.status === "draft") {
    await saveGroupBuyCampaignOptionsUpload(campaign.id, contract.value, ACTOR);
    await saveGroupBuyCampaignBuilderState(campaign.id, state, ACTOR);

    // TIER 1 PRICE PUBLICATION IS EXPECTED TO FAIL HERE, and that is caught
    // rather than prevented.
    //
    // Publishing needs a Shopify Admin session, which lives in the database
    // of the environment doing the publishing. The dev database has none
    // until the dev Shopify app is installed on caratforus-dev. The campaign
    // is nonetheless correctly open: `CampaignOpenTierPublishError`'s own
    // doc comment is explicit that the freeze committed and must not be
    // re-opened, and that `ensureGroupBuyCampaignSyncedToCurrentTier` is
    // idempotent and will publish on the next attempt.
    //
    // The alternative — passing a stub `resolveSyncPort` — would have made
    // the script's open a DIFFERENT operation from the admin's, which is the
    // one thing this script is not allowed to be.
    try {
      await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: ACTOR });
    } catch (error) {
      if (error instanceof CampaignOpenTierPublishError) {
        console.log("");
        console.log("  NOTE: the campaign opened and froze correctly, but its tier 1 price did not");
        console.log("        reach Shopify, because this environment has no Admin session yet.");
        console.log("        Install the dev app on caratforus-dev, then re-run the publish with");
        console.log("        ensureGroupBuyCampaignSyncedToCurrentTier. Do NOT re-open the campaign.");
      } else {
        throw error;
      }
    }
  }

  const existing = (await getQualifyingUnits(campaign.id)).total;
  if (existing < QUALIFYING_UNITS) {
    await recordUnitEvent({
      campaignId: campaign.id,
      masterVariantId: variantId(1),
      kind: "purchased",
      quantity: QUALIFYING_UNITS - existing,
      orderRef: `${CAMPAIGN_CODE}-order-1`,
      lineRef: `${CAMPAIGN_CODE}-line-1`,
      // Keyed by campaign AND resulting total, so re-running is a no-op while
      // asking for more tops up, and two campaigns cannot collide.
      externalRef: `${CAMPAIGN_CODE}-units-to-${QUALIFYING_UNITS}`,
      occurredAt: new Date(),
      recordedBy: ACTOR,
    });
  }

  // ---- Report -----------------------------------------------------------
  const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });
  const { tier, qualifyingUnits } = await getCurrentTier(campaign.id);
  // BIGINT STRING SPLIT, not `Number(minor) / 100`. The money-safety checker
  // would not catch it here — it keys on the filename, and this one has no
  // price/cost/metal/stone in it — which is precisely why the habit is worth
  // keeping where the checker is not looking.
  const dollars = (minor: bigint) => {
    const negative = minor < 0n;
    const digits = (negative ? -minor : minor).toString().padStart(3, "0");
    return `${negative ? "-" : ""}$${digits.slice(0, -2)}.${digits.slice(-2)}`;
  };
  const prices = opened.variants
    .map((v) => v.frozenBaseBankPaymentPriceMinorUnits)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  console.log("");
  console.log("  campaign code       ", opened.code);
  console.log("  status              ", opened.status);
  console.log("  configurations      ", contract.value.validCombinations.length, "enabled");
  console.log("  switched off        ", disabledConfigurations.length);
  console.log("  variant groups      ", Object.keys(variantMappings).length);
  console.log("  campaign variants   ", opened.variants.length);
  console.log("  frozen base range   ", `${dollars(prices[0]!)} - ${dollars(prices[prices.length - 1]!)}`);
  console.log("  qualifying units    ", qualifyingUnits);
  console.log("  active tier         ", tier.tierNumber);
  for (const t of opened.tiers) {
    console.log(`  tier ${t.tierNumber}              ${t.minQualifyingUnits}+ units, x${t.priceMultiplier}`);
  }
  console.log("  closes at           ", opened.scheduledCloseAt?.toISOString() ?? "(open-ended)");
  console.log("");

  await prisma.$disconnect();
}

await main();
