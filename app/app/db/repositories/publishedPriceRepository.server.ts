import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { DecimalString, RegularCardPriceRuleId } from "~/domain/pricing/types";

import { prisma } from "../client.server";

/**
 * The PUBLISHED price resolver (Slice 2 stage 2B entry condition C1 / spec
 * `docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md` §16.2 criterion 52).
 *
 * THE HAZARD THIS CLOSES. `price_calculation` rows accumulate: a
 * recalculation writes a new one whether or not it ever reaches Shopify.
 * `master_variant.lastSyncedPriceCalculationId` names the one actually
 * published — see `getLastSyncedCalculation` in
 * `priceCalculationRepository.server.ts`, which this module builds on. A
 * customer-facing surface that instead read "the newest calculation" would
 * advertise a price checkout will not honour, and it would do so MOST
 * VISIBLY exactly when auto-publish is off and approvals are queued, which
 * is the system's actual current state.
 *
 * THIS IS THE ONLY WAY A CUSTOMER-FACING SURFACE MAY LEARN A VARIANT'S
 * PRICE. Every customer-facing surface — collection card, search card, PDP,
 * cart, and any App Proxy JSON feeding them — must call
 * `getPublishedVariantPrice` rather than querying `price_calculation`
 * directly, so the three published figures (bank, card, saving) can never
 * come from different points in time and a variant with no synced
 * calculation can never be treated as purchasable.
 *
 * ONE ROW, THREE FIGURES. The Bank Payment Price is read from the synced
 * calculation as stored. The Regular/Card Price and the saving are DERIVED
 * from it using THAT CALCULATION'S OWN pricing profile and rule — never
 * today's active profile (contract C-S2 note 2; mirrors the identical
 * discipline in `syncApprovedIntent.server.ts`). A calculation synced under
 * a legacy rule must keep reproducing its legacy card price forever, even
 * after the active profile moves on to a newer rule.
 *
 * NOT PURCHASABLE MEANS NOT PURCHASABLE. A variant with no
 * `lastSyncedPriceCalculationId` returns `{ kind: "not_purchasable" }`
 * rather than falling back to the latest computed calculation, an override,
 * or anything else. Falling back to any other row is exactly how a
 * never-published price would reach a customer.
 */

export interface PublishedVariantPrice {
  readonly masterVariantId: string;
  /** The synced calculation every one of these three figures is derived from. */
  readonly priceCalculationId: string;
  /** The stored figure, unchanged — never re-derived, never re-rounded. */
  readonly bankPaymentPriceMinorUnits: bigint;
  /** Final rounded Regular/Card Price — the $5-ceilinged figure, never the preliminary uplift. */
  readonly regularCardPriceMinorUnits: bigint;
  /** regularCardPriceMinorUnits − bankPaymentPriceMinorUnits, computed AFTER rounding (policy §9). */
  readonly bankPaymentSavingsMinorUnits: bigint;
  readonly currency: string;
  /** INTERNAL ONLY — audit/admin. Never send to a customer-facing surface, App Proxy JSON, Liquid, metafield or log (C-S5, R14). */
  readonly appliedUpliftRate: DecimalString;
  /** INTERNAL ONLY — audit/admin. Never send to a customer-facing surface, App Proxy JSON, Liquid, metafield or log (C-S5, R14). */
  readonly appliedTierLabel: string;
}

export type PublishedVariantPriceResult =
  | { readonly kind: "purchasable"; readonly price: PublishedVariantPrice }
  | { readonly kind: "not_purchasable"; readonly masterVariantId: string; readonly reason: "unsynced" };

export class MasterVariantNotFoundError extends Error {
  constructor(readonly masterVariantId: string) {
    super(`No master_variant with id ${masterVariantId}.`);
    this.name = "MasterVariantNotFoundError";
  }
}

/**
 * The single resolver every customer-facing surface uses (criterion 52).
 *
 * Resolves `master_variant.lastSyncedPriceCalculationId`, loads THAT
 * calculation's own pricing profile, and derives the card price and saving
 * from it — never from whatever profile happens to be active today. Returns
 * `not_purchasable` rather than throwing when the variant has never synced;
 * throwing would make every caller special-case "no such variant" and "not
 * yet published" identically, when only the latter is a routine, expected
 * outcome for a brand-new or not-yet-approved variant.
 */
export async function getPublishedVariantPrice(masterVariantId: string): Promise<PublishedVariantPriceResult> {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: masterVariantId },
    select: { lastSyncedPriceCalculationId: true },
  });
  if (!variant) throw new MasterVariantNotFoundError(masterVariantId);

  if (!variant.lastSyncedPriceCalculationId) {
    return { kind: "not_purchasable", masterVariantId, reason: "unsynced" };
  }

  // findUniqueOrThrow, not findUnique: the anchor is a foreign key to an
  // append-only table, so a resolved id that fails to load is a data
  // -integrity bug worth failing loudly on, not a routine "not purchasable".
  const calc = await prisma.priceCalculation.findUniqueOrThrow({
    where: { id: variant.lastSyncedPriceCalculationId },
    include: { pricingProfile: true },
  });

  // THE CALCULATION'S OWN PROFILE, joined in the SAME query as the
  // calculation itself — never a separate "active profile" lookup. This is
  // the exact discipline `syncApprovedIntent.server.ts` uses to publish the
  // legacy figure for a historical calculation while the active profile
  // carries a newer rule (spec §4.1 criterion 3 / test plan case 5).
  const derived = deriveRegularCardPrice(
    calc.bankPaymentPriceMinorUnits,
    new MoneyDecimal(calc.pricingProfile.fixedCardUpliftRate.toString()),
    calc.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId
  );

  return {
    kind: "purchasable",
    price: {
      masterVariantId,
      priceCalculationId: calc.id,
      bankPaymentPriceMinorUnits: calc.bankPaymentPriceMinorUnits,
      regularCardPriceMinorUnits: derived.regularCardPriceMinorUnits,
      bankPaymentSavingsMinorUnits: derived.bankPaymentSavingsMinorUnits,
      currency: calc.currency,
      appliedUpliftRate: derived.appliedUpliftRate,
      appliedTierLabel: derived.appliedTierLabel,
    },
  };
}
