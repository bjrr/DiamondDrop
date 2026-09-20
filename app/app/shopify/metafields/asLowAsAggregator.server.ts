import { prisma } from "~/db/client.server";
import { isVariantCurrentlyWithdrawn as isCalculationWithdrawn } from "~/db/repositories/priceCalculationFailureRepository.server";
import { isVariantCurrentlyWithdrawn as isSyncWithdrawn } from "~/db/repositories/priceSyncFailureRepository.server";
import {
  getPublishedVariantPrice,
  type PublishedVariantPrice,
} from "~/db/repositories/publishedPriceRepository.server";
import { selectLowestPurchasablePrice, type AsLowAsCandidate } from "~/domain/pricing/asLowAs";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";

import { buildProductAsLowAsMetafield, PRICE_METAFIELD_NAMESPACE } from "./priceMetafieldPayload";
import { deletePriceMetafields, setPriceMetafields } from "./priceMetafieldWriter.server";
import { getVariantsAvailability } from "./variantAvailability.server";

/**
 * The ORCHESTRATION half of the "as low as" aggregator (Stage 2B / R13, spec
 * §4.5 criteria 28-31). Pairs with the PURE decision in
 * `~/domain/pricing/asLowAs.ts`: this module resolves the real variants,
 * decides which ones are currently purchasable, and hands the survivors to
 * `selectLowestPurchasablePrice` to pick the winner.
 *
 * "CURRENTLY PURCHASABLE" — THE FOUR EXCLUSIONS, IN THE ORDER THEY ARE
 * CHECKED, AND WHY EACH IS NECESSARY:
 *
 *   1. `draft` / `archived` — excluded by the `status: "active"` filter this
 *      module's own database query applies. Criterion 29 names `draft`
 *      explicitly; `archived` is excluded for the same reason (neither is
 *      currently sellable) and is if anything the more clear-cut case.
 *   2. OUT OF STOCK — checked via `getVariantsAvailability`'s live
 *      `availableForSale` read, ONE Admin API call for the whole product's
 *      variant set (not one per variant — see that module's own doc
 *      comment). Checked first among the "requires I/O" exclusions because
 *      it needs no per-variant database round trip and prunes the list
 *      before the more expensive checks below run against fewer candidates.
 *   3. SUSPENDED under the 48-hour sync or calculation failure rules
 *      (criterion 24/29) — `isVariantCurrentlyWithdrawn` from BOTH
 *      `priceCalculationFailureRepository.server.ts` and
 *      `priceSyncFailureRepository.server.ts`. These are two independent
 *      failure episodes (a calculation can fail before a price ever exists
 *      to sync; a sync can fail after a calculation succeeds), so a variant
 *      withdrawn under EITHER must be excluded — checking only one would
 *      silently readmit a variant Stage 2A already decided is unavailable.
 *   4. UNSYNCED / NEVER PUBLISHED — `getPublishedVariantPrice` (criterion
 *      52's single resolver) returning anything other than `"purchasable"`.
 *      Reused here deliberately rather than re-deriving a price from
 *      `price_calculation` directly, so this aggregator can never disagree
 *      with what the PDP itself would show for the same variant.
 *
 * A variant surviving all four is a CANDIDATE; `selectLowestPurchasablePrice`
 * then picks the winner. Zero candidates returns `null` (criterion 31) —
 * this module never fabricates or falls back to a stale figure.
 *
 * PRODUCT-SCOPED, NOT VARIANT-SCOPED. This function always re-evaluates the
 * product's FULL current variant set, never just the variant that triggered
 * the recompute — publishing one variant can raise or lower the product's
 * "as low as" even though no OTHER variant changed (e.g. the previous
 * winner just went out of stock, or a suspended variant just recovered).
 *
 * WHEN `recomputeAndPublishAsLowAs` RUNS (owner exit proof P2, R14). Exclusion
 * 4 (unsynced) is naturally kept fresh by every successful publish, which
 * already calls this. Exclusion 3 (suspended) is an event THIS APP fully
 * controls, so it is hooked directly at both 48-hour state machines'
 * transition points — `syncApprovedIntent.server.ts` (sync failure
 * newly-suspended / newly-restored) and `runRecalculation.server.ts`
 * (calculation failure newly-suspended / newly-restored) — with no
 * additional latency. Exclusion 2 (out of stock) is the one genuinely
 * EXTERNAL event (inventory can change from an order, a manual count, or a
 * POS sale with no CaratForUs code in the path at all); making that
 * immediate needs a Shopify inventory webhook subscription, which is new
 * subscription surface requiring a scope this app does not currently hold
 * (`write_products` only) — flagged for an explicit owner/architect decision
 * rather than built silently. Until that lands, an out-of-stock change is
 * caught by the next event this module DOES control (another publish, or a
 * suspension/restoration on the same product) or by the daily recalculation
 * as a reconciliation backstop — never as the primary freshness mechanism.
 */

export interface AsLowAsCandidateVariant {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
}

/**
 * Injectable seams for testing the ORCHESTRATION (the exclusion sequencing
 * and the final selection) with fakes — no database, no network. Each
 * defaults to the real implementation; a caller in production supplies only
 * `client`.
 */
export interface ComputeAsLowAsDeps {
  readonly client: AdminGraphqlClient;
  loadCandidateVariants?: (masterProductId: string) => Promise<readonly AsLowAsCandidateVariant[]>;
  resolvePublishedPrice?: typeof getPublishedVariantPrice;
  isCalculationWithdrawn?: typeof isCalculationWithdrawn;
  isSyncWithdrawn?: typeof isSyncWithdrawn;
  resolveAvailability?: typeof getVariantsAvailability;
}

async function defaultLoadCandidateVariants(
  masterProductId: string
): Promise<readonly AsLowAsCandidateVariant[]> {
  const rows = await prisma.masterVariant.findMany({
    where: { masterProductId, status: "active" },
    select: { id: true, shopifyVariantGid: true },
  });
  return rows.map((row) => ({ masterVariantId: row.id, shopifyVariantGid: row.shopifyVariantGid }));
}

/**
 * The winning candidate, carrying its Shopify variant gid alongside its
 * price. R14 needs this gid to embed in the product-level metafield (the
 * "source variant id" the theme re-checks for purchasability), which a bare
 * `PublishedVariantPrice` cannot provide — it is keyed by our internal
 * `masterVariantId`, not any Shopify-native identity.
 */
export interface AsLowAsWinner {
  readonly price: PublishedVariantPrice;
  readonly shopifyVariantGid: string;
}

/** Internal shape threaded through selection so the pure selector can compare on price while carrying the extra fields along for the ride. */
interface AsLowAsAggregateCandidate extends AsLowAsCandidate {
  readonly price: PublishedVariantPrice;
  readonly shopifyVariantGid: string;
}

/**
 * Computes the winning "as low as" price for a product, or `null` if no
 * variant is currently purchasable (criterion 31).
 */
export async function computeAsLowAsForProduct(
  masterProductId: string,
  deps: ComputeAsLowAsDeps
): Promise<AsLowAsWinner | null> {
  const loadCandidates = deps.loadCandidateVariants ?? defaultLoadCandidateVariants;
  const resolvePrice = deps.resolvePublishedPrice ?? getPublishedVariantPrice;
  const checkCalculationWithdrawn = deps.isCalculationWithdrawn ?? isCalculationWithdrawn;
  const checkSyncWithdrawn = deps.isSyncWithdrawn ?? isSyncWithdrawn;
  const resolveAvailability = deps.resolveAvailability ?? getVariantsAvailability;

  // Exclusion 1 (draft/archived) is already applied by the query itself.
  const variants = await loadCandidates(masterProductId);

  // A variant with no Shopify variant id at all has never been linked to a
  // storefront listing — it cannot be "in stock" or "out of stock" because
  // Shopify has no opinion on it yet, so it is excluded before any Admin API
  // call rather than sent into a query that could not answer for it anyway.
  const linked = variants.filter(
    (variant): variant is AsLowAsCandidateVariant & { shopifyVariantGid: string } =>
      variant.shopifyVariantGid !== null
  );

  // Exclusion 2: OUT OF STOCK. One Admin API round trip for the whole
  // product, regardless of variant count.
  const availability =
    linked.length > 0
      ? await resolveAvailability(
          deps.client,
          linked.map((variant) => variant.shopifyVariantGid)
        )
      : new Map<string, boolean>();

  const candidates: AsLowAsAggregateCandidate[] = [];
  for (const variant of linked) {
    // A gid Shopify did not recognise is treated as unavailable, never as
    // available-by-default (see getVariantsAvailability's own doc comment).
    if (!(availability.get(variant.shopifyVariantGid) ?? false)) continue;

    // Exclusion 3: SUSPENDED under either failure state machine. Checked
    // before resolving the price — a withdrawn variant's last published
    // figure is stale by policy, not merely unlucky, so there is no reason
    // to spend the extra query resolving a price this loop will discard.
    const [calculationWithdrawn, syncWithdrawn] = await Promise.all([
      checkCalculationWithdrawn(variant.masterVariantId),
      checkSyncWithdrawn(variant.masterVariantId),
    ]);
    if (calculationWithdrawn || syncWithdrawn) continue;

    // Exclusion 4: UNSYNCED / NEVER PUBLISHED.
    const priceResult = await resolvePrice(variant.masterVariantId);
    if (priceResult.kind !== "purchasable") continue;

    candidates.push({
      masterVariantId: priceResult.price.masterVariantId,
      bankPaymentPriceMinorUnits: priceResult.price.bankPaymentPriceMinorUnits,
      price: priceResult.price,
      shopifyVariantGid: variant.shopifyVariantGid,
    });
  }

  const winner = selectLowestPurchasablePrice(candidates);
  return winner ? { price: winner.price, shopifyVariantGid: winner.shopifyVariantGid } : null;
}

/**
 * Recomputes and republishes a product's "as low as" metafield, or DELETES
 * it when nothing is currently purchasable (criterion 31 — see
 * `deletePriceMetafields`'s own doc comment for why deletion, not merely
 * skipping the write, is required here). The single call every recompute
 * trigger should make — see the module doc comment's "WHEN THIS RUNS"
 * section for the full list of triggers.
 */
export async function recomputeAndPublishAsLowAs(
  masterProductId: string,
  shopifyProductGid: string,
  deps: ComputeAsLowAsDeps
): Promise<void> {
  const winner = await computeAsLowAsForProduct(masterProductId, deps);
  if (winner) {
    await setPriceMetafields(deps.client, [
      buildProductAsLowAsMetafield(shopifyProductGid, winner.price, winner.shopifyVariantGid),
    ]);
  } else {
    await deletePriceMetafields(deps.client, [
      { ownerId: shopifyProductGid, namespace: PRICE_METAFIELD_NAMESPACE, key: "as_low_as_bank_minor_units" },
    ]);
  }
}
