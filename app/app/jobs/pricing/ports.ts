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
