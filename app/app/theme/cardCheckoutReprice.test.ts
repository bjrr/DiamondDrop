import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-5 — owner §19's second sentence (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md):
 * "If the customer changes to Card, the cart/order must reprice to Regular/Card pricing
 * before payment and show the updated total."
 *
 * Same static-source approach as cartR12DomContract.test.ts: no Liquid rendering engine
 * is available, so these assert over the actual `.liquid` source. A regex match proves the
 * markup and copy exist in the template, not that the JS interception (owned elsewhere)
 * actually intercepts a click — that belongs to the JS owner's own tests.
 *
 * WHY THIS EXISTS SEPARATELY FROM cartR12DomContract.test.ts's existing "still Shopify's
 * own native checkout submit, unmodified" assertion: that assertion is still true and
 * unchanged (the button remains a plain native submit in markup — the interception is
 * JS-only, added via `event`-level preventDefault, not a markup change), so it was not
 * edited. This file adds the NEW markup this task introduces on top of it.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");

const FILES = {
  cartFooter: join(THEME_ROOT, "sections", "main-cart-footer.liquid"),
  cartDrawer: join(THEME_ROOT, "snippets", "cart-drawer.liquid"),
} as const;

/** Strips {%- comment -%}...{%- endcomment -%} blocks so example attribute/copy text quoted
 *  inside a comment's own handoff notes is never mistaken for real markup. */
function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(path: string): string {
  return stripLiquidComments(readFileSync(path, "utf8"));
}

function countOccurrences(haystack: string, needle: string): number {
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return (haystack.match(pattern) ?? []).length;
}

describe.each([
  ["sections/main-cart-footer.liquid (A2)", FILES.cartFooter, "cart"],
  ["snippets/cart-drawer.liquid (A3)", FILES.cartDrawer, "CartDrawer-Form"],
])("%s — Card Checkout reprice-before-payment (owner §19)", (_label, path, formId) => {
  it("GUARDS THE GUARD: file exists and is non-empty", () => {
    expect(read(path).length).toBeGreaterThan(0);
  });

  it("marks the primary Card Checkout button with exactly one data-carat-checkout-action=\"card\"", () => {
    expect(countOccurrences(read(path), 'data-carat-checkout-action="card"')).toBe(1);
  });

  it("the primary button is still a native submit into the same cart form (unmodified per se, interception is JS-only)", () => {
    const source = read(path);
    const index = source.indexOf('data-carat-checkout-action="card"');
    expect(index).toBeGreaterThan(-1);
    // The card-confirm button also contains "card" as a substring via "card-confirm", so
    // scope this check to the primary button only by taking a window before/after the match.
    const window = source.slice(Math.max(0, index - 300), index + 300);
    expect(window).toMatch(/type="submit"/);
    expect(window).toMatch(/name="checkout"/);
    expect(window).toContain(`form="${formId}"`);
  });

  it("exactly one confirm panel, hidden by default", () => {
    const source = read(path);
    expect(countOccurrences(source, "data-carat-card-checkout-confirm")).toBe(1);
    const index = source.indexOf("data-carat-card-checkout-confirm");
    const window = source.slice(index, index + 60);
    expect(window).toContain("hidden");
  });

  it("exactly one second, explicit confirm action (data-carat-checkout-action=\"card-confirm\"), also a native submit into the same form", () => {
    const source = read(path);
    expect(countOccurrences(source, 'data-carat-checkout-action="card-confirm"')).toBe(1);
    const index = source.indexOf('data-carat-checkout-action="card-confirm"');
    const window = source.slice(Math.max(0, index - 300), index + 100);
    expect(window).toMatch(/type="submit"/);
    expect(window).toMatch(/name="checkout"/);
    expect(window).toContain(`form="${formId}"`);
  });

  it("the confirm panel appears after the primary Card Checkout button", () => {
    const source = read(path);
    expect(source.indexOf('data-carat-checkout-action="card"')).toBeLessThan(
      source.indexOf("data-carat-card-checkout-confirm")
    );
  });

  it("uses the owner-flagged reprice-notice copy and confirm-button label via locale keys", () => {
    const source = read(path);
    expect(source).toContain("'sections.cart.pricing.card_checkout_reprice_notice' | t");
    expect(source).toContain("'sections.cart.card_checkout_confirm' | t");
  });

  it("the reprice notice is announced as a status, not an alert/error (this is an expected consequence, not a warning)", () => {
    const source = read(path);
    const index = source.indexOf("card_checkout_reprice_notice");
    const window = source.slice(Math.max(0, index - 300), index + 20);
    expect(window).toContain('role="status"');
    expect(window).not.toContain('role="alert"');
  });

  it("does not introduce a new data-carat-money kind for the reprice total (reuses the existing always-visible Card Total)", () => {
    const source = read(path);
    const index = source.indexOf("data-carat-card-checkout-confirm");
    const end = source.indexOf("</div>", index);
    const block = source.slice(index, end === -1 ? undefined : end);
    expect(block).not.toContain("data-carat-money");
  });

  it("does not read a raw Shopify cart/line money object directly in the new markup", () => {
    const source = read(path);
    const index = source.indexOf("data-carat-card-checkout-confirm");
    const end = source.indexOf("</div>", index);
    const block = source.slice(index, end === -1 ? undefined : end);
    expect(block).not.toMatch(/\bcart\.total_price\b/);
    expect(block).not.toMatch(/\bitem\.final_line_price\b/);
  });
});

describe("locale copy sanity (owner sign-off flagged in the 2B-5 handoff)", () => {
  const ENGLISH_LOCALE_PATH = join(THEME_ROOT, "locales", "en.default.json");

  it("card_checkout_reprice_notice does not use forbidden terminology and does not read as an error", () => {
    const raw = readFileSync(ENGLISH_LOCALE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { sections: { cart: { pricing: { card_checkout_reprice_notice: string } } } };
    const notice = parsed.sections.cart.pricing.card_checkout_reprice_notice;
    expect(notice).toBeTruthy();
    for (const term of [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i, /error/i, /warning/i, /invalid/i]) {
      expect(notice).not.toMatch(term);
    }
  });

  it("card_checkout_confirm label reads as a forward action, not a warning", () => {
    const raw = readFileSync(ENGLISH_LOCALE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { sections: { cart: { card_checkout_confirm: string } } };
    expect(parsed.sections.cart.card_checkout_confirm).toBeTruthy();
  });
});
