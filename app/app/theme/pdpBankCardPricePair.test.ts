import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-6, PDP half (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §3
 * "Product page", and docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md §E,
 * criterion 56).
 *
 * Same static-source approach as pdpAddToCartActions.test.ts and
 * cartMoneySurfaceFence.test.ts: no Liquid rendering engine is available, so
 * these assert over the actual `.liquid` source rather than rendered DOM.
 *
 * Covers `snippets/price.liquid`'s `mode: 'pdp'` branch and its two callers,
 * `sections/main-product.liquid` and `sections/featured-product.liquid` — the
 * latter "the one people forget" per the team lead's brief.
 *
 * THE COHERENCE CHECK UNDER TEST (criterion 56 / R14). `price.liquid` cannot
 * compare the metafield's `priceCalculationId` against anything else in
 * Liquid — `masterVariantId` embedded in the metafield is this app's
 * internal Postgres id, not a Shopify variant id, so there is no shared
 * namespace to resolve it through (see price.liquid's own module comment).
 *
 * The owner's R14 ruling closed that gap with a purpose-built,
 * self-validating anchor pair the backend embeds ONLY for validation,
 * never for display: `shopifyVariantId` (a Liquid-native variant id) and
 * `cardPriceAnchorMinorUnits` (a Card price snapshot). Both are decimal
 * STRINGS like every other field in this payload — an earlier number-typed
 * draft was rejected by the architect as an unnecessary money-safety
 * exemption — so both get the same `| plus: 0` numeric-cast idiom already
 * used for the display figures before comparing against `target.id` /
 * `native_card_minor`. The pair renders only when the metafield names the
 * variant actually being rendered AND its anchor still equals that
 * variant's live native price. A metafield write that failed independently
 * of a
 * successful native price write leaves a stale anchor that no longer
 * matches — detected with no extra signal, because it's compared against
 * the one value that cannot itself be stale: what Shopify is currently
 * serving. These tests assert that shape exists in the source, not that it
 * evaluates correctly at runtime (no renderer available to prove that here).
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const PRICE_PATH = join(THEME_ROOT, "snippets", "price.liquid");
const MAIN_PRODUCT_PATH = join(THEME_ROOT, "sections", "main-product.liquid");
const FEATURED_PRODUCT_PATH = join(THEME_ROOT, "sections", "featured-product.liquid");

/** Forbidden per CLAUDE.md §12 / owner criterion 37. */
const FORBIDDEN_TERMS = [/cash discount/i, /cash price/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(path: string): string {
  return stripLiquidComments(readFileSync(path, "utf8"));
}

function pdpBranch(source: string): string {
  const start = source.indexOf("{%- elsif mode == 'pdp' -%}");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start);
}

describe("snippets/price.liquid — mode: 'pdp' (owner §3, criterion 56)", () => {
  const source = read(PRICE_PATH);
  const branch = pdpBranch(source);

  it("GUARDS THE GUARD: the file exists and the pdp branch was found", () => {
    expect(branch.length).toBeGreaterThan(0);
  });

  it("the primary figure is the native Shopify variant price, never re-derived", () => {
    expect(branch).toContain("assign native_card_minor = target.price");
    expect(branch).toContain("card_money");
  });

  it("reads the variant-level bank payment metafield", () => {
    expect(branch).toContain("target.metafields.carat.bank_payment_price_minor_units.value");
  });

  it("casts the R14 identity/anchor fields with the same `| plus: 0` idiom as the display figures (both are decimal strings)", () => {
    expect(branch).toContain("assign bank_metafield_variant_id = bank_metafield.shopifyVariantId | plus: 0");
    expect(branch).toContain(
      "assign bank_metafield_card_anchor_minor = bank_metafield.cardPriceAnchorMinorUnits | plus: 0"
    );
  });

  it("coherence check (R14) requires BOTH variant identity and the anchor price to match — not price alone", () => {
    const gateIndex = branch.indexOf("assign bank_pair_coherent = false");
    const gateBlock = branch.slice(gateIndex, gateIndex + 400);
    expect(gateBlock).toContain("bank_metafield != blank");
    expect(gateBlock).toContain("bank_metafield_variant_id == target.id");
    expect(gateBlock).toContain("bank_metafield_card_anchor_minor == native_card_minor");
  });

  it("the gate compares the ALREADY-CAST intermediate values, not the raw metafield fields inline (avoids ambiguous filter/operator precedence)", () => {
    const gateIndex = branch.indexOf("assign bank_pair_coherent = false");
    const gateLine = branch.slice(gateIndex, branch.indexOf("endif", gateIndex));
    expect(gateLine).not.toMatch(/bank_metafield\.shopifyVariantId/);
    expect(gateLine).not.toMatch(/bank_metafield\.cardPriceAnchorMinorUnits/);
  });

  it("never compares by masterVariantId or priceCalculationId (no shared namespace exists in Liquid to do so)", () => {
    expect(branch).not.toMatch(/masterVariantId/);
    expect(branch).not.toMatch(/priceCalculationId/);
  });

  it("shopifyVariantId and cardPriceAnchorMinorUnits (raw or cast) exist only to validate the pair — never rendered/printed", () => {
    expect(branch).not.toMatch(/{{-?\s*bank_metafield\.shopifyVariantId/);
    expect(branch).not.toMatch(/{{-?\s*bank_metafield\.cardPriceAnchorMinorUnits/);
    expect(branch).not.toMatch(/{{-?\s*bank_metafield_variant_id/);
    expect(branch).not.toMatch(/{{-?\s*bank_metafield_card_anchor_minor/);
  });

  it("the bank/saving figures render only inside the bank_pair_coherent guard", () => {
    const guardIndex = branch.indexOf("{%- if bank_pair_coherent -%}");
    const guardEnd = branch.indexOf("{%- endif -%}", guardIndex);
    expect(guardIndex).toBeGreaterThan(-1);
    const guardedBlock = branch.slice(guardIndex, guardEnd);
    expect(guardedBlock).toContain("carat-bank-payment-price");
    expect(guardedBlock).toContain("carat-bank-payment-saving");
    expect(guardedBlock).toContain("bank_money");
    expect(guardedBlock).toContain("saving_money");

    // The bank/saving figures are only PRINTED inside the guard — `assign`ing them earlier
    // (once, in the shared {% liquid %} block) is fine and expected; interpolating them
    // ({{ bank_money }} / {{ saving_money }}) outside the guard would leak an unverified
    // pair onto the page even when bank_pair_coherent is false.
    const beforeGuard = branch.slice(0, guardIndex);
    const afterGuard = branch.slice(guardEnd);
    expect(beforeGuard).not.toMatch(/{{-?\s*bank_money/);
    expect(beforeGuard).not.toMatch(/{{-?\s*saving_money/);
    expect(afterGuard).not.toMatch(/{{-?\s*bank_money/);
    expect(afterGuard).not.toMatch(/{{-?\s*saving_money/);
  });

  it("uses owner §3's exact presentation: card price primary, bank price and saving as separate labelled rows", () => {
    expect(branch).toContain("'products.product.price.bank_payment_price' | t");
    expect(branch).toContain("'products.product.price.bank_payment_saving_html' | t: amount: saving_money");
  });

  it("does no arithmetic on the metafield values beyond the safe numeric-cast idiom (`| plus: 0`)", () => {
    expect(branch).not.toMatch(/metafield_\w+_minor\s*\|\s*times/);
    expect(branch).not.toMatch(/metafield_\w+_minor\s*\|\s*minus/);
    expect(branch).not.toMatch(/metafield_\w+_minor\s*\|\s*divided_by/);
    // The saving must be the metafield's OWN precomputed field, never re-derived as card - bank.
    expect(branch).not.toMatch(/native_card_minor\s*\|\s*minus/);
    expect(branch).not.toMatch(/metafield_card_minor\s*\|\s*minus/);
  });

  it("does not read a raw Shopify cart/line money object (L1, re-asserted here as this file is new to money-adjacent logic)", () => {
    expect(branch).not.toMatch(/\bcart\.total_price\b/);
    expect(branch).not.toMatch(/\bcart\.items_subtotal_price\b/);
    expect(branch).not.toMatch(/\bitem\.final_line_price\b/);
  });

  it("introduces no forbidden pricing terminology, and never prints the internal percentage/tier fields", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(branch).not.toMatch(term);
    }
    expect(branch).not.toMatch(/appliedUpliftRate/);
    expect(branch).not.toMatch(/appliedTierLabel/);
  });
});

describe("P4 proof of absence — the native Card price never substitutes for the Bank Payment figure", () => {
  const source = read(PRICE_PATH);
  const branch = pdpBranch(source);

  it("metafield_bank_minor, metafield_saving_minor and the R14 identity/anchor casts carry no fallback filter of any kind", () => {
    for (const name of [
      "metafield_bank_minor",
      "metafield_saving_minor",
      "bank_metafield_variant_id",
      "bank_metafield_card_anchor_minor",
    ]) {
      const line = branch.split("\n").find((l) => l.trim().startsWith(`assign ${name} =`))?.trim();
      expect(line, `expected an 'assign ${name} =' line`).toBeDefined();
      // The only filter permitted here is the safe numeric-cast idiom (`| plus: 0`). A
      // `| default: native_card_minor` (or any other native-price token) would silently
      // render the Card price under the Bank Payment label the instant the metafield is
      // absent or its relevant field is missing — undercharging in the customer's favour,
      // which would never surface as a complaint (owner's exact framing of this hazard). For
      // the identity/anchor casts specifically, a `| default:` here would be worse than
      // pointless — it would let a MISSING R14 field silently coerce to a value that could
      // spuriously match, defeating the whole point of the anchor.
      expect(line).toMatch(new RegExp(`^assign ${name} = bank_metafield\\.\\w+ \\| plus: 0$`));
    }
  });

  it("no native-price token appears anywhere on the metafield_bank_minor, metafield_saving_minor, bank_money, saving_money, or R14 identity/anchor assignment lines", () => {
    const lines = branch
      .split("\n")
      .filter((l) =>
        /assign (metafield_bank_minor|metafield_saving_minor|bank_money|saving_money|bank_metafield_variant_id|bank_metafield_card_anchor_minor) =/.test(
          l.trim()
        )
      );
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      expect(line).not.toMatch(/native_card_minor|target\.price|product\.price|variant\.price|compare_at_price|card_money|metafield_card_minor/);
    }
  });

  it("the coherence gate — never a fallback value — is what governs whether the pair renders at all", () => {
    // Re-stated in value-substitution terms: even if metafield_bank_minor could somehow become
    // a Card-basis number, bank_pair_coherent still requires the metafield to exist AND its own
    // embedded card price to independently match the native variant price — a gate that checks
    // provenance, not merely "is this a plausible-looking number".
    const gateLine = branch.split("\n").find((l) => l.trim().startsWith("if placeholder == null and bank_metafield"));
    expect(gateLine).toContain("bank_metafield != blank");
  });

  it("a metafield whose identity does not name the rendered variant cannot render the pair (R14) — price agreement alone is not enough", () => {
    // Proof-of-absence for the specific R14 hazard: a metafield could, in principle, carry a
    // card-price anchor that happens to equal the CURRENT variant's price while actually
    // belonging to a DIFFERENT variant (e.g. two variants priced identically). The identity
    // clause is what rules that out — it must appear in the gate, not just the price comparison.
    const gateLine = branch.split("\n").find((l) => l.trim().startsWith("if placeholder == null and bank_metafield"));
    expect(gateLine).toContain("bank_metafield_variant_id == target.id");
  });
});

describe.each([
  ["sections/main-product.liquid", MAIN_PRODUCT_PATH],
  ["sections/featured-product.liquid", FEATURED_PRODUCT_PATH],
])("%s — PDP price block uses mode: 'pdp'", (_label, path) => {
  it("passes mode: 'pdp' and use_variant: true to the shared price snippet", () => {
    const source = read(path);
    const callIndex = source.indexOf("render 'price'");
    expect(callIndex).toBeGreaterThan(-1);
    const callEnd = source.indexOf("-%}", callIndex);
    const call = source.slice(callIndex, callEnd);
    expect(call).toContain("mode: 'pdp'");
    expect(call).toContain("use_variant: true");
  });

  it("introduces no forbidden pricing terminology", () => {
    const source = read(path);
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });
});

describe("guard the guard — the pdp branch is actually reachable and distinct from as_low_as", () => {
  it("mode == 'as_low_as' and mode == 'pdp' are mutually exclusive branches of the same if/elsif chain", () => {
    const source = read(PRICE_PATH);
    const asLowAsIndex = source.indexOf("{%- if mode == 'as_low_as' -%}");
    const pdpIndex = source.indexOf("{%- elsif mode == 'pdp' -%}");
    expect(asLowAsIndex).toBeGreaterThan(-1);
    expect(pdpIndex).toBeGreaterThan(asLowAsIndex);
  });
});
