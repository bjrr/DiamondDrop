/**
 * PRICE PREVIEW for a draft Group Buy campaign (§9).
 *
 * Answers one question for the merchant configuring a campaign: "if I opened
 * this today, what would each configuration cost at each tier?"
 *
 * ===========================================================================
 * IT REPRODUCES NO PRICING. IT COMPOSES THE REAL ENGINE.
 * ===========================================================================
 * Every number here comes out of the same functions the open path and the
 * storefront already use, called in the same order:
 *
 *   resolveInputsForVariant  ->  the variant's pricing inputs
 *   computeBuyNowPrice       ->  its Bank Payment Price (the authoritative
 *                                selling price, CLAUDE.md rule 11)
 *   campaignTierDualPrices   ->  each tier's Bank Payment Price, and the
 *                                Regular/Card Price derived from it
 *
 * The first two are lifted verbatim from `openGroupBuyCampaign`'s own
 * pricing loop. The third is `campaignTierPricing.ts`, which exists
 * specifically so that "every surface that quotes a Group Buy price" uses
 * one definition — its header says so, and a preview that did its own
 * multiplication and rounding would be exactly the second copy that module
 * was written to prevent.
 *
 * There is no arithmetic in this file. Not one multiplication, no rounding,
 * no currency formatting of a raw number. If a figure here is wrong, it is
 * wrong on the storefront too, which is the property a preview needs.
 *
 * ===========================================================================
 * PROVISIONAL, AND LABELLED AS SUCH
 * ===========================================================================
 * A draft campaign has frozen nothing. `GroupBuyCampaignVariant`'s
 * `frozenBaseBankPaymentPriceMinorUnits` is written during open, inside the
 * transaction that flips the status. So a preview cannot read a frozen base
 * price; it has to compute today's, from today's costs and today's pricing
 * profile.
 *
 * That makes every figure PROVISIONAL. Metal costs move, so a preview run
 * this morning and an open this afternoon can legitimately differ. The
 * result carries `pricedAsOf` and the caller is expected to say so on screen
 * — a preview presented as the final price would be a promise this function
 * cannot keep.
 *
 * It also means this file does NOT touch the §8 open/freeze sequence. It
 * reads, computes and returns. Nothing is written, nothing is frozen, and
 * `openGroupBuyCampaign` is not called, imported, or altered.
 *
 * ===========================================================================
 * NO COST, NO MARGIN, NO FLOOR, NO PROFILE ID
 * ===========================================================================
 * §9 is explicit, and so is CLAUDE.md rule 10. `computeBuyNowPrice` returns
 * a full breakdown including landed cost; `resolveInputsForVariant` returns
 * the profile and its id. NONE of that is carried into the returned type.
 * What leaves this module is the pair of customer-facing prices per tier,
 * and nothing else. The returned type is the fence: there is no field to put
 * a cost in, so no caller can leak one by accident.
 */

import {
  campaignTierDualPrices,
  type FrozenCampaignPricingRules,
} from "~/domain/groupbuy/campaignTierPricing";
import {
  configurationSignature,
  describeVariantGroup,
  variantGroupsOf,
  type CampaignBuilderState,
  ConfigurationSpaceTooLargeError,
} from "~/domain/groupbuy/campaignBuilder";
import type { TierDefinition } from "~/domain/groupbuy/tiers";
import { computeBuyNowPrice } from "~/domain/pricing/engine";
import { MoneyDecimal } from "~/domain/money/decimal";
import { resolveInputsForVariant } from "~/jobs/pricing/resolveInputs.server";
import { prisma } from "~/db/client.server";
import { logger } from "~/lib/logger.server";

/** One tier's two customer-facing prices, in integer minor units. */
export interface PreviewTierPrice {
  readonly tierNumber: number;
  readonly bankPaymentMinorUnits: string;
  readonly regularCardMinorUnits: string;
}

export interface PreviewRow {
  /** The variant-group signature, so the UI can line this up with the mapping table. */
  readonly variantGroupSignature: string;
  /** Merchant-facing description, e.g. "Diamond shape: Oval / Metal: Platinum". */
  readonly description: string;
  /** How many purchasable configurations price from this row. */
  readonly configurationCount: number;
  /**
   * Present when this row priced successfully. Absent when it did not — a
   * row is never silently dropped, because a merchant who cannot see that a
   * variant failed to price would open the campaign believing it was fine.
   */
  readonly tierPrices?: readonly PreviewTierPrice[];
  /** Why this row could not be priced, in words a merchant can act on. */
  readonly problem?: string;
}

export interface CampaignPricePreview {
  readonly currency: string;
  /** The instant the costs were read. Every figure is only true as of this. */
  readonly pricedAsOf: string;
  readonly tiers: readonly { readonly tierNumber: number; readonly label: string }[];
  readonly rows: readonly PreviewRow[];
  /** Problems that stopped the whole preview rather than one row. */
  readonly problems: readonly string[];
}

/**
 * Prices every mapped variant group in a draft campaign's builder state.
 *
 * UNMAPPED GROUPS ARE SKIPPED, NOT GUESSED (§6). A group with no
 * `MasterVariant` has no pricing inputs to resolve, so it appears as a row
 * with a problem rather than being matched to some nearby variant.
 *
 * ONE FAILED VARIANT DOES NOT FAIL THE PREVIEW. A variant whose inputs are
 * incomplete throws out of `resolveInputsForVariant` or
 * `computeBuyNowPrice`; that is caught per row so the merchant sees the 80
 * rows that worked alongside the one that did not. The open path's own
 * validation still refuses the open — this is a preview, and its job is to
 * show the merchant where the problem is.
 */
export async function previewGroupBuyCampaignPrices(
  campaignId: string,
  state: CampaignBuilderState,
  options: { readonly asOf?: Date } = {}
): Promise<CampaignPricePreview> {
  const asOf = options.asOf ?? new Date();

  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { id: campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } } },
  });
  if (!campaign) {
    return { currency: "USD", pricedAsOf: asOf.toISOString(), tiers: [], rows: [], problems: ["Campaign not found."] };
  }

  const tiers: TierDefinition[] = campaign.tiers.map((tier) => ({
    tierNumber: tier.tierNumber,
    minQualifyingUnits: tier.minQualifyingUnits,
    priceMultiplier: tier.priceMultiplier.toString(),
  }));

  // GroupBuyCampaignTier carries no label column, so the heading is derived
  // the same way the rest of the admin reads a tier: by its number and the
  // unit count that unlocks it.
  const tierSummary = campaign.tiers.map((tier) => ({
    tierNumber: tier.tierNumber,
    label: `Tier ${tier.tierNumber} (from ${tier.minQualifyingUnits} unit${tier.minQualifyingUnits === 1 ? "" : "s"})`,
  }));

  if (tiers.length === 0) {
    return {
      currency: campaign.currency,
      pricedAsOf: asOf.toISOString(),
      tiers: [],
      rows: [],
      problems: ["Add the Group Buy tiers first. Without them there is no tier price to preview."],
    };
  }

  let groups;
  try {
    groups = variantGroupsOf(state);
  } catch (error) {
    if (error instanceof ConfigurationSpaceTooLargeError) {
      return {
        currency: campaign.currency,
        pricedAsOf: asOf.toISOString(),
        tiers: tierSummary,
        rows: [],
        problems: [error.message],
      };
    }
    throw error;
  }

  const rows: PreviewRow[] = [];

  for (const group of groups) {
    const description = describeVariantGroup(state, group) || "This configuration";
    const base = {
      variantGroupSignature: group.signature,
      description,
      configurationCount: group.configurationSignatures.length,
    };

    if (group.masterVariantId === null) {
      rows.push({ ...base, problem: "Not priced yet: choose a product variant for this configuration first." });
      continue;
    }

    try {
      // THE SAME TWO CALLS `openGroupBuyCampaign` MAKES, in the same order.
      const resolved = await resolveInputsForVariant(group.masterVariantId, asOf);
      const result = computeBuyNowPrice(resolved.inputs);

      // Rules come from the profile this variant actually resolved against.
      // A draft campaign has frozen nothing, so there is no frozen profile to
      // read instead — which is precisely why this preview is provisional.
      const rules: FrozenCampaignPricingRules = {
        currency: result.bankPaymentPrice.currency,
        fixedCardUpliftRate: new MoneyDecimal(resolved.inputs.profile.fixedCardUpliftRate),
        regularCardPriceRuleId: resolved.inputs.profile.regularCardPriceRuleId,
        roundingRuleId: resolved.inputs.profile.roundingRuleId,
        priceEndingRuleId: resolved.inputs.profile.priceEndingRuleId,
      };

      const dualPrices = campaignTierDualPrices(
        BigInt(result.bankPaymentPrice.amountMinorUnits),
        tiers,
        rules
      );

      rows.push({
        ...base,
        tierPrices: tiers.map((tier) => {
          const dual = dualPrices[tier.tierNumber]!;
          return {
            tierNumber: tier.tierNumber,
            bankPaymentMinorUnits: dual.bankPaymentMinorUnits.toString(),
            regularCardMinorUnits: dual.regularCardMinorUnits.toString(),
          };
        }),
      });
    } catch (error) {
      // The message is the engine's own, which names the missing input
      // (a metal cost, a stone, a weight). Deliberately not replaced with
      // "could not be priced": the merchant needs to know WHICH input.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("group_buy_price_preview.variant_failed", {
        campaignId,
        masterVariantId: group.masterVariantId,
        reason: message,
      });
      rows.push({ ...base, problem: message });
    }
  }

  return {
    currency: campaign.currency,
    pricedAsOf: asOf.toISOString(),
    tiers: tierSummary,
    rows,
    problems: [],
  };
}

/**
 * The mapping table's other half: which `MasterVariant`s a merchant may
 * choose from, labelled so they never have to type or recognise an id (§6).
 *
 * Deliberately returns ONLY id and label. A variant's supplier cost, raw
 * vendor SKU and internal pricing components are all reachable from this
 * query and none of them belong in an option list.
 */
export interface MappableVariantOption {
  readonly masterVariantId: string;
  readonly label: string;
}

export async function listMappableVariantsForCampaign(
  campaignId: string
): Promise<readonly MappableVariantOption[]> {
  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { id: campaignId },
    include: {
      variants: {
        include: {
          masterVariant: {
            include: { masterProduct: { select: { name: true } }, band: { select: { label: true } } },
          },
        },
      },
    },
  });
  if (!campaign) return [];

  return campaign.variants
    .map((row) => {
      const variant = row.masterVariant;
      const parts = [
        variant.masterProduct.name,
        variant.metal,
        variant.purity,
        variant.band?.label ? `size ${variant.band.label}` : null,
      ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
      return {
        masterVariantId: variant.id,
        label: parts.join(" / "),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Re-exported so a caller can line a preview row up with a configuration. */
export { configurationSignature };
