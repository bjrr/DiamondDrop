import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import type { RoundingRuleId } from "~/domain/money/rounding";
import { tierBankPaymentPriceExact } from "~/domain/groupbuy/tiers";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { logger } from "~/lib/logger.server";

import { getCurrentTier } from "./unitLedger.server";

/**
 * Publishing an OPEN campaign's CURRENT tier price to Shopify — the piece
 * `docs/ARCHITECTURE-MVP1.md` §6.1 describes ("the Shopify variant price is
 * set to the current tier price and updated when a tier unlocks") but that
 * nothing in the codebase actually did before this file: `openCampaign.server.ts`
 * freezes the per-variant price ladder in Postgres and never calls Shopify,
 * and the unit ledger (`unitLedger.server.ts`) only ever folds events and
 * recomputes the tier — it has no notion of what Shopify currently shows.
 *
 * REUSES THE EXISTING PUBLISH PATH, DOES NOT DUPLICATE IT. The only module
 * in this app that is allowed to call `productVariantsBulkUpdate` is
 * `ShopifyPriceSyncAdapter` (`~/shopify/admin/priceSyncAdapter.server.ts`),
 * reached here through the same `ShopifyPriceSyncPort` interface
 * (`~/jobs/pricing/ports.ts`) Buy Now's sync job uses. What is NOT reused is
 * `syncApprovedIntent.server.ts`'s ORCHESTRATION — that state machine is
 * built entirely around `price_sync_intent` and `price_calculation`, neither
 * of which a Group Buy tier has: a tier price is not a human-approved
 * recalculation, it is a deterministic consequence of the frozen snapshot
 * plus the live qualifying-unit count, already safety-checked once at
 * `openGroupBuyCampaign` time. Routing it through the approval/placeholder/
 * compare-and-set machinery built for a DIFFERENT trigger would either
 * silently no-op (no `price_calculation` row ever exists for a Group Buy
 * variant) or require bending that state machine to a shape it was not
 * built for. The one thing genuinely shared — "how do you actually tell
 * Shopify a variant's price" — is exactly the `ShopifyPriceSyncPort` call
 * below.
 *
 * THE SAME (BANK-IN, ROUND, END, CARD-DERIVE) PIPELINE THE STOREFRONT
 * TRUSTS. `tierBankPaymentPriceExact` -> `Money.fromDecimalMinorUnits`
 * (rounding) -> `applyPriceEnding` -> `deriveRegularCardPrice`, in that
 * order, under the campaign's FROZEN pricing profile — the identical
 * sequence `tierSafety.ts` used to certify this campaign safe to open and
 * `apps.carat.group-buy.$code.tsx` uses to render the storefront's own tier
 * table. A second formula here would be free to drift from what a customer
 * is shown and what Shopify actually charges; there is deliberately only
 * one place this arithmetic exists (`app/domain/groupbuy/tiers.ts` plus the
 * pricing domain's rounding/card registries), and this file only composes
 * those existing exports.
 *
 * IDEMPOTENT ACROSS WEBHOOK REDELIVERY WITHOUT A NEW COLUMN. The obvious
 * design — a `lastSyncedTierNumber` column on `GroupBuyCampaign` — would
 * need a migration, and this slice deliberately avoids one: multiple slices
 * are touching this schema concurrently, and this feature does not need a
 * new column to be correct. Instead, "campaign X has already had tier N
 * published in full" is answered by the EXISTING append-only `audit_event`
 * table: `ensureGroupBuyCampaignSyncedToCurrentTier` writes a single
 * completion marker (`groupbuy.tier_price_synced`, entityType
 * `group_buy_campaign`, entityId = campaignId) ONLY after every eligible
 * variant's price call has succeeded, and checks for an existing marker at
 * or above the target tier BEFORE calling Shopify at all.
 *
 * THIS IS WHAT MAKES A FAILED SYNC RETRYABLE, WHICH A DUPLICATE-GATED DESIGN
 * WOULD NOT BE. The unit ledger's own idempotency
 * (`group_buy_unit_event.campaignId_externalRef`) answers "was this webhook
 * delivery's UNIT already recorded" — it says nothing about whether the
 * Shopify PRICE for that tier was ever actually published. If this
 * function's own idempotency were instead "skip when `recordUnitEvent`
 * reported `duplicate: true`", a webhook whose Admin API call failed on
 * attempt 1 would see `duplicate: true` on every redelivery from attempt 2
 * onward and would NEVER retry the publish — Shopify would stay stale
 * forever with nothing to correct it. Checking the completion marker
 * instead of the unit-ledger's duplicate flag means every redelivery keeps
 * retrying an incomplete sync regardless of whether the unit itself was new
 * or a replay, and `applyVariantPrice` publishing the same price twice is a
 * harmless no-op (it is not additive the way a unit count is).
 */

/**
 * EXPORTED because the campaign admin route needs to read this marker to show
 * staff whether the current tier reached Shopify. It was briefly duplicated
 * as string literals in the repository — which meant renaming it here would
 * silently make that read stop matching, and the admin would report a tier as
 * PUBLISHED when it was not. A false reassurance on a safety indicator is
 * worse than no indicator, so there is exactly one definition.
 */
export const TIER_SYNCED_ACTION = "groupbuy.tier_price_synced";
export const TIER_SYNC_ENTITY_TYPE = "group_buy_campaign";
const TIER_VARIANT_SYNCED_ACTION = "groupbuy.tier_variant_price_synced";
const TIER_VARIANT_SYNC_ENTITY_TYPE = "group_buy_campaign_variant";

export interface EnsureCampaignSyncedToTierResult {
  campaignId: string;
  tierNumber: number;
  /** True when a prior completed sync already covers this tier (or a later one) — no Shopify call was made. */
  skipped: boolean;
  syncedVariantCount: number;
  /**
   * Eligible variants that have no Shopify product/variant id yet. NOT an
   * error and never throws — see the loop's own comment on why a missing
   * LINKAGE (nothing to call yet) is a materially different condition from a
   * failed CALL (something to call, and it did not work). Zero for every
   * caller reached from the `orders/create` webhook, where the ordered
   * variant is resolved BY its `shopifyVariantGid` and so is linked by
   * construction; only realistic from `openGroupBuyCampaign`, where a
   * campaign can legitimately include a variant whose Shopify product has
   * not been created/synced yet.
   */
  unresolvedVariantCount: number;
}

/**
 * A price call failed for at least one variant. Thrown rather than swallowed
 * so the webhook delivery that triggered this is marked failed and Shopify
 * redelivers — see the module doc comment on why redelivery is exactly what
 * makes this safe to retry rather than merely logged and forgotten.
 */
export class GroupBuyTierPriceSyncError extends Error {
  constructor(
    readonly campaignId: string,
    readonly tierNumber: number,
    readonly failures: readonly string[]
  ) {
    super(
      `groupbuy tier price sync incomplete for campaign ${campaignId} tier ${tierNumber}: ${failures.join("; ")}`
    );
    this.name = "GroupBuyTierPriceSyncError";
  }
}

async function wasTierAlreadyFullySynced(campaignId: string, tierNumber: number): Promise<boolean> {
  // Bounded by MAX_TIERS (5) completion markers per campaign over its whole
  // life — small enough to read in full rather than needing a `take`/order
  // trick to find "the latest".
  const markers = await prisma.auditEvent.findMany({
    where: { entityType: TIER_SYNC_ENTITY_TYPE, entityId: campaignId, action: TIER_SYNCED_ACTION },
    select: { after: true },
  });
  return markers.some((marker) => {
    const after = marker.after as { tierNumber?: unknown } | null;
    return typeof after?.tierNumber === "number" && after.tierNumber >= tierNumber;
  });
}

/**
 * Ensures every eligible variant of an OPEN campaign is published on Shopify
 * at the campaign's CURRENT tier price. A no-op (no Shopify call at all) when
 * that tier has already been fully published. Call this after recording a
 * qualifying-unit event — see the module doc comment for why it is safe (and
 * necessary) to call regardless of whether that event turned out to be a
 * fresh unit or a webhook replay.
 *
 * TAKES A LAZY RESOLVER, NOT A RESOLVED PORT. `openGroupBuyCampaign` calls
 * this unconditionally on every open, and a campaign can legitimately have
 * every eligible variant still unlinked to Shopify (see the `unresolved`
 * handling below) — every pre-existing Group Buy integration fixture in this
 * codebase is exactly that shape. Resolving a real Admin API client
 * (`createProductionPriceSyncPort`, which obtains a live offline-session
 * client for the shop) EAGERLY, before knowing whether any variant is even
 * linked, would mean every one of those opens attempts a real Shopify call —
 * and fails on it — purely as a side effect of calling this function at all.
 * The resolver is therefore invoked at most once per call, lazily, the first
 * time a variant is actually found to have Shopify ids to publish to; a
 * campaign with zero linked variants never touches Shopify or the resolver.
 */
export async function ensureGroupBuyCampaignSyncedToCurrentTier(
  campaignId: string,
  deps: { resolveSyncPort: () => Promise<ShopifyPriceSyncPort> }
): Promise<EnsureCampaignSyncedToTierResult> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: {
      variants: { include: { masterVariant: { include: { masterProduct: true } } } },
      pricingProfile: true,
    },
  });

  if (campaign.status !== "open") {
    // Frozen pricing stays exactly as it is once a campaign is no longer
    // open (README: "at close ... frozen pricing stays exactly as it was").
    // Nothing to publish, and nothing here should ever try.
    return {
      campaignId,
      tierNumber: campaign.finalTierNumber ?? 0,
      skipped: true,
      syncedVariantCount: 0,
      unresolvedVariantCount: 0,
    };
  }

  if (!campaign.pricingProfile) {
    // Should be impossible for a campaign that reached `open` — openCampaign
    // always freezes a profile in the same transaction — but a defensive,
    // named failure beats a null-pointer deep in the rounding pipeline below.
    throw new Error(
      `groupbuy campaign ${campaignId} is open but has no frozen pricing profile — cannot derive a publishable price`
    );
  }

  const { tier } = await getCurrentTier(campaignId);

  if (await wasTierAlreadyFullySynced(campaignId, tier.tierNumber)) {
    return { campaignId, tierNumber: tier.tierNumber, skipped: true, syncedVariantCount: 0, unresolvedVariantCount: 0 };
  }

  const profile = campaign.pricingProfile;
  const upliftRate = new MoneyDecimal(profile.fixedCardUpliftRate.toString());
  const roundingRuleId = profile.roundingRuleId as RoundingRuleId;
  const priceEndingRuleId = profile.priceEndingRuleId as PriceEndingRuleId;
  const cardRuleId = profile.regularCardPriceRuleId as RegularCardPriceRuleId;

  const failures: string[] = [];
  const unresolved: string[] = [];
  let syncedCount = 0;

  // Resolved at most once, the first time a linked variant actually needs a
  // call — see this function's own doc comment for why eager resolution is
  // wrong here.
  let resolvedPort: ShopifyPriceSyncPort | null = null;
  async function getPort(): Promise<ShopifyPriceSyncPort> {
    resolvedPort ??= await deps.resolveSyncPort();
    return resolvedPort;
  }

  for (const variant of campaign.variants) {
    const shopifyVariantGid = variant.masterVariant.shopifyVariantGid;
    const shopifyProductGid = variant.masterVariant.masterProduct.shopifyProductGid;

    if (!shopifyVariantGid || !shopifyProductGid) {
      // NOT YET LINKED — a materially different condition from a failed
      // CALL below, and deliberately NOT a `failures` entry (that would
      // throw `GroupBuyTierPriceSyncError` for a condition no retry can
      // fix). A campaign can legitimately include a variant whose Shopify
      // product/variant does not exist yet — most concretely, every
      // pre-existing Group Buy fixture in this codebase's own integration
      // suite, which never assigns Shopify ids. Blocking `openGroupBuyCampaign`
      // on that would be wrong: there is nothing to call, not something that
      // failed to be called. Logged, tracked separately, and — see below —
      // withholds the completion marker so a LATER call (once the variant
      // is linked) still tries to publish it, rather than a normal retry
      // (an Admin API failure) which republishes everything including
      // variants that already succeeded.
      logger.warn("groupbuy.tier_sync_missing_shopify_linkage", {
        campaignId,
        masterVariantId: variant.masterVariantId,
        tierNumber: tier.tierNumber,
      });
      unresolved.push(variant.masterVariantId);
      continue;
    }

    const exactBankPayment = tierBankPaymentPriceExact(
      new MoneyDecimal(variant.frozenBaseBankPaymentPriceMinorUnits.toString()),
      tier
    );
    const rounded = Money.fromDecimalMinorUnits(exactBankPayment, campaign.currency, roundingRuleId);
    const groupBuyBankPaymentPriceMinorUnits = applyPriceEnding(rounded.amountMinorUnits, priceEndingRuleId);
    const card = deriveRegularCardPrice(groupBuyBankPaymentPriceMinorUnits, upliftRate, cardRuleId);
    const regularCardPrice = Money.fromMinorUnits(card.regularCardPriceMinorUnits, campaign.currency);

    try {
      const port = await getPort();
      await port.applyVariantPrice({
        shopifyProductGid,
        shopifyVariantGid,
        regularCardPrice,
        // Not a real price_calculation id — Group Buy tiers have none. A
        // stable, descriptive label; the real adapter never reads this
        // field (see priceSyncAdapter.server.ts), and RecordingPriceSyncPort
        // (tests) merely echoes it back.
        priceCalculationId: `groupbuy-tier:${campaignId}:${tier.tierNumber}`,
      });
      syncedCount += 1;

      await createAuditEvent({
        actorType: "system",
        actorRef: "groupbuy-tier-price-sync",
        action: TIER_VARIANT_SYNCED_ACTION,
        entityType: TIER_VARIANT_SYNC_ENTITY_TYPE,
        entityId: variant.id,
        after: {
          campaignId,
          tierNumber: tier.tierNumber,
          regularCardPriceMinorUnits: card.regularCardPriceMinorUnits.toString(),
          currency: campaign.currency,
        },
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.error("groupbuy.tier_variant_price_sync_failed", {
        campaignId,
        masterVariantId: variant.masterVariantId,
        tierNumber: tier.tierNumber,
        error: errorName,
      });
      failures.push(`variant ${variant.masterVariantId}: ${errorName}`);
    }
  }

  if (failures.length > 0) {
    // NO completion marker on partial failure — the whole point is that the
    // next call (triggered by webhook redelivery) sees no marker for this
    // tier and tries again, including the variants that already succeeded
    // (a harmless repeat publish of the same price).
    throw new GroupBuyTierPriceSyncError(campaignId, tier.tierNumber, failures);
  }

  if (unresolved.length > 0) {
    // Every variant we COULD call succeeded; some could not be called at
    // all yet. Also no completion marker — for the opposite reason from the
    // failure branch above: a real failure retries by republishing
    // everyone (cheap, idempotent), but an unresolved variant never
    // becomes resolved merely by calling `applyVariantPrice` again, so
    // withholding the marker here is what lets a LATER call (once that
    // variant is linked) actually publish it instead of finding tier N
    // already marked complete and skipping outright.
    logger.warn("groupbuy.tier_price_sync_partial_no_linkage", {
      campaignId,
      tierNumber: tier.tierNumber,
      syncedVariantCount: syncedCount,
      unresolvedVariantCount: unresolved.length,
    });
    return {
      campaignId,
      tierNumber: tier.tierNumber,
      skipped: false,
      syncedVariantCount: syncedCount,
      unresolvedVariantCount: unresolved.length,
    };
  }

  await createAuditEvent({
    actorType: "system",
    actorRef: "groupbuy-tier-price-sync",
    action: TIER_SYNCED_ACTION,
    entityType: TIER_SYNC_ENTITY_TYPE,
    entityId: campaignId,
    after: { tierNumber: tier.tierNumber, syncedVariantCount: syncedCount },
  });

  logger.info("groupbuy.tier_price_sync_completed", {
    campaignId,
    tierNumber: tier.tierNumber,
    syncedVariantCount: syncedCount,
  });

  return {
    campaignId,
    tierNumber: tier.tierNumber,
    skipped: false,
    syncedVariantCount: syncedCount,
    unresolvedVariantCount: 0,
  };
}
