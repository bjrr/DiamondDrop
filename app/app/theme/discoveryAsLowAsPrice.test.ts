import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-6, discovery half (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §3
 * "Collection and search pages", and
 * docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md §E / R13).
 *
 * Same static-source approach as pdpAddToCartActions.test.ts and
 * cartMoneySurfaceFence.test.ts: no Liquid rendering engine is available, so
 * these assert over the actual `.liquid` source rather than rendered DOM.
 *
 * R13 decided discovery surfaces read the PRODUCT-LEVEL
 * `carat.as_low_as_bank_minor_units` metafield directly, not the cart proxy
 * (no arithmetic — one precomputed figure, no summation). Every discovery
 * surface funnels through `snippets/price.liquid`'s `mode: 'as_low_as'`
 * branch: `snippets/card-product.liquid` (which `main-collection-product-grid.liquid`
 * and `featured-collection.liquid` both render, so they need no direct
 * assertion of their own here), and `sections/predictive-search.liquid`
 * line 163 — the search half, easy to forget per the inventory's own
 * warning.
 *
 * R14 (owner ruling, post-acceptance) replaced the original coarse
 * `product.available` proxy with an EXACT per-variant check: the metafield
 * now embeds `shopifyVariantId` (a real Liquid-native variant id) and
 * `cardPriceAnchorMinorUnits` (a Card price snapshot) — both decimal
 * strings, like every other field in this payload, cast with the same
 * `| plus: 0` idiom as the display figures. Liquid resolves the id against
 * `product.variants` and requires that variant to still be available AND
 * its live native price to still equal the (cast) anchor. A metafield write
 * that failed independently of a successful native price write leaves an
 * anchor that no longer matches — detected with no extra signal, because
 * it's compared against the one value that cannot be stale: what Shopify
 * itself is currently serving. R14/P2 also made a nil metafield itself
 * meaningful: the backend deletes it outright once no variant remains
 * currently purchasable, rather than leaving a stale value behind.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const PRICE_PATH = join(THEME_ROOT, "snippets", "price.liquid");
const CARD_PRODUCT_PATH = join(THEME_ROOT, "snippets", "card-product.liquid");
const PREDICTIVE_SEARCH_PATH = join(THEME_ROOT, "sections", "predictive-search.liquid");
const COLLECTION_GRID_PATH = join(THEME_ROOT, "sections", "main-collection-product-grid.liquid");
const FEATURED_COLLECTION_PATH = join(THEME_ROOT, "sections", "featured-collection.liquid");

/** Forbidden per CLAUDE.md §12 / owner criterion 37. */
const FORBIDDEN_TERMS = [/cash discount/i, /cash price/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(path: string): string {
  return stripLiquidComments(readFileSync(path, "utf8"));
}

describe("snippets/price.liquid — mode: 'as_low_as' (owner §3, R13)", () => {
  const source = read(PRICE_PATH);

  it("GUARDS THE GUARD: the file exists and is non-empty", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("reads the product-level as-low-as metafield, not a bare product price", () => {
    expect(source).toContain("product.metafields.carat.as_low_as_bank_minor_units.value");
  });

  it("renders 'As low as' via the locale key, with a nearby Bank Payment Price label (owner §3's 'clear nearby label')", () => {
    expect(source).toContain("'products.product.price.as_low_as_html' | t: price: as_low_as_money");
    // The label appears in both the purchasable and placeholder branches — count, don't just contain.
    const labelCount = (source.match(/'products\.product\.price\.bank_payment_price' \| t/g) ?? []).length;
    expect(labelCount).toBeGreaterThanOrEqual(2);
  });

  it("never renders the Regular/Card Price on the as_low_as branch (owner §3: cards do not need it)", () => {
    const branchStart = source.indexOf("{%- if mode == 'as_low_as' -%}");
    const branchEnd = source.indexOf("{%- elsif mode == 'pdp' -%}");
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const asLowAsBranch = source.slice(branchStart, branchEnd);
    expect(asLowAsBranch).not.toMatch(/regular_card_price/);
    expect(asLowAsBranch).not.toMatch(/carat-card-price/);
    expect(asLowAsBranch).not.toMatch(/carat-bank-payment-saving/);
  });

  it("casts the R14 identity/anchor fields with the same `| plus: 0` idiom as the display figures (both are decimal strings)", () => {
    expect(source).toContain(
      "assign as_low_as_metafield_variant_id = as_low_as_metafield.shopifyVariantId | plus: 0"
    );
    expect(source).toContain(
      "assign as_low_as_metafield_card_anchor_minor = as_low_as_metafield.cardPriceAnchorMinorUnits | plus: 0"
    );
  });

  it("gates the purchasable figure on an EXACT per-variant check (R14) — never advertises an unavailable or stale configuration's price", () => {
    const gateIndex = source.indexOf("assign as_low_as_purchasable = false");
    const gateBlock = source.slice(gateIndex, gateIndex + 400);
    expect(gateBlock).toContain("as_low_as_metafield != blank");
    expect(gateBlock).toContain("as_low_as_source_variant != null");
    expect(gateBlock).toContain("as_low_as_source_variant.available");
    expect(gateBlock).toContain("as_low_as_source_variant.price == as_low_as_metafield_card_anchor_minor");
    expect(gateBlock).toContain("as_low_as_bank_minor > 0");
    // R13's coarse proxy must be gone, not merely superseded — a leftover reference would be
    // dead weight at best and a second, looser gate at worst.
    expect(gateBlock).not.toMatch(/\bproduct\.available\b/);
    // The gate must compare the already-cast intermediate value, not the raw metafield field
    // inline — same ambiguous-precedence concern the PDP branch avoids the same way.
    expect(gateBlock).not.toMatch(/as_low_as_metafield\.cardPriceAnchorMinorUnits/);
  });

  it("resolves the metafield's shopifyVariantId against product.variants by the real Liquid variant id, not the internal masterVariantId", () => {
    expect(source).toContain("for v in product.variants");
    expect(source).toContain("if v.id == as_low_as_metafield_variant_id");
    expect(source).toContain("assign as_low_as_source_variant = v");
    // masterVariantId is documented admin/audit-only and must never be used for the LOOKUP itself
    // — scoped to the loop, since the file's module comment legitimately discusses masterVariantId
    // in prose (why it can't be used) elsewhere.
    const loopStart = source.indexOf("for v in product.variants");
    const loopEnd = source.indexOf("endfor", loopStart);
    const loopBody = source.slice(loopStart, loopEnd);
    expect(loopBody).not.toMatch(/masterVariantId/);
    // Same precedence concern as the gate: the loop must compare the already-cast id, not the
    // raw metafield field inline.
    expect(loopBody).not.toMatch(/as_low_as_metafield\.shopifyVariantId/);
  });

  it("shopifyVariantId and cardPriceAnchorMinorUnits (raw or cast) exist only to validate — never rendered/printed", () => {
    expect(source).not.toMatch(/{{-?\s*as_low_as_metafield\.shopifyVariantId/);
    expect(source).not.toMatch(/{{-?\s*as_low_as_metafield\.cardPriceAnchorMinorUnits/);
    expect(source).not.toMatch(/{{-?\s*as_low_as_metafield_variant_id/);
    expect(source).not.toMatch(/{{-?\s*as_low_as_metafield_card_anchor_minor/);
  });

  it("renders an explicit unavailable state rather than a stale/fallback figure when not purchasable", () => {
    expect(source).toContain("'products.product.price.as_low_as_unavailable' | t");
  });

  it("does not fabricate a fallback by reading a native Shopify price inside the as_low_as branch", () => {
    const branchStart = source.indexOf("{%- if mode == 'as_low_as' -%}");
    const branchEnd = source.indexOf("{%- elsif mode == 'pdp' -%}");
    const asLowAsBranch = source.slice(branchStart, branchEnd);
    // `1999` is the documented ONBOARDING placeholder default only, gated by `elsif placeholder`.
    // No other numeric/native price literal (product.price, variant.price, target.price) may appear.
    expect(asLowAsBranch).not.toMatch(/\btarget\.price\b/);
    // Excludes the 'products.product.price.*' translation KEY strings (a literal substring
    // match, not a read of the Liquid product object's price field) via the lookbehind.
    expect(asLowAsBranch).not.toMatch(/(?<!products\.)\bproduct\.price\b/);
    expect(asLowAsBranch).not.toMatch(/\bvariant\.price\b/);
  });

  it("does no arithmetic on the metafield value beyond the safe numeric-cast idiom (`| plus: 0`)", () => {
    const branchStart = source.indexOf("{%- if mode == 'as_low_as' -%}");
    const branchEnd = source.indexOf("{%- elsif mode == 'pdp' -%}");
    const asLowAsBranch = source.slice(branchStart, branchEnd);
    expect(asLowAsBranch).not.toMatch(/as_low_as_bank_minor\s*\|\s*times/);
    expect(asLowAsBranch).not.toMatch(/as_low_as_bank_minor\s*\|\s*minus/);
    expect(asLowAsBranch).not.toMatch(/as_low_as_bank_minor\s*\|\s*divided_by/);
  });

  it("does not read a raw Shopify cart/line money object (L1, re-asserted here as this file is new to money-adjacent logic)", () => {
    expect(source).not.toMatch(/\bcart\.total_price\b/);
    expect(source).not.toMatch(/\bcart\.items_subtotal_price\b/);
    expect(source).not.toMatch(/\bitem\.final_line_price\b/);
  });

  it("introduces no forbidden pricing terminology", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });
});

describe("snippets/card-product.liquid — collection/search cards use mode: 'as_low_as'", () => {
  const source = read(CARD_PRODUCT_PATH);

  it("every render 'price' call in this file uses mode: 'as_low_as' (no bare price render left over)", () => {
    const calls = source.match(/{%-?\s*render\s+'price'[^%]*%}/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call).toContain("mode: 'as_low_as'");
    }
  });

  it("does not pass show_compare_at_price (dead parameter — as_low_as mode never mixes a Card-basis compare-at price with a Bank-basis headline price)", () => {
    expect(source).not.toContain("show_compare_at_price");
  });
});

describe("sections/predictive-search.liquid — search dropdown price (E7 / R13, easy to forget)", () => {
  const source = read(PREDICTIVE_SEARCH_PATH);

  it("renders price with mode: 'as_low_as', not use_variant (a single variant's Card price)", () => {
    const callIndex = source.indexOf("render 'price'");
    expect(callIndex).toBeGreaterThan(-1);
    const call = source.slice(callIndex, source.indexOf("%}", callIndex) + 2);
    expect(call).toContain("mode: 'as_low_as'");
    expect(call).not.toContain("use_variant");
  });

  it("introduces no forbidden pricing terminology", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });
});

describe("collection/featured-collection sections inherit as_low_as through card-product.liquid", () => {
  it("main-collection-product-grid.liquid renders products through card-product.liquid, not a direct price call", () => {
    const source = read(COLLECTION_GRID_PATH);
    expect(source).toContain("render 'card-product'");
    expect(source).not.toMatch(/render\s+'price'/);
  });

  it("featured-collection.liquid renders products through card-product.liquid, not a direct price call", () => {
    const source = read(FEATURED_COLLECTION_PATH);
    expect(source).toContain("render 'card-product'");
    expect(source).not.toMatch(/render\s+'price'/);
  });
});

describe("P4 proof of absence — the Shopify native price never substitutes for the Bank Payment figure", () => {
  const source = read(PRICE_PATH);

  it("the as_low_as_bank_minor, shopifyVariantId-cast and cardPriceAnchorMinorUnits-cast assignments have no fallback filter of any kind", () => {
    for (const name of ["as_low_as_bank_minor", "as_low_as_metafield_variant_id", "as_low_as_metafield_card_anchor_minor"]) {
      const line = source.split("\n").find((l) => l.trim().startsWith(`assign ${name} =`))?.trim();
      expect(line, `expected an 'assign ${name} =' line`).toBeDefined();
      // The only filter permitted on this line is the safe numeric-cast idiom. A `| default: X`
      // clause — however well-intentioned, e.g. "show something rather than nothing" — would
      // silently substitute X (a native price, if X were ever target.price/product.price) under
      // the Bank Payment label the moment the metafield is absent, which is undercharging in the
      // customer's favour and would never surface as a complaint. For the identity/anchor casts,
      // a `| default:` would be worse than pointless — a MISSING R14 field could silently coerce
      // to a value that spuriously matches, defeating the entire point of the anchor.
      expect(line).toMatch(new RegExp(`^assign ${name} = as_low_as_metafield\\.\\w+ \\| plus: 0$`));
    }
  });

  it("no native price token appears anywhere on the as_low_as_bank_minor, as_low_as_money, or R14 identity/anchor assignment lines", () => {
    const lines = source
      .split("\n")
      .filter((l) =>
        /assign as_low_as_(bank_minor|money|metafield_variant_id|metafield_card_anchor_minor) =/.test(l.trim())
      );
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).not.toMatch(/target\.price|product\.price|variant\.price|compare_at_price/);
    }
  });

  it("the purchasable gate — not a fallback value — is what governs whether ANYTHING renders under the Bank Payment label", () => {
    // Re-stated deliberately in value-substitution terms, not structural terms (that's covered
    // elsewhere): if as_low_as_bank_minor were ever allowed to be a native price in disguise, this
    // gate would still need bypassing for it to render under the label — it doesn't check "is
    // this number sane", it checks "did the metafield actually exist, name a real currently-
    // available variant, and still agree with that variant's live Shopify price".
    const gateLine = source
      .split("\n")
      .find((l) => l.trim().startsWith("if placeholder == null and as_low_as_metafield"));
    expect(gateLine).toBeDefined();
    expect(gateLine).toContain("as_low_as_metafield != blank");
    expect(gateLine).toContain("as_low_as_source_variant.price == as_low_as_metafield_card_anchor_minor");
  });

  it("a metafield naming a variant that is no longer available cannot render (R14 identity+freshness, not just presence)", () => {
    // Proof-of-absence, guarded the same way as the sibling test above: the gate line itself
    // must require as_low_as_source_variant.available — a metafield that is present, well-formed,
    // and even price-coherent but whose source variant sold out must still suppress the figure.
    const gateLine = source
      .split("\n")
      .find((l) => l.trim().startsWith("if placeholder == null and as_low_as_metafield"));
    expect(gateLine).toContain("as_low_as_source_variant != null");
    expect(gateLine).toContain("as_low_as_source_variant.available");
  });
});

describe("guard the guard — as_low_as gate actually distinguishes purchasable from not", () => {
  it("the purchasable condition requires every clause: metafield present, variant resolved, available, price-coherent, positive price", () => {
    const source = read(PRICE_PATH);
    const ifLine = source
      .split("\n")
      .find((line) => line.trim().startsWith("if placeholder == null and as_low_as_metafield"));
    expect(ifLine).toBeDefined();
    expect(ifLine).toContain("as_low_as_metafield != blank");
    expect(ifLine).toContain("as_low_as_source_variant != null");
    expect(ifLine).toContain("as_low_as_source_variant.available");
    expect(ifLine).toContain("as_low_as_source_variant.price == as_low_as_metafield_card_anchor_minor");
    expect(ifLine).toContain("as_low_as_bank_minor > 0");
  });
});
