import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION FENCE for a defect no other test could see, found by running the
 * real storefront (spec §21).
 *
 * `window.CaratCartPricing` lives in `theme/assets/cart.js` and is what
 * switches a cart into Bank Payment mode. It used to load only from
 * `main-cart-items.liquid` and `cart-drawer.liquid` — the cart page and the
 * drawer. But "Add to Cart with Bank Payment Discount" renders on every
 * PRODUCT page, where neither is present, so the module was absent exactly
 * where the button lived. Clicking it added the item and left the cart in
 * CARD mode, silently: `product-form.js` degrades gracefully when the module
 * is missing, so there was no error to notice.
 *
 * WHY THE EXISTING TESTS MISSED IT. Every theme test renders Liquid in Node.
 * No `<script>` tag is ever evaluated, `window` does not exist, and so
 * "is this module actually loaded on this page?" is a question none of them
 * can ask. This file asks the only version of it that is answerable
 * statically: is cart.js loaded from a template that renders on EVERY page,
 * and from exactly one place?
 */

const THEME = join(process.cwd(), "..", "theme");
const CART_JS_TAG = /<script[^>]+['"]cart\.js['"][^>]*>/;

/** Rendered on every page through `header-group`, so anything here is global. */
const GLOBAL_TEMPLATE = join(THEME, "sections", "header.liquid");

function liquidFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["sections", "snippets", "layout", "templates"]) {
    const base = join(THEME, dir);
    for (const name of readdirSync(base)) {
      if (name.endsWith(".liquid")) out.push(join(base, name));
    }
  }
  return out;
}

/** Liquid comments are not markup; a mention inside one must not count as a load. */
function stripLiquidComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

describe("CaratCartPricing is available wherever a Bank Payment action can render", () => {
  it("cart.js is loaded from header.liquid, which renders on every page", () => {
    const header = stripLiquidComments(readFileSync(GLOBAL_TEMPLATE, "utf8"));
    expect(header).toMatch(CART_JS_TAG);
  });

  /**
   * EXACTLY ONE LOAD, not "at least one". `cart.js` calls
   * `customElements.define`, which throws on a second execution — so the fix
   * for the product page cannot be "also load it here", and a future edit that
   * re-adds a conditional load in the cart templates would break the cart
   * instead of the PDP. The count is the guard.
   */
  it("is loaded from exactly one template", () => {
    const loaders = liquidFiles().filter((file) =>
      CART_JS_TAG.test(stripLiquidComments(readFileSync(file, "utf8")))
    );

    expect(loaders.map((f) => f.split(/[\\/]/).pop())).toEqual(["header.liquid"]);
  });

  /**
   * The button and the module are what must travel together. If a future
   * change moves the Bank Payment add-to-cart action somewhere new, this still
   * holds — because the module is global — but if someone narrows cart.js back
   * to the cart surfaces, this fails and names why.
   */
  it("the Bank Payment add-to-cart action exists, so the module it needs must be global", () => {
    const withBankAction = liquidFiles().filter((file) =>
      /data-carat-add-to-cart\s*=\s*["']bank["']/.test(readFileSync(file, "utf8"))
    );

    expect(withBankAction.length).toBeGreaterThan(0);
    const header = stripLiquidComments(readFileSync(GLOBAL_TEMPLATE, "utf8"));
    expect(
      CART_JS_TAG.test(header),
      "a Bank Payment add-to-cart button renders in " +
        withBankAction.map((f) => f.split(/[\\/]/).pop()).join(", ") +
        ", but cart.js — which defines window.CaratCartPricing — is no longer loaded globally. " +
        "The button will add the item and silently leave the cart in Card mode."
    ).toBe(true);
  });
});
