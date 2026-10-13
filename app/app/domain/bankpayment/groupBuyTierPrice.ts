import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import type { RoundingRuleId } from "~/domain/money/rounding";
import { tierBankPaymentPriceExact, type TierDefinition } from "~/domain/groupbuy/tiers";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { DecimalString, PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";

/**
 * Group Buy Bank Payment checkout — the price a variant is actually charged
 * at the campaign's CURRENT tier, computed from its FROZEN base.
 *
 * THE SAME (BANK-IN, ROUND, END, CARD-DERIVE) PIPELINE ALREADY USED BY
 * `~/jobs/groupbuy/tierPriceSync.server.ts` (publishing the tier price to
 * Shopify) and `~/db/repositories/groupBuyRepository.server.ts`'s
 * `recordGroupBuyTierRefund` (settlement) — restated here rather than
 * imported because neither of those lives in a module this route may import
 * without pulling in machinery it does not need (a live `ShopifyPriceSyncPort`
 * resolver, or campaign-close/refund-ledger state), but the ARITHMETIC itself
 * is never reinvented: every step below is the same exported pure function
 * those two callers use, in the same order. A fourth divergent formula is
 * exactly the defect `tierPriceSync.server.ts`'s own module comment warns
 * against for the first two copies.
 *
 * NEVER `getPublishedVariantPrice`. That resolver serves ordinary Buy Now
 * pricing, and a variant belonging to an OPEN Group Buy campaign is
 * deliberately excluded from it (`OpenCampaignExclusionSource`,
 * `~/jobs/pricing/ports.ts`) — the frozen campaign basis is the only correct
 * source for this price, by construction.
 */
export interface GroupBuyTierPricingProfile {
  roundingRuleId: RoundingRuleId;
  priceEndingRuleId: PriceEndingRuleId;
  regularCardPriceRuleId: RegularCardPriceRuleId;
  fixedCardUpliftRate: DecimalString;
}

export interface GroupBuyTierLinePrice {
  /** The price actually charged — the current tier's Bank Payment Price from the frozen base. */
  bankPaymentPriceMinorUnits: bigint;
  /** HISTORICAL/COMPARISON FACT ONLY — never charged by this route. */
  regularCardPriceMinorUnits: bigint;
}

/**
 * `frozenBaseBankPaymentPriceMinorUnits` is `GroupBuyCampaignVariant`'s own
 * frozen base — exact bigint minor units, never a float.
 */
export function computeGroupBuyTierLinePrice(
  frozenBaseBankPaymentPriceMinorUnits: bigint,
  tier: TierDefinition,
  profile: GroupBuyTierPricingProfile,
  currency: string
): GroupBuyTierLinePrice {
  const exactBankPayment = tierBankPaymentPriceExact(
    new MoneyDecimal(frozenBaseBankPaymentPriceMinorUnits.toString()),
    tier
  );
  const rounded = Money.fromDecimalMinorUnits(exactBankPayment, currency, profile.roundingRuleId);
  const bankPaymentPriceMinorUnits = applyPriceEnding(rounded.amountMinorUnits, profile.priceEndingRuleId);

  const card = deriveRegularCardPrice(
    bankPaymentPriceMinorUnits,
    new MoneyDecimal(profile.fixedCardUpliftRate),
    profile.regularCardPriceRuleId
  );

  return {
    bankPaymentPriceMinorUnits,
    regularCardPriceMinorUnits: card.regularCardPriceMinorUnits,
  };
}
