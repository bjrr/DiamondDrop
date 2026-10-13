import { describe, expect, it } from "vitest";

import type {
  PublishedVariantPrice,
  PublishedVariantPriceResult,
} from "~/db/repositories/publishedPriceRepository.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";

import {
  computeAsLowAsForProduct,
  recomputeAndPublishAsLowAs,
  type AsLowAsCandidateVariant,
} from "./asLowAsAggregator.server";
import { PRICE_METAFIELD_NAMESPACE } from "./priceMetafieldPayload";

/**
 * Every dependency is injected, so this suite exercises the ORCHESTRATION
 * (the exclusion sequencing) with no database and no network — matching the
 * discipline in `priceMetafieldWriter.test.ts` / `priceSyncAdapter.test.ts`.
 */

function aPrice(overrides: Partial<PublishedVariantPrice> = {}): PublishedVariantPrice {
  return {
    masterVariantId: "v1",
    priceCalculationId: "calc-1",
    bankPaymentPriceMinorUnits: 100_000n,
    regularCardPriceMinorUnits: 104_000n,
    bankPaymentSavingsMinorUnits: 4_000n,
    currency: "USD",
    appliedUpliftRate: "0.040000",
    appliedTierLabel: "$1,000–$2,499.99",
    ...overrides,
  };
}

const NOOP_CLIENT: AdminGraphqlClient = {
  async graphql() {
    throw new Error("client should not be called directly — resolveAvailability is stubbed in these tests");
  },
};

interface Fixture {
  variants: AsLowAsCandidateVariant[];
  availability: Map<string, boolean>;
  withdrawnByCalculation: Set<string>;
  withdrawnBySync: Set<string>;
  prices: Map<string, PublishedVariantPriceResult>;
}

function deps(fixture: Fixture) {
  return {
    client: NOOP_CLIENT,
    loadCandidateVariants: async () => fixture.variants,
    resolveAvailability: async (_client: AdminGraphqlClient, ids: readonly string[]) => {
      const result = new Map<string, boolean>();
      for (const id of ids) {
        if (fixture.availability.has(id)) result.set(id, fixture.availability.get(id)!);
      }
      return result;
    },
    isCalculationWithdrawn: async (masterVariantId: string) => fixture.withdrawnByCalculation.has(masterVariantId),
    isSyncWithdrawn: async (masterVariantId: string) => fixture.withdrawnBySync.has(masterVariantId),
    resolvePublishedPrice: async (masterVariantId: string): Promise<PublishedVariantPriceResult> =>
      fixture.prices.get(masterVariantId) ?? {
        kind: "not_purchasable",
        masterVariantId,
        reason: "unsynced",
      },
  };
}

function baseFixture(): Fixture {
  return {
    variants: [],
    availability: new Map(),
    withdrawnByCalculation: new Set(),
    withdrawnBySync: new Set(),
    prices: new Map(),
  };
}

describe("computeAsLowAsForProduct", () => {
  it("returns null when the product has no variants at all", async () => {
    const fixture = baseFixture();
    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("returns null (criterion 31) rather than a fallback when nothing is purchasable", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", false); // out of stock
    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("excludes a variant with no shopifyVariantGid — never linked, never purchasable", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: null }];
    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("excludes an out-of-stock variant, even if it is the cheapest (criterion 29)", async () => {
    const fixture = baseFixture();
    fixture.variants = [
      { masterVariantId: "cheap-oos", shopifyVariantGid: "gid://shopify/ProductVariant/1" },
      { masterVariantId: "pricier-in-stock", shopifyVariantGid: "gid://shopify/ProductVariant/2" },
    ];
    fixture.availability.set("gid://shopify/ProductVariant/1", false);
    fixture.availability.set("gid://shopify/ProductVariant/2", true);
    fixture.prices.set("cheap-oos", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "cheap-oos", bankPaymentPriceMinorUnits: 10_000n }),
    });
    fixture.prices.set("pricier-in-stock", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "pricier-in-stock", bankPaymentPriceMinorUnits: 90_000n }),
    });

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result?.price.masterVariantId).toBe("pricier-in-stock");
  });

  it("treats a Shopify-unrecognised variant id as unavailable, not as available-by-default", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    // Deliberately absent from `availability` — Shopify returned nothing for it.
    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("excludes a variant suspended under the CALCULATION failure 48-hour rule", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", true);
    fixture.withdrawnByCalculation.add("v1");
    fixture.prices.set("v1", { kind: "purchasable", price: aPrice({ masterVariantId: "v1" }) });

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("excludes a variant suspended under the SYNC failure 48-hour rule", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", true);
    fixture.withdrawnBySync.add("v1");
    fixture.prices.set("v1", { kind: "purchasable", price: aPrice({ masterVariantId: "v1" }) });

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("excludes an unsynced variant (getPublishedVariantPrice returns not_purchasable)", async () => {
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", true);
    // No entry in fixture.prices -> defaults to not_purchasable/unsynced.

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result).toBeNull();
  });

  it("selects the lowest bank payment price among several purchasable variants", async () => {
    const fixture = baseFixture();
    fixture.variants = [
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" },
      { masterVariantId: "v2", shopifyVariantGid: "gid://shopify/ProductVariant/2" },
      { masterVariantId: "v3", shopifyVariantGid: "gid://shopify/ProductVariant/3" },
    ];
    for (const gid of ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/3"]) {
      fixture.availability.set(gid, true);
    }
    fixture.prices.set("v1", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "v1", bankPaymentPriceMinorUnits: 300_000n }),
    });
    fixture.prices.set("v2", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "v2", bankPaymentPriceMinorUnits: 150_000n }),
    });
    fixture.prices.set("v3", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "v3", bankPaymentPriceMinorUnits: 999_000n }),
    });

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result?.price.masterVariantId).toBe("v2");
    expect(result?.price.bankPaymentPriceMinorUnits).toBe(150_000n);
    // R14: the winner's Shopify variant gid travels with it — needed by the
    // caller to embed the SOURCE variant id in the product-level metafield.
    expect(result?.shopifyVariantGid).toBe("gid://shopify/ProductVariant/2");
  });

  it("a real-shaped scenario: mixes draft-excluded (never in the candidate list), out-of-stock, suspended and one genuinely purchasable variant", async () => {
    const fixture = baseFixture();
    // Note: a `draft` variant would never appear in `variants` at all — the
    // real `loadCandidateVariants` filters status: "active" at the query.
    // This fixture models that by simply not including one.
    fixture.variants = [
      { masterVariantId: "oos", shopifyVariantGid: "gid://shopify/ProductVariant/1" },
      { masterVariantId: "suspended", shopifyVariantGid: "gid://shopify/ProductVariant/2" },
      { masterVariantId: "winner", shopifyVariantGid: "gid://shopify/ProductVariant/3" },
    ];
    fixture.availability.set("gid://shopify/ProductVariant/1", false);
    fixture.availability.set("gid://shopify/ProductVariant/2", true);
    fixture.availability.set("gid://shopify/ProductVariant/3", true);
    fixture.withdrawnBySync.add("suspended");
    fixture.prices.set("winner", {
      kind: "purchasable",
      price: aPrice({ masterVariantId: "winner", bankPaymentPriceMinorUnits: 42_000n }),
    });

    const result = await computeAsLowAsForProduct("product-1", deps(fixture));
    expect(result?.price.masterVariantId).toBe("winner");
  });
});

describe("recomputeAndPublishAsLowAs (R14, owner exit proof P2)", () => {
  /**
   * A fake client that actually performs `metafieldsSet`/`metafieldsDelete`
   * against an in-memory map, so these tests assert on the REAL write/delete
   * path (`setPriceMetafields` / `deletePriceMetafields`) rather than
   * mocking them away.
   */
  function recordingClient() {
    const store = new Map<string, unknown>();
    const calls: { mutation: "set" | "delete"; variables: Record<string, unknown> }[] = [];
    const client: AdminGraphqlClient = {
      async graphql(document, options) {
        const variables = options?.variables ?? {};
        if (document.includes("metafieldsSet")) {
          calls.push({ mutation: "set", variables });
          const inputs = variables.metafields as { ownerId: string; namespace: string; key: string; value: string }[];
          for (const input of inputs) store.set(`${input.ownerId}:${input.namespace}.${input.key}`, input.value);
          return {
            json: async () => ({
              data: {
                metafieldsSet: {
                  metafields: inputs.map((i, idx) => ({
                    id: `gid://shopify/Metafield/${idx}`,
                    namespace: i.namespace,
                    key: i.key,
                    ownerType: "PRODUCT",
                  })),
                  userErrors: [],
                },
              },
            }),
          };
        }
        if (document.includes("metafieldsDelete")) {
          calls.push({ mutation: "delete", variables });
          const identifiers = variables.metafields as { ownerId: string; namespace: string; key: string }[];
          for (const id of identifiers) store.delete(`${id.ownerId}:${id.namespace}.${id.key}`);
          return {
            json: async () => ({
              data: {
                metafieldsDelete: {
                  deletedMetafields: identifiers.map((i) => ({ ...i })),
                  userErrors: [],
                },
              },
            }),
          };
        }
        throw new Error(`unexpected mutation in test: ${document}`);
      },
    };
    return { client, store, calls };
  }

  it("writes the product metafield when a winner exists", async () => {
    const { client, store } = recordingClient();
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", true);
    fixture.prices.set("v1", { kind: "purchasable", price: aPrice({ masterVariantId: "v1" }) });

    await recomputeAndPublishAsLowAs("product-1", "gid://shopify/Product/1", {
      ...deps(fixture),
      client,
    });

    const written = store.get(`gid://shopify/Product/1:${PRICE_METAFIELD_NAMESPACE}.as_low_as_bank_minor_units`);
    expect(written).toBeDefined();
    expect(JSON.parse(written as string)).toMatchObject({ masterVariantId: "v1", shopifyVariantId: "1" });
  });

  it("DELETES the product metafield when no variant is currently purchasable (criterion 31)", async () => {
    const { client, store, calls } = recordingClient();
    // Pre-seed a stale value, as if an earlier publish had written one.
    store.set(`gid://shopify/Product/1:${PRICE_METAFIELD_NAMESPACE}.as_low_as_bank_minor_units`, "stale");
    const fixture = baseFixture();
    fixture.variants = [{ masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1" }];
    fixture.availability.set("gid://shopify/ProductVariant/1", false); // now out of stock

    await recomputeAndPublishAsLowAs("product-1", "gid://shopify/Product/1", {
      ...deps(fixture),
      client,
    });

    expect(calls.some((c) => c.mutation === "delete")).toBe(true);
    expect(store.has(`gid://shopify/Product/1:${PRICE_METAFIELD_NAMESPACE}.as_low_as_bank_minor_units`)).toBe(false);
  });
});
