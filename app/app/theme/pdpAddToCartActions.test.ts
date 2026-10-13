import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-5 (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §20, and the L4 /
 * F1 entry in docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md).
 *
 * Same static-source approach as cartR12DomContract.test.ts and
 * cartMoneySurfaceFence.test.ts: no Liquid rendering engine is available
 * here, so these assert over the actual `.liquid` source rather than
 * rendered DOM. That proves the markers and copy are present in the
 * template, not that every conditional branch of Liquid renders correctly.
 *
 * Two things are covered:
 *
 * 1. Owner §20's two PDP add-to-cart actions — "Add to Cart" and "Add to
 *    Cart with Bank Payment Discount" — both real add-to-cart actions
 *    inside the same product form, distinguished by `data-carat-add-to-cart`
 *    ("default" / "bank") for the JS layer, and by wording (not colour or
 *    position) for a screen-reader user who lands on the bank action
 *    directly and only hears its own accessible name.
 *
 * 2. F1 — `{{ form | payment_button }}` (dynamic/accelerated checkout on the
 *    product page) suppressed while the EXISTING cart is in Bank mode, since
 *    it bypasses the cart entirely and would silently charge Card price with
 *    no explanation. Mirrors the L4 treatment already tested for the cart
 *    footer's `content_for_additional_checkout_buttons` in
 *    cartR12DomContract.test.ts.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const BUY_BUTTONS_PATH = join(THEME_ROOT, "snippets", "buy-buttons.liquid");

/** Forbidden per CLAUDE.md §12 / owner criterion 37 — checked here because this file gained new customer-facing copy. */
const FORBIDDEN_TERMS = [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

/** Strips {%- comment -%}...{%- endcomment -%} blocks so example attribute text quoted inside a
 *  comment's prose (e.g. this file's own handoff notes) is never mistaken for real markup. */
function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(): string {
  return stripLiquidComments(readFileSync(BUY_BUTTONS_PATH, "utf8"));
}

function countOccurrences(haystack: string, needle: string): number {
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return (haystack.match(pattern) ?? []).length;
}

describe("snippets/buy-buttons.liquid — PDP add-to-cart actions (owner §20) and F1 suppression (L4)", () => {
  it("GUARDS THE GUARD: the file exists and is non-empty", () => {
    expect(read().length).toBeGreaterThan(0);
  });

  describe("two add-to-cart actions", () => {
    const source = read();

    it("marks exactly one default action and one bank-payment action", () => {
      expect(countOccurrences(source, 'data-carat-add-to-cart="default"')).toBe(1);
      expect(countOccurrences(source, 'data-carat-add-to-cart="bank"')).toBe(1);
    });

    it("both actions are add-to-cart submits inside the product form, not checkout buttons", () => {
      // Both share name="add" (Shopify's add-to-cart field) and type="submit" — neither is
      // form|payment_button or a distinct checkout form.
      const defaultButton = source.slice(
        source.indexOf('data-carat-add-to-cart="default"') - 400,
        source.indexOf('data-carat-add-to-cart="default"') + 50
      );
      const bankButton = source.slice(
        source.indexOf('data-carat-add-to-cart="bank"') - 400,
        source.indexOf('data-carat-add-to-cart="bank"') + 50
      );
      expect(defaultButton).toMatch(/type="submit"/);
      expect(defaultButton).toMatch(/name="add"/);
      expect(bankButton).toMatch(/type="submit"/);
      expect(bankButton).toMatch(/name="add"/);
    });

    it("uses owner §20's exact labels via locale keys, not hardcoded strings", () => {
      expect(source).toContain("'products.product.add_to_cart' | t");
      expect(source).toContain("'products.product.add_to_cart_bank_payment' | t");
    });

    it("the bank action's cart-wide consequence is real visible text, not visually-hidden or aria-hidden", () => {
      const noteIndex = source.indexOf("product-form__submit-bank-note");
      expect(noteIndex).toBeGreaterThan(-1);
      const noteBlock = source.slice(noteIndex - 20, noteIndex + 200);
      expect(noteBlock).not.toMatch(/visually-hidden/);
      expect(noteBlock).not.toMatch(/aria-hidden="true"/);
      expect(source).toContain("'products.product.add_to_cart_bank_payment_note' | t");
    });

    it("the bank action appears after the default action (default remains primary)", () => {
      expect(source.indexOf('data-carat-add-to-cart="default"')).toBeLessThan(
        source.indexOf('data-carat-add-to-cart="bank"')
      );
    });

    it("neither action is disabled unconditionally (both gate on the same availability check)", () => {
      expect(countOccurrences(source, "add_to_cart_unavailable")).toBeGreaterThanOrEqual(3);
    });
  });

  describe("F1 suppression of accelerated/dynamic checkout in Bank mode", () => {
    const source = read();

    // Full contract (always-render, hidden attribute, wrapper carries no reimplementation
    // of payment_button, and parity with F2) is asserted in
    // dynamicCheckoutWrapper.test.ts, parameterised over this file and
    // main-cart-footer.liquid. Kept here: the basics specific to this file's own shape.

    it("still requires show_dynamic_checkout to render at all", () => {
      expect(source).toContain("{%- if show_dynamic_checkout -%}");
    });

    it("form | payment_button is inside the wrapper, not outside it", () => {
      const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
      const paymentButtonIndex = source.indexOf("form | payment_button");
      const closingDivIndex = source.indexOf("</div>", paymentButtonIndex);
      expect(wrapperIndex).toBeGreaterThan(-1);
      expect(wrapperIndex).toBeLessThan(paymentButtonIndex);
      expect(paymentButtonIndex).toBeLessThan(closingDivIndex);
    });
  });

  it("introduces no forbidden pricing terminology", () => {
    const source = read();
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });

  it("does not read a raw Shopify cart/line money object directly (L1 — covered globally by cartMoneySurfaceFence, re-asserted here since this file is new to money-adjacent logic)", () => {
    const source = read();
    expect(source).not.toMatch(/\bcart\.total_price\b/);
    expect(source).not.toMatch(/\bcart\.items_subtotal_price\b/);
    expect(source).not.toMatch(/\bitem\.final_line_price\b/);
  });
});
