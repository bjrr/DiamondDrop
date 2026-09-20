import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-3 — the R12 DOM contract, tested at the Liquid-source level
 * (docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md, "R12" and its "DOM
 * contract" subsection), AMENDED after 2B-3's own review round to add the
 * owner §3 simultaneous card/bank/saving nodes.
 *
 * Same approach as cartMoneySurfaceFence.test.ts and
 * quickOrderListUnreachableFence.test.ts: no Liquid rendering engine is
 * available in this test runner, so these are static-source assertions over
 * the actual `.liquid` files rather than rendered-DOM assertions. That is a
 * real limitation — a regex match proves the marker text is present in the
 * template source, not that Liquid emits it correctly for every branch — but
 * it is the same limitation the L1 fence itself already accepts, and it is
 * strictly more coverage than the previous state (raw Shopify money objects
 * with no test at all).
 *
 * WHY EVERY MONEY NODE IS "ALWAYS PENDING", IN BOTH MODES. R12's original
 * text said Card mode needs no pending state because the server-rendered
 * value is already correct, while simultaneously fencing off every Shopify
 * cart money object from display. Those two cannot both hold — if Liquid may
 * not read a Shopify line-item price object, it cannot server-render the
 * Card figure either. The team lead accepted this as a correction to R12,
 * not an exception to it (see the 2B-3 handoff thread). So every
 * `data-carat-money` node in these five files starts
 * `data-carat-mode-pending` regardless of `cart.attributes.carat_payment_mode`,
 * applied by JS from the `/apps/carat/cart` proxy in both modes.
 *
 * THE AMENDED ENUM. `data-carat-money` now takes one of TEN values, not
 * four: the original `line-unit` / `line-total` / `cart-subtotal` /
 * `cart-total` (the currently-ACTIVE-mode figure, mode-toggled) plus owner
 * §3's simultaneous, non-toggled breakdown — `line-card` / `line-bank` /
 * `line-saving` per line, `cart-card-total` / `cart-bank-total` /
 * `cart-saving` at cart level. See `VALID_CARAT_MONEY_VALUES` below for the
 * authoritative list.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");

const FILES = {
  cartItems: join(THEME_ROOT, "sections", "main-cart-items.liquid"),
  cartFooter: join(THEME_ROOT, "sections", "main-cart-footer.liquid"),
  liveRegion: join(THEME_ROOT, "sections", "cart-live-region-text.liquid"),
  cartDrawer: join(THEME_ROOT, "snippets", "cart-drawer.liquid"),
  cartNotification: join(THEME_ROOT, "snippets", "cart-notification.liquid"),
} as const;

const VALID_CARAT_MONEY_VALUES = [
  "line-unit",
  "line-total",
  "cart-subtotal",
  "cart-total",
  "line-card",
  "line-bank",
  "line-saving",
  "cart-card-total",
  "cart-bank-total",
  "cart-saving",
] as const;

/** Owner §3's per-line simultaneous breakdown, as a set for counting convenience. */
const LINE_BREAKDOWN_VALUES = ["line-card", "line-bank", "line-saving"] as const;
/** Owner §3's cart-level simultaneous breakdown. */
const CART_BREAKDOWN_VALUES = ["cart-card-total", "cart-bank-total", "cart-saving"] as const;

/** Terminology forbidden anywhere in the theme per CLAUDE.md §12 / owner criterion 37. */
const FORBIDDEN_TERMS = [/cash discount/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Counts non-overlapping occurrences of a literal `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return (haystack.match(pattern) ?? []).length;
}

/** Every `data-carat-money="..."` value found in a source string, in order. */
function caratMoneyValues(source: string): string[] {
  return [...source.matchAll(/data-carat-money="([^"]+)"/g)].map((m) => m[1]!);
}

describe("R12 DOM contract — cart money nodes", () => {
  it("GUARDS THE GUARD: all five owned files exist and are non-empty", () => {
    for (const path of Object.values(FILES)) {
      const source = read(path);
      expect(source.length, `${path} was empty or unreadable`).toBeGreaterThan(0);
    }
  });

  it("GUARDS THE GUARD: no theme file uses a data-carat-money value outside the amended enum", () => {
    for (const path of Object.values(FILES)) {
      const values = caratMoneyValues(read(path));
      for (const value of values) {
        expect(VALID_CARAT_MONEY_VALUES as readonly string[]).toContain(value);
      }
    }
  });

  describe("sections/main-cart-items.liquid (A1)", () => {
    const source = read(FILES.cartItems);

    it("marks exactly one per-line unit price node (the active-mode figure)", () => {
      expect(countOccurrences(source, 'data-carat-money="line-unit"')).toBe(1);
    });

    it("marks exactly two per-line total nodes (medium-hide/large-up-hide column + small-hide column)", () => {
      expect(countOccurrences(source, 'data-carat-money="line-total"')).toBe(2);
    });

    it("marks exactly one of each owner §3 per-line breakdown node (card, bank, saving) — not duplicated across the responsive columns", () => {
      for (const value of LINE_BREAKDOWN_VALUES) {
        expect(countOccurrences(source, `data-carat-money="${value}"`)).toBe(1);
      }
    });

    it("every per-line node carries a line-id and a variant-id bound to the Shopify loop variables", () => {
      // 1 line-unit + 2 line-total + 3 breakdown nodes = 6 per-line money nodes.
      expect(countOccurrences(source, "data-carat-line-id=\"{{ item.key }}\"")).toBe(6);
      expect(countOccurrences(source, "data-carat-variant-id=\"{{ item.variant.id }}\"")).toBe(6);
    });

    it("every cart money node in this file starts data-carat-mode-pending, unconditionally", () => {
      expect(countOccurrences(source, "data-carat-mode-pending")).toBe(6);
    });

    it("the pending fallback is announced as a status, never as a price", () => {
      expect(source).toContain("sections.cart.pricing.calculating");
    });

    it("labels the breakdown with owner §3's exact terms", () => {
      expect(source).toContain("sections.cart.pricing.regular_card_price");
      expect(source).toContain("sections.cart.pricing.bank_payment_price");
      expect(source).toContain("sections.cart.pricing.bank_payment_saving");
    });

    it("the owner §3 breakdown block is not gated behind an eligibility conditional (§18: a $0 saving must render, not be hidden)", () => {
      const start = source.indexOf('<dl class="cart-item__bank-card-pricing">');
      const end = source.indexOf("</dl>", start);
      expect(start, "the owner §3 breakdown <dl> was not found").toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = source.slice(start, end);
      expect(block).not.toMatch(/{%-?\s*if\b/);
    });
  });

  describe("sections/main-cart-footer.liquid (A2)", () => {
    const source = read(FILES.cartFooter);

    it("marks exactly one cart-total node, pending", () => {
      expect(countOccurrences(source, 'data-carat-money="cart-total"')).toBe(1);
    });

    it("marks exactly one of each owner §3 cart-level breakdown node (card total, bank total, saving)", () => {
      for (const value of CART_BREAKDOWN_VALUES) {
        expect(countOccurrences(source, `data-carat-money="${value}"`)).toBe(1);
      }
    });

    it("every cart money node in this file starts pending (cart-total + 3 breakdown nodes = 4)", () => {
      expect(countOccurrences(source, "data-carat-mode-pending")).toBe(4);
    });

    it("cart-level nodes carry no line-id/variant-id (they are not per-line)", () => {
      expect(source).not.toContain("data-carat-line-id");
      expect(source).not.toContain("data-carat-variant-id");
    });

    it("offers both Card Checkout and Bank Payment Checkout (owner §20)", () => {
      expect(source).toContain("sections.cart.card_checkout");
      expect(source).toContain("sections.cart.bank_payment_checkout");
    });

    it("the Card Checkout button is still Shopify's own native checkout submit, unmodified", () => {
      expect(source).toMatch(/id="checkout"[\s\S]*?name="checkout"[\s\S]*?form="cart"/);
      expect(source).toMatch(/type="submit"[\s\S]{0,200}id="checkout"/);
    });

    it("the Bank Payment Checkout button is a clearly-marked stub, not a submit control", () => {
      expect(source).toMatch(/type="button"[\s\S]{0,200}data-carat-checkout-stub="bank-payment"/);
    });

    it("suppresses accelerated/dynamic checkout in Bank mode and allows it in Card mode (L4)", () => {
      // 2026-09-19 (unified with F1): previously an existence gate
      // (`cart.attributes.carat_payment_mode != 'bank'` deciding whether the element
      // rendered at all); now always renders when `additional_checkout_buttons` is true,
      // wrapped in a stable `data-carat-dynamic-checkout-wrapper` with `hidden` driven by
      // mode — see cartDynamicCheckoutWrapper.test.ts for the full contract, parameterised
      // over both this file and buy-buttons.liquid's F1 treatment.
      expect(source).toContain("data-carat-dynamic-checkout-wrapper");
      expect(source).toContain("cart.attributes.carat_payment_mode == 'bank'");
      // The suppression must wrap the actual accelerated-checkout output, not just exist nearby.
      const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
      const contentForIndex = source.indexOf("content_for_additional_checkout_buttons");
      expect(wrapperIndex).toBeGreaterThan(-1);
      expect(contentForIndex).toBeGreaterThan(wrapperIndex);
    });
  });

  describe("sections/cart-live-region-text.liquid (A4)", () => {
    const source = read(FILES.liveRegion);

    it("marks exactly one cart-total node, pending, carrying a localized label for the applying JS to compose", () => {
      expect(countOccurrences(source, 'data-carat-money="cart-total"')).toBe(1);
      expect(countOccurrences(source, "data-carat-mode-pending")).toBe(1);
      expect(source).toContain("data-carat-live-region-label=");
      expect(source).toContain("sections.cart.new_estimated_total");
    });

    it("never renders a bare total figure at server-render time (no money filter applied to a cart total)", () => {
      expect(source).not.toMatch(/money_with_currency/);
      expect(source).not.toMatch(/\|\s*money\b/);
    });

    it("does not carry the owner §3 breakdown (out of scope for the accessibility announcement)", () => {
      for (const value of [...LINE_BREAKDOWN_VALUES, ...CART_BREAKDOWN_VALUES]) {
        expect(source).not.toContain(`data-carat-money="${value}"`);
      }
    });
  });

  describe("snippets/cart-drawer.liquid (A3)", () => {
    const source = read(FILES.cartDrawer);

    it("marks exactly one per-line unit price node and one per-line total node (single-column drawer layout)", () => {
      expect(countOccurrences(source, 'data-carat-money="line-unit"')).toBe(1);
      expect(countOccurrences(source, 'data-carat-money="line-total"')).toBe(1);
    });

    it("marks exactly one of each owner §3 per-line breakdown node", () => {
      for (const value of LINE_BREAKDOWN_VALUES) {
        expect(countOccurrences(source, `data-carat-money="${value}"`)).toBe(1);
      }
    });

    it("marks exactly one cart-total node and one of each owner §3 cart-level breakdown node", () => {
      expect(countOccurrences(source, 'data-carat-money="cart-total"')).toBe(1);
      for (const value of CART_BREAKDOWN_VALUES) {
        expect(countOccurrences(source, `data-carat-money="${value}"`)).toBe(1);
      }
    });

    it("every money node in the drawer starts pending (5 per-line + 4 cart-level = 9)", () => {
      expect(countOccurrences(source, "data-carat-mode-pending")).toBe(9);
    });

    it("per-line nodes carry line-id and variant-id bound to the Shopify loop variables (5 per-line nodes)", () => {
      expect(countOccurrences(source, "data-carat-line-id=\"{{ item.key }}\"")).toBe(5);
      expect(countOccurrences(source, "data-carat-variant-id=\"{{ item.variant.id }}\"")).toBe(5);
    });

    it("offers both Card Checkout and Bank Payment Checkout, matching the cart footer's treatment", () => {
      expect(source).toContain("sections.cart.card_checkout");
      expect(source).toContain("sections.cart.bank_payment_checkout");
      expect(source).toMatch(/type="button"[\s\S]{0,200}data-carat-checkout-stub="bank-payment"/);
    });

    it("the owner §3 per-line breakdown block is not gated behind an eligibility conditional", () => {
      const start = source.indexOf('<dl class="cart-item__bank-card-pricing">');
      const end = source.indexOf("</dl>", start);
      expect(start, "the owner §3 breakdown <dl> was not found").toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(source.slice(start, end)).not.toMatch(/{%-?\s*if\b/);
    });
  });

  describe("snippets/cart-notification.liquid (C1)", () => {
    const source = read(FILES.cartNotification);

    it("renders no cart money node at all (inventory C1: no price in this popup)", () => {
      expect(source).not.toContain("data-carat-money");
    });

    it("still routes its checkout CTA by cart mode, per owner §20", () => {
      expect(source).toContain("sections.cart.card_checkout");
      expect(source).toContain("sections.cart.bank_payment_checkout");
      expect(source).toMatch(/type="button"[\s\S]{0,200}data-carat-checkout-stub="bank-payment"/);
    });
  });

  it("no owned file uses forbidden Bank/Card terminology (CLAUDE.md §12 / owner criterion 37)", () => {
    for (const [name, path] of Object.entries(FILES)) {
      const source = read(path);
      for (const term of FORBIDDEN_TERMS) {
        expect(source, `${name} (${path}) contains forbidden terminology matching ${term}`).not.toMatch(term);
      }
    }
  });
});

describe("guard the guard — the helpers actually detect what they exist to catch", () => {
  it("counts non-overlapping literal substring matches", () => {
    expect(countOccurrences("a-b-a-b-a", "a")).toBe(3);
    expect(
      countOccurrences('data-carat-money="line-unit" data-carat-money="line-unit"', 'data-carat-money="line-unit"')
    ).toBe(2);
  });

  it("does not conflate line-unit and line-total counts", () => {
    const sample = 'data-carat-money="line-unit"data-carat-money="line-total"';
    expect(countOccurrences(sample, 'data-carat-money="line-unit"')).toBe(1);
    expect(countOccurrences(sample, 'data-carat-money="line-total"')).toBe(1);
  });

  it("extracts every data-carat-money value, including the amended owner §3 ones", () => {
    const sample = '<span data-carat-money="line-card"></span><span data-carat-money="cart-saving"></span>';
    expect(caratMoneyValues(sample)).toEqual(["line-card", "cart-saving"]);
  });

  it("flags a forbidden term even mid-sentence, case-insensitively", () => {
    expect("This is a Cash Discount for you").toMatch(FORBIDDEN_TERMS[0]!);
    expect("A CARD FEE applies").toMatch(FORBIDDEN_TERMS[1]!);
  });

  it("does not flag ordinary cart copy that merely mentions Bank Payment", () => {
    for (const term of FORBIDDEN_TERMS) {
      expect("Bank Payment Checkout is arranged directly with our team").not.toMatch(term);
    }
  });
});
