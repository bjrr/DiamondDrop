import { prisma } from "~/db/client.server";
import { hashCanonicalJson } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";
import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { evaluateTierSafety, type TierSafetyReport } from "~/domain/groupbuy/tierSafety";
import { validateTierSet, type TierDefinition } from "~/domain/groupbuy/tiers";
import { computeBuyNowPrice } from "~/domain/pricing/engine";
import type { BuyNowPriceResult, BuyNowPricingInputs } from "~/domain/pricing/types";
import { resolveInputsForVariant } from "~/jobs/pricing/resolveInputs.server";
import { logger } from "~/lib/logger.server";

/**
 * Opening a Group Buy campaign — the FREEZE.
 *
 * README: "When a campaign opens, freeze/version its applicable cost inputs,
 * pricing assumptions, tier thresholds/percentages, and eligible-variant
 * prices. Market changes after opening must not retroactively alter campaign
 * tier prices."
 *
 * WHAT GETS FROZEN, AND WHY IT IS THE INPUTS AND NOT JUST THE PRICES. The
 * snapshot stores every resolved cost input behind each price, not merely the
 * resulting numbers. Storing only the prices makes a campaign unauditable the
 * moment anyone asks why a variant was priced as it was — and "the metal price
 * has moved since" is not an answer a dispute accepts. With the inputs, the
 * campaign can be RECOMPUTED years later and shown to be what it claimed.
 *
 * `frozenAsOf` is recorded for the same reason: a recomputation must resolve
 * inputs at the instant the freeze used, not at "now".
 *
 * ONE TRANSACTION. A campaign that is open but half-frozen would be quoting
 * prices with no recorded basis. The database also refuses that state
 * outright — see the open_is_frozen CHECK — so this cannot be got wrong by a
 * later caller either.
 *
 * SAFETY IS CHECKED BEFORE OPENING, NOT AFTER. The README requires every
 * allowed variant to be validated against the margin, dollar-profit and
 * variant floors before publication, with unsafe tiers blocked or explicitly
 * overridden. An unsafe campaign therefore cannot open by accident: the
 * override is a separate, attributed argument that a caller has to supply on
 * purpose.
 */

export class CampaignNotDraftError extends Error {
  constructor(id: string, status: string) {
    super(`Campaign ${id} is ${status}; only a draft campaign can be opened.`);
    this.name = "CampaignNotDraftError";
  }
}

export class CampaignIncompleteError extends Error {
  constructor(id: string, problem: string) {
    super(`Campaign ${id} cannot open: ${problem}`);
    this.name = "CampaignIncompleteError";
  }
}

/**
 * Carries the report so the caller can show exactly which variant and tier
 * failed, and why — refusing without saying what is wrong just moves the
 * guesswork to a human.
 */
export class UnsafeTiersError extends Error {
  constructor(
    readonly report: TierSafetyReport,
    readonly summary: string
  ) {
    super(`Campaign cannot open: ${summary}`);
    this.name = "UnsafeTiersError";
  }
}

/**
 * The campaign's price ladder does not fall monotonically for some variant.
 *
 * SEPARATE FROM UnsafeTiersError, and deliberately not carrying an override
 * path. The two faults are different in kind: an unsafe tier sells at a margin
 * the owner may still accept, while a rising price makes the storefront state
 * something false. Sharing an error type would invite sharing the override.
 */
export class BrokenPriceLadderError extends Error {
  constructor(
    readonly report: TierSafetyReport,
    readonly summary: string
  ) {
    super(
      `Campaign cannot open — the price ladder does not only fall: ${summary}. ` +
        `This cannot be overridden; adjust the tier multipliers so every tier's ` +
        `Bank Payment Price falls and its Regular/Card Price does not rise.`
    );
    this.name = "BrokenPriceLadderError";
  }
}

export interface OpenCampaignOptions {
  campaignId: string;
  openedBy: string;
  /** Resolution instant. An input, never a clock read, so opens are reproducible. */
  asOf?: Date;
  /**
   * Required to open a campaign whose tiers breach a floor. Both fields must be
   * present together; the database refuses a half-recorded override.
   */
  unsafeOverride?: { by: string; reason: string };
}

export interface OpenCampaignResult {
  campaignId: string;
  openedAt: Date;
  frozenAsOf: Date;
  variantCount: number;
  tierCount: number;
  safety: TierSafetyReport;
  openedWithOverride: boolean;
}

export async function openGroupBuyCampaign(
  options: OpenCampaignOptions
): Promise<OpenCampaignResult> {
  const asOf = options.asOf ?? new Date();

  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: options.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  if (campaign.status !== "draft") {
    throw new CampaignNotDraftError(campaign.id, campaign.status);
  }
  if (campaign.variants.length === 0) {
    throw new CampaignIncompleteError(campaign.id, "it has no eligible variants");
  }

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));

  // Throws with every problem at once rather than the first.
  validateTierSet(tiers);

  // Resolve and price each eligible variant AT THE FREEZE INSTANT. This is the
  // same pipeline Buy Now uses — a second implementation would be free to
  // drift, and the drift would appear as a campaign whose frozen base price
  // disagreed with the Buy Now price for the identical variant on the same day.
  interface PricedVariant {
    masterVariantId: string;
    inputs: BuyNowPricingInputs;
    result: BuyNowPriceResult;
    profile: BuyNowPricingInputs["profile"];
    pricingProfileId: string;
    /** The frozen base is the BANK PAYMENT price; tier multipliers apply to it. */
    baseBankPaymentPriceMinorUnits: bigint;
    landedCostMinorUnits: MoneyDecimalValue;
    variantFloorMinorUnits: MoneyDecimalValue;
  }

  const priced: PricedVariant[] = [];
  for (const variant of campaign.variants) {
    const resolved = await resolveInputsForVariant(variant.masterVariantId, asOf);
    const result = computeBuyNowPrice(resolved.inputs);

    priced.push({
      masterVariantId: variant.masterVariantId,
      inputs: resolved.inputs,
      result,
      profile: resolved.inputs.profile,
      pricingProfileId: resolved.pricingProfileId,
      // THE BANK PAYMENT PRICE IS WHAT FREEZES. Tier multipliers apply to it and tier
      // safety judges it; the credit-card price is re-derived for display from
      // whatever bank price a tier produces, so freezing it too would store a
      // second number that could only ever agree or be wrong.
      baseBankPaymentPriceMinorUnits: BigInt(result.bankPaymentPrice.amountMinorUnits),
      landedCostMinorUnits: new MoneyDecimal(result.breakdown.landedCostMinorUnits),
      variantFloorMinorUnits: new MoneyDecimal(resolved.inputs.variantFloor?.amountMinorUnits ?? "0"),
    });
  }

  const first = priced[0]!;

  // Every variant against every tier — not just the deepest. A variant-specific
  // floor can sit above an INTERMEDIATE tier.
  const safety = evaluateTierSafety({
    variants: priced.map((p) => ({
      masterVariantId: p.masterVariantId,
      frozenBaseBankPaymentMinorUnits: p.baseBankPaymentPriceMinorUnits,
      landedCostMinorUnits: p.landedCostMinorUnits,
      variantFloorMinorUnits: p.variantFloorMinorUnits,
    })),
    tiers,
    profile: first.profile,
    roundingRuleId: first.profile.roundingRuleId,
    priceEndingRuleId: first.profile.priceEndingRuleId,
    // The card rule this campaign is about to freeze. Used only to validate the
    // displayed price ladder; it reaches no floor.
    regularCardPriceRuleId: first.profile.regularCardPriceRuleId,
    fixedCardUpliftRate: first.profile.fixedCardUpliftRate,
    currency: campaign.currency,
  });

  // A BROKEN PRICE LADDER IS NOT OVERRIDABLE, and that is the one place this
  // differs from a floor breach.
  //
  // The override exists so an owner can knowingly sell at a thin margin — a
  // commercial judgement that is theirs to make. There is no equivalent
  // judgement behind "the price rises as the group grows": the storefront would
  // tell a shopper the price drops at the next tier and then charge more. No
  // authority makes that true, so no authority can approve it.
  //
  // Checked BEFORE the override is consulted, so an override supplied for a
  // margin breach cannot carry a ladder fault through with it.
  if (safety.priceLadderProblems.length > 0) {
    throw new BrokenPriceLadderError(
      safety,
      safety.priceLadderProblems.map((p) => p.detail).join("; ")
    );
  }

  if (!safety.allSafe && !options.unsafeOverride) {
    const summary = safety.unsafe
      .map((u) => `variant ${u.masterVariantId} tier ${u.tierNumber} fails ${u.evaluation.failing.join(", ")}`)
      .join("; ");
    throw new UnsafeTiersError(safety, summary);
  }

  // The reproducibility contract. Normalised through JSON before hashing, the
  // same as pricing snapshots: the inputs carry optional fields that are
  // `undefined` in memory, and the canonicalizer refuses `undefined` rather
  // than guessing whether it meant "absent" or "null".
  const payload = JSON.parse(
    JSON.stringify({
      kind: "groupbuy.campaign_freeze.v1",
      campaignId: campaign.id,
      frozenAsOf: asOf.toISOString(),
      tiers,
      variants: priced.map((p) => ({
        masterVariantId: p.masterVariantId,
        inputs: p.inputs,
        result: p.result,
      })),
    })
  ) as JsonValue;

  const contentHash = hashCanonicalJson(payload);
  const openedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const snapshot = await tx.snapshot.create({
      data: { kind: "groupbuy.campaign_freeze.v1", payload: payload as never, contentHash },
    });

    // Frozen prices are written while the campaign is STILL DRAFT — the
    // database trigger refuses writes to these tables once it is not.
    for (const p of priced) {
      await tx.groupBuyCampaignVariant.update({
        where: { campaignId_masterVariantId: { campaignId: campaign.id, masterVariantId: p.masterVariantId } },
        data: {
          frozenBaseBankPaymentPriceMinorUnits: p.baseBankPaymentPriceMinorUnits,
          frozenLandedCostMinorUnits: BigInt(p.landedCostMinorUnits.toDecimalPlaces(0).toString()),
        },
      });
    }

    await tx.groupBuyCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "open",
        openedAt,
        frozenAsOf: asOf,
        snapshotId: snapshot.id,
        pricingProfileId: first.pricingProfileId,
        profileVersion: first.profile.version,
        ...(options.unsafeOverride
          ? {
              unsafeOverrideBy: options.unsafeOverride.by,
              unsafeOverrideReason: options.unsafeOverride.reason,
              unsafeOverrideAt: openedAt,
            }
          : {}),
      },
    });
  });

  // Logged at WARN when opened over a breach: a campaign selling below an
  // approved floor is an exceptional event even when authorised.
  const log = safety.allSafe ? logger.info : logger.warn;
  log("groupbuy.campaign_opened", {
    campaignId: campaign.id,
    openedBy: options.openedBy,
    variantCount: priced.length,
    tierCount: tiers.length,
    unsafeTierCount: safety.unsafe.length,
    openedWithOverride: Boolean(options.unsafeOverride),
    // No prices, costs or margins in logs (criterion 30).
  });

  return {
    campaignId: campaign.id,
    openedAt,
    frozenAsOf: asOf,
    variantCount: priced.length,
    tierCount: tiers.length,
    safety,
    openedWithOverride: Boolean(options.unsafeOverride),
  };
}
