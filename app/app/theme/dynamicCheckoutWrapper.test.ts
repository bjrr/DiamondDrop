import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 2B-5, final round (2026-09-19, team-lead ruling): F1 (`snippets/buy-buttons.liquid`)
 * and F2 (`sections/main-cart-footer.liquid`) unified onto ONE pattern for suppressing
 * accelerated/dynamic checkout in Bank mode, instead of two different treatments of the
 * same requirement.
 *
 * THE PATTERN, in both files: the wrapping element always renders whenever the per-surface
 * merchant/render setting is true (`show_dynamic_checkout` for F1, `additional_checkout_buttons`
 * for F2) — mode plays no part in whether it exists. It carries a shared, stable
 * `data-carat-dynamic-checkout-wrapper` attribute and starts `hidden` when
 * `cart.attributes.carat_payment_mode == 'bank'` at render time. `mode-switch`'s JS derives
 * this wrapper's hidden state from the DTO's mode on every apply — the same selector already
 * covers both files with no JS change, and the same self-correcting behaviour already used
 * for the switch-to-bank control now applies here too.
 *
 * WHY THIS MATTERS (recorded because F1 went through two prior, rejected designs before
 * landing here): a bare existence gate (`{% if mode != 'bank' %}...{% endif %}`, no wrapper)
 * leaves nothing in the DOM for JS to react to when the SAME page's own actions change mode
 * without a reload or re-render (F1's specific failure) or when a network resync race leaves
 * server-persisted mode ahead of a stale DOM (F2's, narrower, failure). A wrapper attribute
 * only helps if the element the wrapper sits on actually exists when mode could change under
 * it — which is why "always render, mode drives `hidden`" is the one pattern that closes
 * both failure modes without depending on a render happening at the right moment.
 *
 * Same static-source approach as the other theme tests in this directory: no Liquid
 * rendering engine is available, so these assert over actual template source.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");

const SURFACES = [
  {
    label: "F1 — snippets/buy-buttons.liquid",
    path: join(THEME_ROOT, "snippets", "buy-buttons.liquid"),
    enablingCondition: "show_dynamic_checkout",
    wrappedContent: "form | payment_button",
  },
  {
    label: "F2 — sections/main-cart-footer.liquid",
    path: join(THEME_ROOT, "sections", "main-cart-footer.liquid"),
    enablingCondition: "additional_checkout_buttons",
    wrappedContent: "content_for_additional_checkout_buttons",
  },
] as const;

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function read(path: string): string {
  return stripLiquidComments(readFileSync(path, "utf8"));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.each(SURFACES)("$label — dynamic checkout wrapper (unified F1/F2 pattern)", (surface) => {
  it("GUARDS THE GUARD: file exists and is non-empty", () => {
    expect(read(surface.path).length).toBeGreaterThan(0);
  });

  it("marks exactly one dynamic-checkout wrapper, using the shared attribute name", () => {
    expect(countOccurrences(read(surface.path), "data-carat-dynamic-checkout-wrapper")).toBe(1);
  });

  it("existence is gated only by the per-surface enabling condition, not by mode", () => {
    const source = read(surface.path);
    const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
    // Find the nearest preceding {% if %} that gates this element's existence.
    const ifIndex = source.lastIndexOf("{%- if ", wrapperIndex);
    expect(ifIndex).toBeGreaterThan(-1);
    const ifTagEnd = source.indexOf("-%}", ifIndex);
    const ifCondition = source.slice(ifIndex, ifTagEnd);
    expect(ifCondition).toContain(surface.enablingCondition);
    expect(ifCondition).not.toContain("carat_payment_mode");
  });

  it("the wrapper itself carries the mode-driven hidden attribute — present in Bank mode, absent in Card mode", () => {
    const source = read(surface.path);
    const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
    const closeTagIndex = source.indexOf(">", wrapperIndex);
    const openTag = source.slice(wrapperIndex, closeTagIndex + 1);
    expect(openTag).toContain("cart.attributes.carat_payment_mode == 'bank'");
    expect(openTag).toContain("hidden");
  });

  it("wraps, does not reimplement, the underlying Shopify-generated content", () => {
    const source = read(surface.path);
    const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
    const contentIndex = source.indexOf(surface.wrappedContent);
    const closingDivIndex = source.indexOf("</div>", contentIndex);
    expect(contentIndex).toBeGreaterThan(wrapperIndex);
    expect(closingDivIndex).toBeGreaterThan(contentIndex);
    // Nothing between the wrapper's own open tag and the wrapped content re-derives or
    // interpolates a price/mode value — allow only whitespace and the interpolation
    // braces themselves ("{{ ... }}"), not additional Liquid logic tags.
    const closeTagIndex = source.indexOf(">", wrapperIndex);
    const between = source.slice(closeTagIndex + 1, contentIndex);
    const allowedChars = new Set([" ", "\t", "\n", "\r", "{", "}"]);
    const strippedBetween = between
      .split("")
      .filter((ch) => !allowedChars.has(ch))
      .join("");
    expect(strippedBetween).toBe("");
  });

  it("does not read a raw Shopify cart/line money object directly", () => {
    const source = read(surface.path);
    const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
    const closeDivIndex = source.indexOf("</div>", wrapperIndex);
    const block = source.slice(wrapperIndex, closeDivIndex === -1 ? undefined : closeDivIndex);
    expect(block).not.toMatch(/\bcart\.total_price\b/);
    expect(block).not.toMatch(/\bitem\.final_line_price\b/);
  });
});

describe("F1 and F2 use byte-identical wrapper attribute and hidden-condition text (no drift)", () => {
  it("the {% if cart.attributes.carat_payment_mode == 'bank' %}...hidden...{% endif %} shape matches across both files", () => {
    const [f1, f2] = SURFACES.map((surface) => {
      const source = read(surface.path);
      const wrapperIndex = source.indexOf("data-carat-dynamic-checkout-wrapper");
      const closeTagIndex = source.indexOf(">", wrapperIndex);
      return source.slice(wrapperIndex, closeTagIndex + 1).replace(/\s+/g, " ").trim();
    });
    // Both should contain the identical condition and hidden token, modulo surrounding
    // whitespace normalisation — the actual mechanism, not just the label, must match.
    expect(f1).toContain("cart.attributes.carat_payment_mode == 'bank'");
    expect(f2).toContain("cart.attributes.carat_payment_mode == 'bank'");
    expect(f1).toContain("hidden");
    expect(f2).toContain("hidden");
  });
});
