import { describe, expect, it } from "vitest";

import { priceCart } from "./pricing";
import {
  resolveServicePrice,
  resolveVendorMountingPrice,
  summarisePricedCart,
  toMerchandiseLine,
  type ShopifyVariantFacts,
  type VendorMountingPublishedPayload,
} from "./pricingSource";

/**
 * Where a cart line's prices come from, and what may never happen.
 *
 * THE DEFECT BEHIND THIS FILE. A live cart holding a $520 mounting and a $50
 * service displayed $0.00 for every figure — cart total, card total, bank
 * total and saving — because neither line resolved and the totals were still
 * published as plain numbers. Bank Payment Checkout silently did nothing.
 *
 * So the cases below are in two groups: the prices a line may legitimately
 * obtain, and the ways a failed lookup must NOT turn into money.
 */
const USD = "USD";

const variant = (over: Partial<ShopifyVariantFacts> = {}): ShopifyVariantFacts => ({
  legacyVariantId: "67939609051354",
  priceMinorUnits: 52_000n,
  currency: USD,
  productStatus: "UNLISTED",
  availableForSale: true,
  ...over,
});

/** A real published payload, matching the measured pilot mounting. */
const published = (
  over: Partial<VendorMountingPublishedPayload> = {}
): VendorMountingPublishedPayload => ({
  priceSource: "shopify_vendor_mounting",
  currency: USD,
  bankPaymentPriceMinorUnits: "49350",
  regularCardPriceMinorUnits: "52000",
  bankPaymentSavingsMinorUnits: "2650",
  shopifyVariantId: "67939609051354",
  cardPriceAnchorMinorUnits: "52000",
  ...over,
});

describe("vendor mounting — the published price is consumed, not recomputed", () => {
  it("uses the published Bank price and the Shopify variant price as the card anchor", () => {
    const r = resolveVendorMountingPrice(published(), variant());
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.source).toBe("vendor_mounting");
    expect(r.unitBankPaymentPriceMinorUnits).toBe(49_350n);
    expect(r.unitRegularCardPriceMinorUnits).toBe(52_000n);
    expect(r.bankPaymentDiscountEligible).toBe(true);
  });

  it("resolves by Shopify variant identity, not by SKU", () => {
    // Several ring sizes legitimately share one transformed CaratForUs SKU, so
    // SKU cannot identify a line. Nothing in this module's inputs is a SKU —
    // the payload names a variant id and that is what is checked.
    const r = resolveVendorMountingPrice(
      published({ shopifyVariantId: "67939609051354" }),
      variant({ legacyVariantId: "67939609051354" })
    );
    expect(r.kind).toBe("resolved");
    const wrongVariant = resolveVendorMountingPrice(
      published({ shopifyVariantId: "67939609051354" }),
      variant({ legacyVariantId: "67939609313498" })
    );
    expect(wrongVariant).toEqual({ kind: "unresolved", reason: "unverified_price" });
  });

  it("refuses a stale payload whose anchor no longer matches Shopify's price", () => {
    // Someone edited the price in Shopify after publish. The bank figure next
    // to a stale anchor is not a price we may quote.
    const r = resolveVendorMountingPrice(published(), variant({ priceMinorUnits: 54_500n }));
    expect(r).toEqual({ kind: "unresolved", reason: "unverified_price" });
  });

  it("refuses a payload whose own two figures disagree", () => {
    const r = resolveVendorMountingPrice(
      published({ cardPriceAnchorMinorUnits: "51000" }),
      variant()
    );
    expect(r).toEqual({ kind: "unresolved", reason: "unverified_price" });
  });

  it("refuses an inverted pair that would manufacture a saving", () => {
    const r = resolveVendorMountingPrice(
      published({ bankPaymentPriceMinorUnits: "60000", regularCardPriceMinorUnits: "52000" }),
      variant()
    );
    expect(r).toEqual({ kind: "unresolved", reason: "unverified_price" });
  });

  it("refuses junk, missing fields, zero, negatives and decimals", () => {
    for (const bad of [
      { bankPaymentPriceMinorUnits: undefined },
      { bankPaymentPriceMinorUnits: "0" },
      { bankPaymentPriceMinorUnits: "-49350" },
      { bankPaymentPriceMinorUnits: "493.50" },
      { bankPaymentPriceMinorUnits: 49_350 },
      { regularCardPriceMinorUnits: "" },
      { cardPriceAnchorMinorUnits: null },
      { currency: "EUR" },
    ] as Partial<VendorMountingPublishedPayload>[]) {
      expect(resolveVendorMountingPrice(published(bad), variant()).kind).toBe("unresolved");
    }
  });

  it("refuses a payload that is not a vendor-mounting publish at all", () => {
    expect(resolveVendorMountingPrice(null, variant())).toEqual({
      kind: "unresolved",
      reason: "unknown_variant",
    });
    expect(
      resolveVendorMountingPrice(published({ priceSource: "something_else" }), variant())
    ).toEqual({ kind: "unresolved", reason: "unknown_variant" });
  });

  it("refuses a draft, archived or sold-out variant", () => {
    for (const over of [
      { productStatus: "DRAFT" },
      { productStatus: "ARCHIVED" },
      { availableForSale: false },
    ]) {
      expect(resolveVendorMountingPrice(published(), variant(over)).kind).toBe("unresolved");
    }
    // UNLISTED is sellable — that is how every SYOS mounting is published.
    expect(resolveVendorMountingPrice(published(), variant({ productStatus: "ACTIVE" })).kind)
      .toBe("resolved");
  });

  it("performs no mounting arithmetic of its own", () => {
    // §8: the cart must not repeat vendor cost x 1.75 + setting/pavé/halo/size.
    // The resolved figures are exactly the published ones, byte for byte.
    const r = resolveVendorMountingPrice(published(), variant());
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.unitBankPaymentPriceMinorUnits.toString()).toBe("49350");
    expect(r.unitRegularCardPriceMinorUnits.toString()).toBe("52000");
  });
});

describe("service — $50 in both modes", () => {
  const service = variant({ priceMinorUnits: 5_000n, productStatus: "UNLISTED" });

  it("charges the Shopify price unchanged, with no uplift", () => {
    const r = resolveServicePrice(service);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.source).toBe("service");
    // $50 card, $50 bank. Never $55 on card.
    expect(r.unitRegularCardPriceMinorUnits).toBe(5_000n);
    expect(r.unitBankPaymentPriceMinorUnits).toBe(5_000n);
  });

  it("is ineligible for the Bank Payment discount, which is what zeroes its saving", () => {
    const r = resolveServicePrice(service);
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.bankPaymentDiscountEligible).toBe(false);
  });

  it("needs no pricing-engine record", () => {
    const r = resolveServicePrice(service);
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.masterVariantId).toBeUndefined();
  });

  it("refuses a zero-priced or unsellable service", () => {
    expect(resolveServicePrice(variant({ priceMinorUnits: 0n })).kind).toBe("unresolved");
    expect(resolveServicePrice(variant({ productStatus: "DRAFT" })).kind).toBe("unresolved");
  });
});

describe("the measured cart: $520 mounting + $50 removal", () => {
  /**
   * The owner's pinned example (§5), carried all the way through `priceCart`
   * so the totals are the real ones rather than a restatement of the inputs.
   */
  function pricedMixedCart(mode: "card" | "bank") {
    const mounting = resolveVendorMountingPrice(published(), variant());
    const removal = resolveServicePrice(variant({ priceMinorUnits: 5_000n }));
    if (mounting.kind !== "resolved" || removal.kind !== "resolved") {
      throw new Error("fixture did not resolve");
    }
    return priceCart({
      mode,
      currency: USD,
      lines: [
        toMerchandiseLine("mounting", 1n, mounting, "shopify:mounting"),
        toMerchandiseLine("removal", 1n, removal, "shopify:removal"),
      ],
    });
  }

  it("card total is $570.00", () => {
    expect(pricedMixedCart("card").cardMerchandiseTotalMinorUnits).toBe(57_000n);
  });

  it("bank total is $543.50", () => {
    expect(pricedMixedCart("bank").bankMerchandiseTotalMinorUnits).toBe(54_350n);
  });

  it("the saving is $26.50 — the mounting's, with nothing from the service", () => {
    expect(pricedMixedCart("bank").bankPaymentSavingsMinorUnits).toBe(2_650n);
  });

  it("the service contributes exactly $0 to the saving", () => {
    const priced = pricedMixedCart("bank");
    const removalLine = priced.lines.find((l) => l.lineId === "removal");
    expect(removalLine?.lineBankPaymentSavingsMinorUnits).toBe(0n);
    expect(removalLine?.lineCardBasisTotalMinorUnits).toBe(5_000n);
    expect(removalLine?.lineBankBasisTotalMinorUnits).toBe(5_000n);
  });

  it("neither total is zero", () => {
    for (const mode of ["card", "bank"] as const) {
      const priced = pricedMixedCart(mode);
      expect(priced.cardMerchandiseTotalMinorUnits).toBeGreaterThan(0n);
      expect(priced.bankMerchandiseTotalMinorUnits).toBeGreaterThan(0n);
      expect(priced.activeMerchandiseTotalMinorUnits).toBeGreaterThan(0n);
    }
  });

  it("quantity extends the mounting but the service stays one", () => {
    const mounting = resolveVendorMountingPrice(published(), variant());
    const removal = resolveServicePrice(variant({ priceMinorUnits: 5_000n }));
    if (mounting.kind !== "resolved" || removal.kind !== "resolved") throw new Error("fixture");
    const priced = priceCart({
      mode: "bank",
      currency: USD,
      lines: [
        toMerchandiseLine("mounting", 3n, mounting, "shopify:mounting"),
        toMerchandiseLine("removal", 1n, removal, "shopify:removal"),
      ],
    });
    // 49350 x 3 + 5000
    expect(priced.bankMerchandiseTotalMinorUnits).toBe(153_050n);
    // The saving scales with the eligible merchandise only.
    expect(priced.bankPaymentSavingsMinorUnits).toBe(7_950n);
  });
});

describe("the summary — unknown is not zero", () => {
  it("withholds totals whenever any requested line failed", () => {
    expect(summarisePricedCart(2, 1)).toEqual({
      totalsArePublishable: false,
      bankPaymentAvailable: false,
      unpurchasableLineCount: 1,
    });
  });

  it("publishes totals only when every line priced", () => {
    expect(summarisePricedCart(2, 0)).toEqual({
      totalsArePublishable: true,
      bankPaymentAvailable: true,
      unpurchasableLineCount: 0,
    });
  });

  it("refuses Bank Payment on exactly the carts whose totals it withholds", () => {
    // Bank Payment is settled by hand against a figure we quoted, so it must
    // never be offered on a cart whose total could not be established.
    for (const [requested, failed] of [[1, 1], [3, 1], [5, 5]]) {
      const s = summarisePricedCart(requested as number, failed as number);
      expect(s.bankPaymentAvailable).toBe(s.totalsArePublishable);
      expect(s.bankPaymentAvailable).toBe(false);
    }
  });

  it("treats a request for no lines as unpublishable rather than zero", () => {
    // The route answers a genuinely empty cart on its own early-return path,
    // where zero is a fact. Reaching here with no lines means something was
    // dropped on the way, which is not the same thing.
    expect(summarisePricedCart(0, 0).totalsArePublishable).toBe(false);
  });
});
