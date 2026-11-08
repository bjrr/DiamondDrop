import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ONE ACTIVE PRICE AT A TIME. NEVER TWO.
 *
 * ===========================================================================
 * THE REGRESSION THIS EXISTS FOR
 * ===========================================================================
 * The detail page shipped (844fe62) rendering the alternate payment method's
 * price as a footnote under the active one: "Bank Payment Price $x" while
 * Card was selected, and the reverse. It reads as a helpful comparison and
 * is exactly what the Group Buy rule forbids — two prices for the same ring
 * competing for attention, with no single figure the shopper can point at.
 *
 * The owner caught it in review. This file is what would have caught it.
 *
 * ===========================================================================
 * BEHAVIOURAL, NOT JUST LEXICAL
 * ===========================================================================
 * The first group below extracts the REAL `activePriceMinorUnits` from the
 * shipped asset and runs it, in the same spirit as
 * `beatQuoteMoneyConversion.test.ts`: the point is to exercise the code the
 * browser runs, not a copy of it. The function returns ONE figure by
 * construction, so "show both" is not something a caller can express — and
 * these cases pin that it returns the right one.
 *
 * The second group is lexical, and catches the other way the bug could come
 * back: a renderer that bypasses the helper and reaches for both fields
 * itself.
 */

const THEME = join(process.cwd(), "..", "theme");
const SCRIPT = readFileSync(join(THEME, "assets", "group-buy-detail.js"), "utf8");
const CSS = readFileSync(join(THEME, "assets", "component-group-buy.css"), "utf8");

/** The exact function the browser runs, lifted from the shipped file. */
function loadActivePrice(): (
  price: { groupBuyRegularCardPriceMinorUnits?: string; groupBuyBankPaymentPriceMinorUnits?: string } | null,
  paymentType: string | null
) => string | null {
  const match = SCRIPT.match(/function activePriceMinorUnits\(price, paymentType\) \{[\s\S]*?\n {2}\}/);
  if (!match) throw new Error("activePriceMinorUnits not found in group-buy-detail.js");
  // `new Function` is deliberate, and the same choice made in
  // beatQuoteMoneyConversion.test.ts: this test is worthless if it runs a
  // reimplementation instead of the shipped source.
  return new Function(`${match[0]}; return activePriceMinorUnits;`)() as ReturnType<typeof loadActivePrice>;
}

const activePrice = loadActivePrice();

const PRICE = {
  groupBuyRegularCardPriceMinorUnits: "189500",
  groupBuyBankPaymentPriceMinorUnits: "180500",
};

describe("the active price is one figure, chosen by payment method", () => {
  it("returns the Regular/Card price when Card is selected", () => {
    expect(activePrice(PRICE, "card")).toBe("189500");
  });

  it("returns the Bank Payment price when Bank is selected", () => {
    expect(activePrice(PRICE, "bank")).toBe("180500");
  });

  it("returns the Regular/Card price before any method is chosen", () => {
    // The publicly advertised Group Buy figure (CLAUDE.md rule 13). The Bank
    // price must not appear until the customer has actually chosen Bank.
    expect(activePrice(PRICE, null)).toBe("189500");
    expect(activePrice(PRICE, "")).toBe("189500");
  });

  it("NEVER returns both — the return type cannot express two prices", () => {
    for (const method of ["card", "bank", null, "", "something-else"]) {
      const result = activePrice(PRICE, method);
      expect(typeof result).toBe("string");
      // One of the two, never a pair, never a concatenation of both.
      expect([PRICE.groupBuyRegularCardPriceMinorUnits, PRICE.groupBuyBankPaymentPriceMinorUnits]).toContain(
        result
      );
      expect(result).not.toContain(" ");
    }
  });

  it("switching Card -> Bank -> Card restores the Card price exactly", () => {
    expect(activePrice(PRICE, "card")).toBe("189500");
    expect(activePrice(PRICE, "bank")).toBe("180500");
    expect(activePrice(PRICE, "card")).toBe("189500");
  });

  it("has nothing to show when there is no price yet", () => {
    expect(activePrice(null, "card")).toBeNull();
  });

  it("treats an unknown payment type as not-Bank rather than showing Bank", () => {
    // Fail towards the advertised card price; never reveal the bank figure
    // on the strength of a value nobody set.
    expect(activePrice(PRICE, "nonsense")).toBe("189500");
  });
});

describe("no renderer shows both prices", () => {
  /** Script with comments and string literals blanked out. */
  function codeOnly(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
      const two = source.slice(i, i + 2);
      if (two === "/*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      if (two === "//") {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
        continue;
      }
      const ch = source[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === ch) {
            i += 1;
            break;
          }
          i += 1;
        }
        out += '""';
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  const CODE = codeOnly(SCRIPT);

  /**
   * Comments removed, STRING LITERALS KEPT.
   *
   * Two different questions need two different views of the source. "Does
   * any code read both price fields" must ignore strings and comments, or
   * this file's own prose answers it. "Is the alternate-price LABEL still
   * rendered" is a question about a string literal, so blanking strings
   * would make it unanswerable — while leaving comments in would let the
   * paragraph above, which quotes the removed label to explain it, fail the
   * test it is documenting.
   */
  function withoutComments(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
      const two = source.slice(i, i + 2);
      if (two === "/*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      if (two === "//") {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
        continue;
      }
      const ch = source[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        out += ch;
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") {
            out += source.slice(i, i + 2);
            i += 2;
            continue;
          }
          out += source[i];
          if (source[i] === ch) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  const LIVE = withoutComments(SCRIPT);

  it("the comment-only stripper keeps strings and drops prose", () => {
    expect(withoutComments('var a = "keep me"; // drop me')).toContain('"keep me"');
    expect(withoutComments('var a = "keep me"; // drop me')).not.toContain("drop me");
    expect(withoutComments("/* Bank Payment Price */ var a = 1;")).not.toContain("Bank Payment Price");
  });

  it("reads the two price fields in exactly one place — the helper", () => {
    // THE CORE ASSERTION. Each field may be named once, inside
    // `activePriceMinorUnits`. A renderer reaching for either one directly
    // is how a second price gets onto the page, and it fails here.
    const card = CODE.match(/groupBuyRegularCardPriceMinorUnits/g) ?? [];
    const bank = CODE.match(/groupBuyBankPaymentPriceMinorUnits/g) ?? [];
    expect(card).toHaveLength(1);
    expect(bank).toHaveLength(1);

    const helper = CODE.slice(
      CODE.indexOf("function activePriceMinorUnits"),
      CODE.indexOf("function formatRemaining")
    );
    expect(helper).toContain("groupBuyRegularCardPriceMinorUnits");
    expect(helper).toContain("groupBuyBankPaymentPriceMinorUnits");
  });

  it("carries no alternate-price label anywhere", () => {
    // LIVE, not SCRIPT: the comment above deliberately quotes the removed
    // label to explain the regression, and must not fail the test it
    // documents. What matters is that no LIVE string renders it.
    expect(LIVE).not.toContain("Bank Payment Price ");
    expect(LIVE).not.toContain("Regular/Card Price ");
    expect(LIVE).not.toContain("gb-price__alt");
  });

  it("has no styling left for an alternate price line", () => {
    // Dead CSS is an invitation to put the element back.
    expect(CSS).not.toContain("gb-price__alt");
  });

  it("renders exactly one amount node in the price block", () => {
    const renderPrice = LIVE.slice(LIVE.indexOf("function renderPrice("), LIVE.indexOf("function renderProgress("));
    const amounts = renderPrice.match(/gb-price__amount/g) ?? [];
    expect(amounts).toHaveLength(1);
  });

  it("drives both the main block and the sticky bar through the one helper", () => {
    const calls = CODE.match(/activePriceMinorUnits\(/g) ?? [];
    // One declaration plus two call sites.
    expect(calls.length).toBe(3);
    const sticky = CODE.slice(CODE.indexOf("function renderSticky()"), CODE.indexOf("function handleCta("));
    expect(sticky).toContain("activePriceMinorUnits(");
  });

  it("still never preselects a payment method", () => {
    // The fix must not have quietly defaulted one to make the price simpler.
    expect(CODE).toMatch(/paymentType:\s*null/);
    const payment = CODE.slice(CODE.indexOf("function renderPayment("));
    expect(payment).toMatch(/state\.paymentType === option\.id \? "" : ""/);
  });
});

describe("the shopping hub and the policy page stay distinct (§6)", () => {
  const SECTION = readFileSync(join(THEME, "sections", "group-buy-detail.liquid"), "utf8");

  it("the detail page can still reach the Group Buy policy", () => {
    // The anchor, specifically — not the explanatory comment above it, and
    // not the hub URL, which is the plural handle.
    expect(SECTION).toMatch(/<a href="\{\{ routes\.root_url \}\}pages\/group-buy">/);
    expect(SECTION).toContain("group_buy_detail.policy_link");
  });

  it("labels it as the policy, not as somewhere to shop", () => {
    const locale = JSON.parse(
      readFileSync(join(THEME, "locales", "en.default.json"), "utf8")
    ) as { templates: { group_buy_detail: Record<string, string> } };
    const label = locale.templates.group_buy_detail.policy_link;
    // A throw rather than an expect: this narrows the type for the
    // assertions below, and a missing key is a setup failure rather than a
    // behavioural one.
    if (!label) throw new Error("templates.group_buy_detail.policy_link is missing");
    expect(label.toLowerCase()).toContain("policy");
    // A label a shopper could mistake for the browse destination would be a
    // worse bug than a wrong URL, because nothing would look broken.
    expect(label.toLowerCase()).not.toMatch(/browse|shop|view group buys|see group buys/);
  });

  it("does not modify the pinned acknowledgment copy to carry the link", () => {
    // The disclosure and affirm strings are owner-approved and pinned; the
    // policy route is a sibling line, not an edit to them.
    expect(SECTION).toContain("cancellation_disclosure");
    expect(SECTION).toContain("cancellation_affirm_label");
    expect(SECTION).toContain("cancellation_checkbox_label");
  });

  it("sends browse intent to the hub and policy intent to the policy page", () => {
    const grid = readFileSync(
      join(THEME, "sections", "main-collection-product-grid.liquid"),
      "utf8"
    );
    // The collection empty state is a browse prompt.
    expect(grid).toContain("pages/group-buys");
    expect(grid).not.toMatch(/pages\/group-buy"/);

    const home = readFileSync(join(THEME, "templates", "index.json"), "utf8");
    // The top-level destination card browses; the "How Group Buy works"
    // CTAs explain, and still point at the policy page.
    expect(home).toContain('"link": "/pages/group-buys"');
    expect(home).toContain('"cta_link": "/pages/group-buy"');
    expect(home).toContain('"cta2_link": "/pages/group-buy"');
  });
});
