import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Liquid, type TagToken, type Context as LiquidContext } from "liquidjs";
import { beforeAll, describe, expect, it } from "vitest";

import type { PublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import { buildProductAsLowAsMetafield, buildVariantBankPaymentPriceMetafield } from "~/shopify/metafields/priceMetafieldPayload";

/**
 * R16 (owner-mandated standing money-critical gate, 2026-09-21) — the
 * permanent structural fix for an incident this file exists to prevent from
 * recurring silently.
 *
 * WHAT WENT WRONG. `discoveryAsLowAsPrice.test.ts` and
 * `pdpBankCardPricePair.test.ts` proved `price.liquid`'s SOURCE TEXT — that
 * the right `if`/`for` conditions exist, in the right place, guarding the
 * right output. Every theme test in this repository works this way, because
 * no Liquid rendering engine was available: they assert over `.liquid`
 * source with regexes, never over rendered output. That is precisely why
 * the string/number bug survived 56 green tests. A source-inspection test
 * can prove a cast is WRITTEN; it cannot prove a comparison WORKS WITH REAL
 * DATA, because it never actually evaluates the comparison. An earlier
 * version of this file tried to close that gap with a hand-written
 * TypeScript mirror of Liquid's `==`/`plus:0` semantics — rejected on
 * review, correctly: that models the OTHER system rather than using it,
 * which is the exact category of error this file exists to correct,
 * committed one level up.
 *
 * THE FIX. This file adds `liquidjs` (devDependency, test-only, never
 * shipped) and actually RENDERS the real `snippets/price.liquid` source —
 * not a copy, not a re-implementation — against fixture contexts, fed by
 * the REAL producer functions in `priceMetafieldPayload.ts`. Every metafield
 * value below is `JSON.parse`d from an ACTUAL, unmodified
 * `buildVariantBankPaymentPriceMetafield` / `buildProductAsLowAsMetafield`
 * return value. If a producer renames a field, changes a type, or changes
 * how it serializes, the REAL template — evaluating a REAL comparison
 * against that REAL value — is what breaks, not an approximation of either.
 *
 * RESIDUAL LIMITATION, STATED PLAINLY SO NOBODY LATER MISTAKES THIS FOR A
 * FULL THEME-RENDERING GUARANTEE. `liquidjs` is not Shopify's Liquid
 * dialect. For CONTROL FLOW, FILTERS and EQUALITY SEMANTICS — `if`/`elsif`/
 * `unless`/`for`, `plus`/`default`, and Liquid's type-strict `==` (`"9" ==
 * 9` is `false`, matching JS `===`, never JS's coercing `==`) — it is
 * faithful: these are standard Liquid, unmodified by Shopify, and exactly
 * what failed in the incident this file exists to prevent. For
 * SHOPIFY-SPECIFIC rendering behaviour it is an approximation:
 *   - `money` / `money_with_currency` are stubbed below to a plain
 *     `$X.XX` string — real Shopify formatting (locale, currency symbol
 *     placement, `settings.money_format`) is NOT exercised;
 *   - `t` (translation) is stubbed to echo the locale key rather than
 *     resolving `theme/locales/en.default.json` — the actual translated
 *     copy is NOT exercised here (covered instead by the exact-string
 *     assertions in `discoveryAsLowAsPrice.test.ts` / `pdpBankCardPricePair.test.ts`);
 *   - the one `{% render 'unit-price', ... %}` call in this template is
 *     stubbed to a no-op tag — every fixture below keeps
 *     `unit_price_measurement` falsy, so that branch is never reached, and
 *     `unit-price.liquid` itself is not under test here at all.
 * This file proves the COHERENCE GATE — whether Bank pricing renders or
 * suppresses, and with which figures — against real producer data. It does
 * not prove pixel-for-pixel Shopify rendering fidelity; the sibling
 * source-text tests remain the source of truth for the exact locale keys,
 * CSS classes and markup structure this file's stubs deliberately elide.
 *
 * WHY COMMENTS ARE STRIPPED BEFORE PARSING. Real Shopify Liquid treats
 * everything between a bare `comment` / `endcomment` inside a `{% liquid %}`
 * block as opaque, unparsed prose — this template's own module comment
 * (which legitimately contains stray `"quoted phrases"` and other
 * comment-only text) relies on that. `liquidjs`'s parser does not consume
 * that multi-line form the same way and fails to parse the template as a
 * result. Comments can never affect behaviour by definition, so stripping
 * them from the copy fed to `liquidjs` (never from the real file) is a safe
 * accommodation for the test harness, not a change to what is under test.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const PRICE_PATH = join(THEME_ROOT, "snippets", "price.liquid");

function stripCommentsForEngine(source: string): string {
  return source
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "")
    .replace(/^[ \t]*comment\b[\s\S]*?^[ \t]*endcomment[ \t]*$/gm, "");
}

function readEngineSource(): string {
  return stripCommentsForEngine(readFileSync(PRICE_PATH, "utf8"));
}

/** A no-op `render` tag: this template's only `{% render %}` call (`unit-price`) is never
 *  reached by any fixture below (`unit_price_measurement` is always falsy), so its content is
 *  irrelevant to the coherence gate under test — see the file header's residual-limitation note. */
class NoopRenderTag {
  parse(_tagToken: TagToken): void {
    // Intentionally does not consume/validate arguments — this template's one call is inert here.
  }
  render(_ctx: LiquidContext): string {
    return "";
  }
}

/**
 * Formats integer minor units (cents) as a `$X.XX` string for the `money` stub below, using ONLY
 * `BigInt` arithmetic — never a lossy float-widening cast or JS's own floating-point rounding
 * filter — per this repo's own money-safety scan (`scripts/check-money-safety.mjs`), which flags
 * exactly those two patterns on money-adjacent paths (deliberately not spelled out literally in
 * this comment, since the scan does not exclude comments and would flag naming its own targets).
 * This is display-only formatting for a TEST stub, not a real money computation, but there is no
 * reason a test file should be the one place in this repository that reaches for the pattern the
 * rest of the codebase is disciplined about avoiding — and doing it this way needed no
 * architect-reviewed allow-list entry at all.
 */
function formatMinorUnitsAsDollars(value: unknown): string {
  const cents = BigInt(String(value));
  const negative = cents < 0n;
  const absCents = negative ? -cents : cents;
  const dollars = absCents / 100n;
  const remainder = (absCents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars.toString()}.${remainder}`;
}

function createEngine(): Liquid {
  const engine = new Liquid();
  engine.registerFilter("money", (v: unknown) => formatMinorUnitsAsDollars(v));
  engine.registerFilter("money_with_currency", (v: unknown) => `${formatMinorUnitsAsDollars(v)} USD`);
  // The `t` stub deliberately echoes any hash (named) arguments into the output — e.g.
  // `'...as_low_as_html' | t: price: as_low_as_money` — because the tests below assert on the
  // rendered dollar figures, and those figures reach the output ONLY through this interpolation
  // for the 'as_low_as' price line and the 'bank_payment_saving_html' line. Real translated copy
  // is NOT exercised here (see the file header) — only that the right VALUE was interpolated.
  engine.registerFilter("t", (key: unknown, hash?: Record<string, unknown>) => {
    const params = hash && typeof hash === "object" ? hash : {};
    const parts = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`);
    return `[[t:${String(key)}${parts.length ? " " + parts.join(" ") : ""}]]`;
  });
  engine.registerTag("render", new NoopRenderTag());
  return engine;
}

const baseSettings = {
  currency_code_enabled: false,
  sale_badge_color_scheme: "scheme-1",
  sold_out_badge_color_scheme: "scheme-1",
};

interface VariantFixture {
  readonly id: number;
  readonly price: number;
  readonly available?: boolean;
  readonly metafieldValue: unknown;
}

function variantContext(fixture: VariantFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    price: fixture.price,
    compare_at_price: null,
    available: fixture.available ?? true,
    unit_price_measurement: null,
    metafields: { carat: { bank_payment_price_minor_units: { value: fixture.metafieldValue } } },
  };
}

async function renderPdp(engine: Liquid, source: string, fixture: VariantFixture, placeholder: unknown = null) {
  return engine.parseAndRender(source, {
    mode: "pdp",
    use_variant: true,
    show_badges: true,
    placeholder,
    settings: baseSettings,
    product: { selected_or_first_available_variant: variantContext(fixture) },
  });
}

interface AsLowAsVariantFixture {
  readonly id: number;
  readonly price: number;
  readonly available: boolean;
}

async function renderAsLowAs(
  engine: Liquid,
  source: string,
  metafieldValue: unknown,
  variants: readonly AsLowAsVariantFixture[],
  options: { productAvailable?: boolean; placeholder?: unknown } = {}
) {
  return engine.parseAndRender(source, {
    mode: "as_low_as",
    placeholder: options.placeholder ?? null,
    settings: baseSettings,
    product: {
      available: options.productAvailable ?? true,
      metafields: { carat: { as_low_as_bank_minor_units: { value: metafieldValue } } },
      variants,
    },
  });
}

function aPublishedPrice(overrides: Partial<PublishedVariantPrice> = {}): PublishedVariantPrice {
  return {
    masterVariantId: "11111111-1111-1111-1111-111111111111",
    priceCalculationId: "22222222-2222-2222-2222-222222222222",
    bankPaymentPriceMinorUnits: 100_000n,
    regularCardPriceMinorUnits: 104_000n,
    bankPaymentSavingsMinorUnits: 4_000n,
    currency: "USD",
    appliedUpliftRate: "0.040000",
    appliedTierLabel: "$1,000–$2,499.99",
    ...overrides,
  };
}

/** Real producer output, parsed — never a hand-typed object literal. */
function realVariantMetafield(shopifyVariantGid: string, published: PublishedVariantPrice): Record<string, unknown> {
  return JSON.parse(buildVariantBankPaymentPriceMetafield(shopifyVariantGid, published).value) as Record<
    string,
    unknown
  >;
}

function realAsLowAsMetafield(
  shopifyProductGid: string,
  published: PublishedVariantPrice,
  winningShopifyVariantGid: string
): Record<string, unknown> {
  return JSON.parse(buildProductAsLowAsMetafield(shopifyProductGid, published, winningShopifyVariantGid).value) as Record<
    string,
    unknown
  >;
}

describe("R16 permanent contract gate — real price.liquid rendered by liquidjs, fed by the real metafield producer", () => {
  let engine: Liquid;
  let source: string;

  beforeAll(() => {
    engine = createEngine();
    source = readEngineSource();
  });

  it("GUARDS THE GUARD: the harness actually renders SOMETHING for a trivial input, so a silent no-op stub isn't masking every case below", async () => {
    const out = await renderPdp(engine, source, {
      id: 9,
      price: 104_000,
      metafieldValue: null,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("$1040.00");
  });

  describe("PDP (mode: 'pdp')", () => {
    it("1. valid current cache → Bank pricing renders, with the exact real figures", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realVariantMetafield("gid://shopify/ProductVariant/9", published);
      const out = await renderPdp(engine, source, { id: 9, price: 104_000, metafieldValue: metafield });

      expect(out).toContain("carat-bank-payment-pair");
      expect(out).toContain("$1040.00"); // card price (native)
      expect(out).toContain("$1000.00"); // bank price (metafield)
      expect(out).toContain("$40.00"); // saving (metafield)
    });

    it("2. mismatched variant identity → Bank pricing suppresses (metafield names a different variant)", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      // Built for variant 42, but we render variant 9.
      const metafield = realVariantMetafield("gid://shopify/ProductVariant/42", published);
      const out = await renderPdp(engine, source, { id: 9, price: 104_000, metafieldValue: metafield });

      expect(out).not.toContain("carat-bank-payment-pair");
      expect(out).toContain("$1040.00"); // card price still renders, alone
    });

    it("2. mismatched Card-price anchor → Bank pricing suppresses (P1: metafield write failed while a LATER native price mutation succeeded)", async () => {
      const staleCalc = aPublishedPrice({ priceCalculationId: "calc-old", regularCardPriceMinorUnits: 104_000n });
      const staleMetafield = realVariantMetafield("gid://shopify/ProductVariant/9", staleCalc);
      // The live native price has since moved to a newer calculation's figure.
      const out = await renderPdp(engine, source, { id: 9, price: 108_000, metafieldValue: staleMetafield });

      expect(out).not.toContain("carat-bank-payment-pair");
      expect(out).toContain("$1080.00");
    });

    it("2. mismatched calculation id, reproduced via its actual consequence (two real payloads from two different calculations, the old one rendered against the new native price)", async () => {
      const oldCalc = realVariantMetafield(
        "gid://shopify/ProductVariant/9",
        aPublishedPrice({ priceCalculationId: "calc-old", regularCardPriceMinorUnits: 104_000n })
      );
      const newCalcNativePrice = 108_000;
      expect(oldCalc.priceCalculationId).not.toBe("calc-new");

      const out = await renderPdp(engine, source, { id: 9, price: newCalcNativePrice, metafieldValue: oldCalc });
      expect(out).not.toContain("carat-bank-payment-pair");
    });

    it("3. missing metafield → no Bank-labelled fallback (P4 at the serialized boundary) — card price alone", async () => {
      const out = await renderPdp(engine, source, { id: 9, price: 104_000, metafieldValue: null });
      expect(out).not.toContain("carat-bank-payment-pair");
      expect(out).toContain("$1040.00");
    });

    it("3. malformed cache — a REAL payload with the anchor field deleted (partial write) → no Bank-labelled fallback", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realVariantMetafield("gid://shopify/ProductVariant/9", published);
      delete metafield.cardPriceAnchorMinorUnits;

      const out = await renderPdp(engine, source, { id: 9, price: 104_000, metafieldValue: metafield });
      expect(out).not.toContain("carat-bank-payment-pair");
      expect(out).toContain("$1040.00");
    });
  });

  describe("As Low As (mode: 'as_low_as')", () => {
    it("1. valid current cache → Bank pricing renders, and 4. the correct source variant is accepted", async () => {
      const published = aPublishedPrice({ bankPaymentPriceMinorUnits: 100_000n, regularCardPriceMinorUnits: 104_000n });
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      const variants = [
        { id: 7, price: 99_900, available: true }, // a different, non-source variant
        { id: 42, price: 104_000, available: true }, // the real source/winning variant
      ];

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).toContain("carat-as-low-as");
      expect(out).not.toContain("price-item--unavailable");
      expect(out).toContain("$1000.00"); // the Bank Payment Price, from the metafield
    });

    it("4. correct source variant accepted by IDENTITY even when another variant shares its exact price", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      const variants = [
        { id: 7, price: 104_000, available: true }, // same price as the real winner, WRONG id
        { id: 42, price: 104_000, available: true },
      ];

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).toContain("carat-as-low-as");
      expect(out).not.toContain("price-item--unavailable");
    });

    it("2. source variant not found among product.variants → suppresses to the unavailable state", async () => {
      const published = aPublishedPrice();
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      const variants = [{ id: 7, price: 104_000, available: true }]; // 42 is entirely absent

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).not.toContain("carat-as-low-as");
      expect(out).toContain("price-item--unavailable");
    });

    it("2. source variant found but no longer available → suppresses ('currently purchasable', not merely named)", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      const variants = [{ id: 42, price: 104_000, available: false }];

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).not.toContain("carat-as-low-as");
      expect(out).toContain("price-item--unavailable");
    });

    it("2. mismatched Card-price anchor (source variant's live price has since changed) → suppresses", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      const variants = [{ id: 42, price: 112_000, available: true }]; // repriced since publish

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).not.toContain("carat-as-low-as");
      expect(out).toContain("price-item--unavailable");
    });

    it("3. missing metafield (R14/P2: the backend DELETES it once nothing is purchasable) → no Bank-labelled fallback", async () => {
      const variants = [{ id: 42, price: 104_000, available: true }];
      const out = await renderAsLowAs(engine, source, null, variants);
      expect(out).not.toContain("carat-as-low-as");
      expect(out).toContain("price-item--unavailable");
    });

    it("3. malformed cache — a REAL payload with the anchor field deleted → no Bank-labelled fallback", async () => {
      const published = aPublishedPrice({ regularCardPriceMinorUnits: 104_000n });
      const metafield = realAsLowAsMetafield("gid://shopify/Product/500", published, "gid://shopify/ProductVariant/42");
      delete metafield.cardPriceAnchorMinorUnits;
      const variants = [{ id: 42, price: 104_000, available: true }];

      const out = await renderAsLowAs(engine, source, metafield, variants);
      expect(out).not.toContain("carat-as-low-as");
      expect(out).toContain("price-item--unavailable");
    });
  });
});

describe("R16 step 5 — audit: every Liquid comparison against a JSON metafield value, reported explicitly", () => {
  /**
   * Generalized, executable fence (not a restatement of the four known sites): walks every line
   * of the real `price.liquid` source and flags any RAW `<metafield-var>.shopifyVariantId` /
   * `.cardPriceAnchorMinorUnits` dotted-path access outside the one `assign ... | plus: 0`
   * cast-assignment line each is legitimately read on. Protects a FUTURE comparison added
   * anywhere in this file against the raw path, not only the two currently known sites.
   */
  const RAW_FIELD_PATTERN = /\w*metafield\w*\.(shopifyVariantId|cardPriceAnchorMinorUnits)\b/g;
  const CAST_ASSIGN_PATTERN = /^assign \w+ = \w*metafield\w*\.(shopifyVariantId|cardPriceAnchorMinorUnits) \| plus: 0$/;

  function strippedRealSource(): string {
    return readFileSync(PRICE_PATH, "utf8").replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
  }

  it("GUARDS THE GUARD: the pattern matches both known raw field accesses", () => {
    expect(RAW_FIELD_PATTERN.test("bank_metafield.shopifyVariantId")).toBe(true);
    RAW_FIELD_PATTERN.lastIndex = 0;
    expect(RAW_FIELD_PATTERN.test("as_low_as_metafield.cardPriceAnchorMinorUnits")).toBe(true);
    RAW_FIELD_PATTERN.lastIndex = 0;
  });

  it("AUDITED AND FOUND CORRECT: no raw field access to shopifyVariantId/cardPriceAnchorMinorUnits appears outside its own cast-assignment line, anywhere in price.liquid", () => {
    const lines = strippedRealSource().split("\n");
    const violations: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      RAW_FIELD_PATTERN.lastIndex = 0;
      if (!RAW_FIELD_PATTERN.test(trimmed)) continue;
      if (CAST_ASSIGN_PATTERN.test(trimmed)) continue; // the legitimate cast-assignment line itself
      violations.push(trimmed);
    }
    expect(violations, `found raw (uncast) metafield field access: ${JSON.stringify(violations)}`).toEqual([]);
  });

  it("exactly four cast-assignment lines exist (two R14 fields × two modes) — confirms the audit found something to exempt, not a vacuous pass", () => {
    const castLines = strippedRealSource()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => CAST_ASSIGN_PATTERN.test(l));
    expect(castLines.length).toBe(4);
  });

  /**
   * AUDITED AND FOUND CORRECT, MANUALLY: every OTHER `==`/`!=`/`>`/`<` in price.liquid was
   * re-read line by line at the time this file was written (not just grepped for the two known
   * field names above):
   *   - `v.id == as_low_as_metafield_variant_id` — LHS native Liquid integer, RHS a cast
   *     intermediate (line ~130).
   *   - `as_low_as_source_variant.price == as_low_as_metafield_card_anchor_minor` and
   *     `as_low_as_bank_minor > 0` — LHS native integer / cast intermediate, RHS cast
   *     intermediate / literal (line ~137).
   *   - `bank_metafield_variant_id == target.id` and
   *     `bank_metafield_card_anchor_minor == native_card_minor` — both cast intermediates vs.
   *     native integers (line ~202).
   *   - `unless as_low_as_metafield == blank`, `bank_metafield != blank`,
   *     `as_low_as_metafield != blank`, `as_low_as_source_variant != null`,
   *     `placeholder == null` — nil/blank checks, not string-vs-number comparisons; this hazard
   *     class does not apply to them.
   *   - `available == false`, `compare_at_price > price`, `as_low_as_purchasable == false` —
   *     no metafield value on either side at all (native Shopify fields, or an internal boolean).
   * No comparison anywhere in the file was found comparing a raw, uncast metafield-derived value
   * against a native Liquid value.
   */
  it("AUDITED AND FOUND CORRECT: price.liquid is the ONLY .liquid file in the theme that reads a carat.* metafield at all — walked, not assumed", () => {
    function walkLiquidFiles(absoluteDir: string): string[] {
      const entries = readdirSync(absoluteDir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const absolutePath = join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walkLiquidFiles(absolutePath));
        } else if (entry.isFile() && entry.name.endsWith(".liquid")) {
          files.push(absolutePath);
        }
      }
      return files;
    }
    const files = ["layout", "sections", "snippets", "templates"].flatMap((dir) =>
      walkLiquidFiles(join(THEME_ROOT, dir))
    );
    expect(files.length).toBeGreaterThanOrEqual(80); // guards the guard: the walk found something
    const matchingFiles = files.filter((f) => readFileSync(f, "utf8").includes("metafields.carat."));
    expect(matchingFiles).toEqual([PRICE_PATH]);
  });
});
