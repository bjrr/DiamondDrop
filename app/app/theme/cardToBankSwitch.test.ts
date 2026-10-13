import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-5, owner ruling 2026-09-19 (relayed via the team lead): Card -> Bank needed a
 * visible, one-click, no-confirmation control, asymmetric with the Bank -> Card reprice
 * flow already covered by cardCheckoutReprice.test.ts. Bank -> Card raises what the
 * customer pays (confirmation required, owner §19); Card -> Bank only ever lowers it (no
 * confirmation needed).
 *
 * Same static-source approach as the other theme tests in this directory: no Liquid
 * rendering engine is available, so these assert over the actual `.liquid` source.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");

const FILES = {
  cartFooter: join(THEME_ROOT, "sections", "main-cart-footer.liquid"),
  cartDrawer: join(THEME_ROOT, "snippets", "cart-drawer.liquid"),
} as const;

const FORBIDDEN_TERMS = [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

/** Strips {%- comment -%}...{%- endcomment -%} blocks so example attribute/copy text quoted
 *  inside a comment's own handoff notes is never mistaken for real markup. */
function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(path: string): string {
  return stripLiquidComments(readFileSync(path, "utf8"));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.each([
  ["sections/main-cart-footer.liquid (A2)", FILES.cartFooter],
  ["snippets/cart-drawer.liquid (A3)", FILES.cartDrawer],
])("%s — Card -> Bank switch control (owner ruling 2026-09-19)", (_label, path) => {
  it("GUARDS THE GUARD: file exists and is non-empty", () => {
    expect(read(path).length).toBeGreaterThan(0);
  });

  it("marks exactly one Card -> Bank control", () => {
    expect(countOccurrences(read(path), 'data-carat-payment-mode-action="bank"')).toBe(1);
  });

  it("the control is a plain button, not a submit — it must never fall through to checkout on its own", () => {
    const source = read(path);
    const index = source.indexOf('data-carat-payment-mode-action="bank"');
    const window = source.slice(Math.max(0, index - 200), index + 20);
    expect(window).toMatch(/type="button"/);
    expect(window).not.toMatch(/type="submit"/);
  });

  it("carries no data-carat-checkout-action (it is not a checkout control)", () => {
    const source = read(path);
    const index = source.indexOf('data-carat-payment-mode-action="bank"');
    const window = source.slice(Math.max(0, index - 400), index + 400);
    expect(window).not.toContain("data-carat-checkout-action");
  });

  it("starts hidden only while the cart is already in Bank mode (redundant there)", () => {
    const source = read(path);
    expect(source).toContain("data-carat-payment-mode-action-wrapper");
    const wrapperIndex = source.indexOf("data-carat-payment-mode-action-wrapper");
    const window = source.slice(wrapperIndex, wrapperIndex + 200);
    expect(window).toContain("cart.attributes.carat_payment_mode == 'bank'");
    expect(window).toContain("hidden");
  });

  it("does not introduce a new data-carat-money kind (references the existing cart-saving figure instead)", () => {
    const source = read(path);
    const wrapperIndex = source.indexOf("data-carat-payment-mode-action-wrapper");
    const end = source.indexOf("</p>", wrapperIndex);
    const block = source.slice(wrapperIndex, end === -1 ? undefined : end);
    expect(block).not.toContain("data-carat-money");
  });

  it("uses owner-flagged copy via locale keys, not hardcoded strings", () => {
    const source = read(path);
    expect(source).toContain("'sections.cart.pricing.switch_to_bank_payment' | t");
    expect(source).toContain("'sections.cart.pricing.switch_to_bank_payment_note' | t");
  });

  it("the control sits after the always-visible owner §3 breakdown (so 'shown above' in its copy is accurate)", () => {
    const source = read(path);
    const savingIndex = source.indexOf('data-carat-money="cart-saving"');
    const controlIndex = source.indexOf('data-carat-payment-mode-action="bank"');
    expect(savingIndex).toBeGreaterThan(-1);
    expect(controlIndex).toBeGreaterThan(savingIndex);
  });

  it("does not read a raw Shopify cart/line money object directly in the new markup", () => {
    const source = read(path);
    const wrapperIndex = source.indexOf("data-carat-payment-mode-action-wrapper");
    const end = source.indexOf("</p>", wrapperIndex);
    const block = source.slice(wrapperIndex, end === -1 ? undefined : end);
    expect(block).not.toMatch(/\bcart\.total_price\b/);
    expect(block).not.toMatch(/\bitem\.final_line_price\b/);
  });

  it("introduces no forbidden pricing terminology", () => {
    const source = read(path);
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });
});

describe("coexistence with the reprice-confirm panel (both controls are independently hidden-toggled, not mutually exclusive in markup)", () => {
  it.each([
    ["sections/main-cart-footer.liquid", FILES.cartFooter],
    ["snippets/cart-drawer.liquid", FILES.cartDrawer],
  ])("%s: the switch-to-bank control and the reprice-confirm panel are separate DOM nodes, neither nested inside the other", (_label, path) => {
    const source = read(path);
    const switchIndex = source.indexOf("data-carat-payment-mode-action-wrapper");
    const confirmIndex = source.indexOf("data-carat-card-checkout-confirm");
    expect(switchIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(-1);
    // Neither wrapper's opening tag falls between the other's own open/close range —
    // a cheap non-nesting check given each is a single <p>...</p> block.
    const switchClose = source.indexOf("</p>", switchIndex);
    const confirmDivStart = source.lastIndexOf("<div", confirmIndex);
    const confirmDivEnd = source.indexOf("</div>", confirmIndex);
    const nestedInConfirm = switchIndex > confirmDivStart && switchIndex < confirmDivEnd;
    const nestedInSwitch = confirmIndex > switchIndex && confirmIndex < switchClose;
    expect(nestedInConfirm).toBe(false);
    expect(nestedInSwitch).toBe(false);
  });
});

describe("locale copy sanity (owner sign-off flagged in the 2B-5 handoff)", () => {
  const ENGLISH_LOCALE_PATH = join(THEME_ROOT, "locales", "en.default.json");

  it("switch_to_bank_payment and its note read as an offer, not a warning or upsell", () => {
    const raw = readFileSync(ENGLISH_LOCALE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      sections: { cart: { pricing: { switch_to_bank_payment: string; switch_to_bank_payment_note: string } } };
    };
    const { switch_to_bank_payment, switch_to_bank_payment_note } = parsed.sections.cart.pricing;
    expect(switch_to_bank_payment).toBeTruthy();
    expect(switch_to_bank_payment_note).toBeTruthy();
    for (const term of [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i, /error/i, /warning/i, /invalid/i, /upgrade/i]) {
      expect(switch_to_bank_payment).not.toMatch(term);
      expect(switch_to_bank_payment_note).not.toMatch(term);
    }
  });
});
