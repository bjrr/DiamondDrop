import type { Money } from "~/domain/money/money";

/**
 * Ports for the pricing job (spec §9.1, §9.6).
 *
 * These exist so slice 1 can be complete and testable without reaching into
 * slice 2's or slice 6's territory, and so the boundary is visible in code
 * rather than only in a document.
 */

/**
 * Variants excluded from recalculation. Slice 6 (Group Buy) implements the
 * open-campaign source: a variant in an open campaign has FROZEN pricing
 * (CLAUDE.md #7) and must not be silently re-priced underneath a campaign
 * customers have already joined.
 */
export interface OpenCampaignExclusionSource {
  excludedMasterVariantIds(asOf: Date): Promise<ReadonlySet<string>>;
}

/**
 * Slice 1 placeholder. Returns empty because no campaign table exists yet.
 *
 * SLICE 6 IMPLEMENTS THIS. It is a named no-op rather than an omitted call so
 * that wiring the real source is a one-line substitution, and so a reader can
 * see that the exclusion was considered rather than forgotten.
 */
export class NoOpOpenCampaignExclusionSource implements OpenCampaignExclusionSource {
  async excludedMasterVariantIds(): Promise<ReadonlySet<string>> {
    return new Set<string>();
  }
}

/** Luxury Steals are fixed-price, limited-availability stock (docs/LUXURY-STEALS.md). */
export interface LuxuryStealExclusionSource {
  excludedMasterVariantIds(asOf: Date): Promise<ReadonlySet<string>>;
}

export interface ShopifyPriceSyncPort {
  applyVariantPrice(input: {
    shopifyVariantGid: string;
    price: Money;
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }>;
}

export class PriceSyncNotImplementedError extends Error {
  constructor() {
    super(
      "Shopify price sync is not implemented in slice 1. The Admin API adapter, " +
        "@shopify/shopify-app-react-router and OAuth all belong to slice 2 " +
        "(docs/specs/SLICE-1-PRICING.md §9.6)."
    );
    this.name = "PriceSyncNotImplementedError";
  }
}

/**
 * Production wiring for slice 1. THROWS rather than no-ops, deliberately.
 *
 * A silent no-op would make the slice look like it syncs prices when it does
 * not: intents would move to `synced`, the audit trail would claim a price
 * reached Shopify, and nobody would discover otherwise until a customer was
 * charged the old price. Failing loudly keeps the gap visible.
 */
export class UnimplementedPriceSyncPort implements ShopifyPriceSyncPort {
  async applyVariantPrice(): Promise<{ appliedAt: Date }> {
    throw new PriceSyncNotImplementedError();
  }
}

/** Records calls instead of performing them. Tests and local development only. */
export class RecordingPriceSyncPort implements ShopifyPriceSyncPort {
  readonly calls: {
    shopifyVariantGid: string;
    priceMinorUnits: string;
    currency: string;
    priceCalculationId: string;
  }[] = [];

  async applyVariantPrice(input: {
    shopifyVariantGid: string;
    price: Money;
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }> {
    const json = input.price.toJSON();
    this.calls.push({
      shopifyVariantGid: input.shopifyVariantGid,
      priceMinorUnits: json.amountMinorUnits,
      currency: json.currency,
      priceCalculationId: input.priceCalculationId,
    });
    return { appliedAt: new Date(0) };
  }
}

/**
 * A variant references a band that is not one of its product's bands.
 *
 * Named rather than a bare Error because the job logs `error.name` only
 * (criterion 30 keeps cost structure out of logs), so an anonymous throw
 * appears in the log as "Error" and tells an operator nothing.
 */
export class BandResolutionError extends Error {
  constructor(
    readonly masterVariantId: string,
    readonly bandId: string
  ) {
    super(
      `master_variant ${masterVariantId} references bandId ${bandId}, which is not a band of its product`
    );
    this.name = "BandResolutionError";
  }
}

/**
 * SEAM A (spec §4.7) — the ingestion side of metal prices.
 *
 * D2 settled on staff-entered prices for MVP1, with an automated feed as a
 * post-launch fast-follow. This port exists now so that arrival is an
 * additive change: a new implementation plus a scheduled caller that writes
 * `metal_price` rows with `source = 'feed'`.
 *
 * What must NOT change when the feed lands: the `metal_price` schema, the
 * repository's resolution rule, the engine, its tests, its stored snapshots,
 * its acceptance criteria, or `BuyNowPricingInputs`.
 *
 * The rule that keeps it that way: `source` is PROVENANCE — recorded and
 * displayed, never selected on. Resolution for a (metal, purity) key is
 * exactly "the row with the greatest effective_from <= asOf", regardless of
 * source. Do not add a priority column, do not prefer feed over manual, and
 * do not branch on `source` in any resolver.
 */
export interface MetalQuote {
  metal: string;
  purity: string;
  /** MAJOR units per gram, as a decimal string. Never a JS number. */
  pricePerGramMajorUnits: string;
  currency: string;
  /** The source's own timestamp, ISO-8601. */
  quotedAt: string;
}

export interface MetalPriceIngestionSource {
  fetchQuotes(asOf: string): Promise<readonly MetalQuote[]>;
}

/**
 * Slice 1's implementation: staff write `metal_price` rows directly, so there
 * is nothing to fetch.
 *
 * Returns empty rather than throwing because an empty quote list is the
 * truthful answer for manual entry — unlike `UnimplementedPriceSyncPort`,
 * where silence would misrepresent work as done. Nothing is claimed here.
 */
export class ManualEntryMetalPriceSource implements MetalPriceIngestionSource {
  async fetchQuotes(): Promise<readonly MetalQuote[]> {
    return [];
  }
}
