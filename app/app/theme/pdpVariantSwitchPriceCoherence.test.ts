import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Owner exit proof P3 for task 2B-6: variant switching on the PDP must
 * update the Card price, Bank Payment Price and saving as ONE coherent set —
 * never a new card price beside a stale bank figure, and never a saving
 * computed across two different variants' calculations.
 *
 * THE HAZARD AS FRAMED: a naive theme reads the new variant's price from
 * client-side product JSON (which carries only the Shopify price — the
 * Regular/Card Price) and patches just that one DOM node, leaving any
 * separately-rendered Bank figure to lag or never update.
 *
 * WHY THAT HAZARD DOES NOT APPLY HERE, VERIFIED RATHER THAN ASSUMED. This
 * Dawn version's variant-change path (`assets/product-info.js`,
 * `handleUpdateProductInfo`) does NOT read variant.price from client-side
 * JSON at all. It fetches the WHOLE section server-rendered for the newly
 * selected variant (`?variant=<id>&section_id=<id>`, Section Rendering
 * API) and does exactly one DOM write for price:
 *
 *   const source = html.getElementById(`price-${sectionId}`);
 *   const destination = this.querySelector(`#price-${this.dataset.section}`);
 *   destination.innerHTML = source.innerHTML;
 *
 * `price.liquid`'s entire `mode: 'pdp'` output — card price, bank price AND
 * saving — lives inside that single `#price-{{ section.id }}` container in
 * both `main-product.liquid` and `featured-product.liquid` (this snippet is
 * the ONLY thing rendered there). Because the container's `innerHTML` is
 * replaced in one synchronous assignment sourced from one server render
 * pass for the new variant, the three figures can never observably update
 * out of step with each other — there is no intermediate DOM state where
 * only the card price has changed. The atomicity is a property of the
 * SINGLE fetch + SINGLE innerHTML write, not of anything price.liquid
 * itself does; these tests exist so a future change to either side (a
 * finer-grained JS selector, or splitting the container in Liquid) cannot
 * silently reintroduce the exact race this proof rules out.
 *
 * Same static-source approach as the rest of this directory: no browser/DOM
 * harness is available, so this proves the WIRING that makes atomicity true
 * (single id, single swap call, no competing JS), not a live variant switch.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const PRODUCT_INFO_JS_PATH = join(THEME_ROOT, "assets", "product-info.js");
const MAIN_PRODUCT_PATH = join(THEME_ROOT, "sections", "main-product.liquid");
const FEATURED_PRODUCT_PATH = join(THEME_ROOT, "sections", "featured-product.liquid");
const ASSETS_DIR = join(THEME_ROOT, "assets");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("assets/product-info.js — the price container is swapped as ONE atomic unit on variant change", () => {
  const source = read(PRODUCT_INFO_JS_PATH);

  it("GUARDS THE GUARD: the file exists and is non-empty", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("calls updateSourceFromDestination('price') exactly once — not decomposed into finer-grained selectors", () => {
    const calls = source.match(/updateSourceFromDestination\(\s*'price'/g) ?? [];
    expect(calls.length).toBe(1);
    // A future "helpful" refactor splitting this into e.g. updateSourceFromDestination('carat-bank-payment-price')
    // would reintroduce exactly the race this proof exists to rule out.
    expect(source).not.toMatch(/updateSourceFromDestination\(\s*'carat-/);
  });

  it("the swap helper does a single innerHTML assignment, not a field-by-field patch", () => {
    const fnStart = source.indexOf("const updateSourceFromDestination = (id");
    const fnEnd = source.indexOf("};", fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnEnd);
    expect(fnBody).toContain("destination.innerHTML = source.innerHTML");
    // Only one assignment statement, not per-field writes that could interleave.
    expect((fnBody.match(/\.innerHTML\s*=/g) ?? []).length).toBe(1);
  });

  it("both the source and destination nodes are resolved from the SAME id (`price-<sectionId>`), the id price.liquid's callers use", () => {
    const fnStart = source.indexOf("const updateSourceFromDestination = (id");
    const fnEnd = source.indexOf("};", fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    expect(fnBody).toContain("html.getElementById(`${id}-${this.sectionId}`)");
    expect(fnBody).toContain('this.querySelector(`#${id}-${this.dataset.section}`)');
  });

  it("the price swap is sourced from a server-rendered response for the NEW variant, not client-side JSON", () => {
    // handleUpdateProductInfo receives `html` — the parsed DOMParser result of the
    // fetch response — and updateSourceFromDestination reads from THAT html, never
    // from a `variant.price`/`JSON.parse` value computed in the browser.
    expect(source).not.toMatch(/variant\.price\b/);
    expect(source).not.toMatch(/JSON\.parse[^)]*price/i);
  });
});

describe.each([
  ["sections/main-product.liquid", MAIN_PRODUCT_PATH],
  ["sections/featured-product.liquid", FEATURED_PRODUCT_PATH],
])("%s — card price, bank price and saving share ONE swap container", (_label, path) => {
  it("the price block's wrapping id is exactly price-{{ section.id }}, matching product-info.js's swap target", () => {
    const source = read(path);
    expect(source).toContain('id="price-{{ section.id }}"');
  });

  it("nothing bank-payment-related is rendered directly in this section file (it all comes from the single render 'price' call, so there is no second swap target to desync)", () => {
    const source = read(path);
    expect(source).not.toMatch(/carat-bank-payment/);
    expect(source).not.toMatch(/bank_payment_price['"]\s*\|\s*t/);
  });
});

describe("no theme JS independently renders or caches the Bank Payment figure outside the section swap", () => {
  it("no asset file references the bank-payment DOM markers price.liquid renders (would be a second, racing update path)", () => {
    const jsFiles = ["cart.js", "cart-drawer.js", "product-form.js", "global.js"];
    for (const file of jsFiles) {
      const source = read(join(ASSETS_DIR, file));
      expect(source, `${file} should not reference carat-bank-payment DOM markers`).not.toMatch(
        /carat-bank-payment/
      );
    }
  });
});
