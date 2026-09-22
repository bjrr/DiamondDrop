import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-5, second follow-up round (2026-09-19): the JS half surfaced two gaps.
 *
 * 1. `snippets/cart-notification.liquid` (inventory C1) had a Card Checkout button with no
 *    `data-carat-checkout-action` marker, so it silently skipped the reprice-confirm
 *    interception applied to main-cart-footer.liquid and cart-drawer.liquid. Money-safe
 *    either way (Shopify still charges Card price there), but the same broken-promise shape
 *    on a smaller surface. Fixed by adding the marker only — deliberately NOT duplicating
 *    the confirm panel in this small, transient popup; the owner-preferred interception
 *    behaviour here is to close the popup and hand off to the full cart, which already
 *    carries the panel. That hand-off is JS behaviour, not asserted here.
 *
 * 2. Three JS-side error strings (`caratPriceUnavailable`, `caratCheckoutRepriceFailed`,
 *    `caratSwitchToBankFailed`) had hardcoded English fallbacks because the JS task could
 *    not touch locale files. Regularised into `theme/locales/en.default.json` and wired
 *    into `window.cartStrings` in `theme/layout/theme.liquid`, matching the pre-existing
 *    `error`/`quantityError` pattern in the same object.
 *
 * Same static-source approach as the sibling theme tests: no Liquid rendering engine is
 * available, so these assert over actual source text.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const CART_NOTIFICATION_PATH = join(THEME_ROOT, "snippets", "cart-notification.liquid");
const THEME_LAYOUT_PATH = join(THEME_ROOT, "layout", "theme.liquid");
const ENGLISH_LOCALE_PATH = join(THEME_ROOT, "locales", "en.default.json");

const FORBIDDEN_TERMS = [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("snippets/cart-notification.liquid — Card Checkout interception marker (C1)", () => {
  const raw = readFileSync(CART_NOTIFICATION_PATH, "utf8");
  const source = stripLiquidComments(raw);

  it("GUARDS THE GUARD: file exists and is non-empty", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it("marks the Card Checkout button exactly once", () => {
    expect(countOccurrences(source, 'data-carat-checkout-action="card"')).toBe(1);
  });

  it("does not duplicate the reprice-confirm panel in this popup (owner-preferred: close and hand off to the cart)", () => {
    expect(source).not.toContain("data-carat-checkout-action=\"card-confirm\"");
    expect(source).not.toContain("data-carat-card-checkout-confirm");
  });

  it("the marker is on the same native submit button, unmodified otherwise", () => {
    const index = source.indexOf('data-carat-checkout-action="card"');
    const window_ = source.slice(Math.max(0, index - 200), index + 20);
    expect(window_).toMatch(/name="checkout"/);
  });

  it("still offers the Bank Payment Checkout action, matching the cart footer/drawer treatment (Slice 2C task 2C-6: wired, no longer a stub)", () => {
    expect(source).toContain("sections.cart.bank_payment_checkout");
    expect(source).toMatch(/type="button"[\s\S]{0,200}data-carat-checkout-action="bank-payment"/);
  });

  it("introduces no forbidden pricing terminology", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });
});

describe("theme/layout/theme.liquid — window.cartStrings carries the new error keys", () => {
  const source = readFileSync(THEME_LAYOUT_PATH, "utf8");

  it("declares window.cartStrings with the pre-existing keys still present", () => {
    const index = source.indexOf("window.cartStrings = {");
    expect(index).toBeGreaterThan(-1);
    const end = source.indexOf("};", index);
    const block = source.slice(index, end);
    expect(block).toContain("error:");
    expect(block).toContain("quantityError:");
  });

  it("adds all three carat error keys the JS layer reads, each wired to a locale key", () => {
    const index = source.indexOf("window.cartStrings = {");
    const end = source.indexOf("};", index);
    const block = source.slice(index, end);
    expect(block).toContain("caratPriceUnavailable: `{{ 'sections.cart.pricing.price_unavailable' | t }}`");
    expect(block).toContain(
      "caratCheckoutRepriceFailed: `{{ 'sections.cart.pricing.checkout_reprice_failed' | t }}`"
    );
    expect(block).toContain("caratSwitchToBankFailed: `{{ 'sections.cart.pricing.switch_to_bank_failed' | t }}`");
  });
});

describe("theme/locales/en.default.json — the three carat error strings exist and read as plain errors", () => {
  const parsed = JSON.parse(readFileSync(ENGLISH_LOCALE_PATH, "utf8")) as {
    sections: {
      cart: {
        pricing: {
          price_unavailable: string;
          checkout_reprice_failed: string;
          switch_to_bank_failed: string;
        };
      };
    };
  };
  const { price_unavailable, checkout_reprice_failed, switch_to_bank_failed } = parsed.sections.cart.pricing;

  it("all three keys exist and are non-empty", () => {
    expect(price_unavailable).toBeTruthy();
    expect(checkout_reprice_failed).toBeTruthy();
    expect(switch_to_bank_failed).toBeTruthy();
  });

  it("none use forbidden pricing terminology", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(price_unavailable).not.toMatch(term);
      expect(checkout_reprice_failed).not.toMatch(term);
      expect(switch_to_bank_failed).not.toMatch(term);
    }
  });
});
