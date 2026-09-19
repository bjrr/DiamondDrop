import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source guards for the storefront block.
 *
 * Liquid and browser JS cannot be exercised by this suite — there is no theme
 * and no DOM here. What CAN be checked is that the block does not reintroduce
 * the two things the README forbids, and does not do money arithmetic the
 * server already did correctly.
 *
 * These are the same class of assertion as the webhook boundary tests: about
 * what the code IS, because that is the only level at which the mistake is
 * visible before a shopper sees it.
 */

const DIR = join(process.cwd(), "extensions", "group-buy-progress");
const liquid = readFileSync(join(DIR, "blocks", "group-buy-progress.liquid"), "utf8");
const js = readFileSync(join(DIR, "assets", "group-buy-progress.js"), "utf8");
const css = readFileSync(join(DIR, "assets", "group-buy-progress.css"), "utf8");

/** Strips comments so prose ABOUT a rule cannot be mistaken for breaking it. */
function stripComments(source: string): string {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the block finds the files it is checking", () => {
  it("has a manifest, a block, and its assets", () => {
    // Guards the guard: a renamed file would make every assertion below vacuous.
    expect(readFileSync(join(DIR, "shopify.extension.toml"), "utf8")).toMatch(/type = "theme"/);
    expect(liquid.length).toBeGreaterThan(500);
    expect(js.length).toBeGreaterThan(500);
    expect(css.length).toBeGreaterThan(500);
  });
});

describe("no crowdfunding framing", () => {
  const code = stripComments(liquid) + stripComments(js) + stripComments(css);

  it("produces no funded/goal/target language or markup", () => {
    // README: "Do not use crowdfunding-funded percentages or imply a minimum is
    // required." A percentage-of-goal reads as money raised towards a target
    // that must be met, and a Group Buy has no target.
    for (const forbidden of ["funded", "percent-funded", "goal", "backers", "pledge", "raised"]) {
      expect(code.toLowerCase(), `must not mention "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("uses discrete tier markers rather than a filled progress bar", () => {
    // A filled bar IS the crowdfunding framing, whatever it is called. Markers
    // each carrying their own price read as "the price drops here", which is
    // an opportunity rather than a shortfall.
    expect(js).toMatch(/tierMarkers/);
    expect(stripComments(css)).not.toMatch(/progress-bar|__bar|width:\s*\d+%/);
  });

  it("implies no minimum", () => {
    const lower = code.toLowerCase();
    for (const forbidden of ["minimum", "required to unlock", "not yet reached", "needed to start"]) {
      expect(lower, `must not imply a minimum via "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe("prices come from the server, never from arithmetic here", () => {
  it("does NOT divide minor units by 100 in floating point", () => {
    // The one way a client could reintroduce a rounding error into a price the
    // server got exactly right.
    const code = stripComments(js);
    expect(code).not.toMatch(/\/\s*100\b/);
    expect(code).not.toMatch(/parseFloat|Number\s*\([^)]*minorUnits/i);
  });

  it("computes no tier, threshold or saving of its own", () => {
    // A second place a customer-facing price is decided is a second place it
    // can be wrong. Every figure is read from the response.
    const code = stripComments(js);
    expect(code).not.toMatch(/priceMultiplier/);
    expect(code).toMatch(/data\.groupBuyRegularCardPriceMinorUnits/);
    expect(code).toMatch(/data\.groupSavingsCardBasisMinorUnits/);
  });

  it("derives no card price, tier or uplift of its own", () => {
    // The tier table and its rates are internal. If any of it appeared here the
    // block could compute a card price from a bank one — a second derivation of
    // a customer-facing price, and the one place a rounding rule could silently
    // differ from the server's $5 ceiling.
    const code = stripComments(js);
    expect(code).not.toMatch(/uplift/i);
    expect(code).not.toMatch(/1\.0[345]|0\.0[345]/);
    // The $5 increment must not be reimplemented client-side either.
    expect(code).not.toMatch(/\b500\b|\bceil/i);
  });
});

describe("Group Buy price display and Payment Type selection (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §9, §10)", () => {
  const code = stripComments(js);

  it("shows exactly one active price slot, not the two prices side by side", () => {
    // §9: "Do not show the Bank Payment Price side-by-side as the default
    // presentation... Only one active Group Buy price should be presented at a
    // time in the ordering flow." There is exactly one function that writes the
    // active price, and it clears its container before writing — asserted
    // structurally rather than left to whoever next edits the template.
    expect(code).toMatch(/function renderActivePrice/);
    expect(code.match(/function renderActivePrice/g)).toHaveLength(1);
  });

  it("defaults the active price to the REGULAR/CARD price, not Bank Payment", () => {
    // §9: "The default/public Group Buy price shown is the Regular/Card
    // Price." Asserted on the actual call that renders the initial state.
    expect(code).toMatch(/renderActivePrice\(activePrice,\s*data,\s*moneyFormat,\s*"card"\)/);
  });

  it("uses the words the owner specified, verbatim", () => {
    expect(code).toMatch(/Group Buy Price/);
    expect(code).toMatch(/Lower pricing is available with Bank Payment/);
    expect(code).toMatch(/Credit \/ Debit Card/);
    expect(code).toMatch(/Bank Payment/);
  });

  it("uses NO superseded or forbidden payment wording", () => {
    // Checked on the rendered strings AND the comments, because a stale
    // comment is how forbidden wording creeps back into the next edit.
    const everything = (js + css + liquid).toLowerCase();
    for (const forbidden of [
      "cash price",
      "cash-equivalent",
      "cash discount",
      "credit card fee",
      "card fee",
      "surcharge",
      "cash",
    ]) {
      expect(everything, `must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("uses NO paper payment methods anywhere in eligible-method copy", () => {
    // Owner §4: no personal/cashier's/certified checks or money orders may
    // ever appear in eligible-method copy. Matched as whole payment-method
    // phrases, not the bare substring "check" — this file legitimately says
    // "checkout" and reads `.checked` on the radio inputs, neither of which is
    // a paper payment method.
    const everything = (js + css + liquid).toLowerCase();
    for (const forbidden of [
      /\bpersonal check/,
      /\bcashier'?s check/,
      /\bcertified check/,
      /\bmoney order/,
      /\bpaper payment/,
      /\bpay(ing)? by check\b/,
      /\bmail(ed)? .{0,10}check\b/,
    ]) {
      expect(everything, `must not match ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("states NO bank/card percentage", () => {
    // Policy §6: the tier rate is internal. The percentage that IS rendered is
    // the Group Buy saving against Buy Now — a different, legitimate figure —
    // so this asserts that the only percentage bound into the DOM is that one.
    const percentFields = code.match(/data\.\w*[Pp]ercent\w*/g) ?? [];
    expect(percentFields.length).toBeGreaterThan(0);
    for (const field of percentFields) {
      expect(field).toBe("data.groupSavingsCardBasisPercent");
    }
  });

  it("renders the OWNER-APPROVED default-state note, character for character", () => {
    // §9's required note, exact — a well-meant rewording is the likeliest way
    // approved copy drifts.
    expect(code).toContain('"Lower pricing is available with Bank Payment."');
  });

  it("renders the OWNER-APPROVED Payment Type labels, character for character", () => {
    expect(code).toContain('"Credit / Debit Card"');
    expect(code).toContain('"Bank Payment"');
  });

  it("renders the OWNER-APPROVED eligible-methods wording, character for character", () => {
    expect(code).toContain(
      '"Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment."'
    );
  });

  it("shows the eligible-methods copy ONLY in the Bank Payment branch, never as default body copy", () => {
    // §9: the default state shows the note, not the methods list. Structural
    // check that the methods string sits inside the `mode === "bank"` branch.
    const bankBranchStart = code.indexOf('mode === "bank"');
    const methods = code.indexOf("Available with Zelle, bank transfer, ACH, or wire");
    const elseBranch = code.indexOf('} else {', bankBranchStart);
    expect(bankBranchStart).toBeGreaterThan(-1);
    expect(methods).toBeGreaterThan(bankBranchStart);
    expect(methods).toBeLessThan(elseBranch);
  });

  it("requires the Payment Type selection with NEITHER option pre-checked", () => {
    // CLAUDE.md: a required choice is never pre-checked or silently inferred.
    // Asserted by absence: no `.checked = true` is ever set on either radio.
    expect(code).not.toMatch(/\.checked\s*=\s*true/);
  });

  it("gives the Payment Type radio group a per-instance name", () => {
    // A radio group's `name` is document-scoped, not subtree-scoped — two
    // Group Buy blocks on one page must not fight over each other's selection.
    expect(code).toMatch(/carat-gb-payment-type-.*instanceId/);
  });

  it("promises no checkout behaviour the platform cannot deliver", () => {
    // Shopify cannot change the payable total at payment-method selection
    // (docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md). The Bank Payment state must
    // still say contact — never "select at checkout", which the platform
    // would not honour, and selecting it must not itself claim to reprice
    // checkout.
    expect(code).toMatch(/Contact us to arrange payment/);
    expect(code).not.toMatch(/select .{0,30}at checkout/i);
    expect(code).not.toMatch(/choose .{0,30}at checkout/i);
    expect(code).not.toMatch(/at checkout/i);
  });

  it("keeps the two savings distinguishable in the copy", () => {
    // The bank-vs-card note and "You save $250 vs buying now" are different
    // concepts (owner §10) and must not blend into one figure or percentage.
    expect(code).toMatch(/Lower pricing is available with Bank Payment/);
    expect(code).toMatch(/vs buying now/);
  });

  it("compares like with like — card savings against the card Buy Now price", () => {
    // Quoting a card group price against a bank Buy Now price would fold the
    // bank/card spread into the advertised Group Buy saving and overstate it.
    expect(code).toMatch(/data\.buyNowRegularCardPriceMinorUnits/);
    expect(code).not.toMatch(/data\.buyNowBankPaymentPriceMinorUnits/);
  });

  it("does NOT claim a price drop when the next tier ties on the card price", () => {
    // Publication permits a TIE on the Regular/Card Price — the owner's rule is
    // "next <= prior", and the $5 ceiling can swallow a small tier difference
    // so a lower Bank Payment Price rounds to the same card price.
    //
    // Permitted is not the same as sayable. Without a guard the block renders
    // "N more and the price drops to $2,080.00" directly beneath a Group Buy
    // Price of $2,080.00: every figure correct, the sentence false.
    const code = stripComments(js);

    // Gated on the SAVING, not merely on a next tier existing — a guard on
    // `nextTierRegularCardPriceMinorUnits !== null` alone is exactly what
    // produced the false sentence.
    const guard = code.indexOf("isPositiveMinorUnits(data.additionalRegularCardSavingsMinorUnits)");
    const claim = code.indexOf("more and the price drops to");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claim);
  });

  it("tests that saving by STRING inspection, never by converting money to a number", () => {
    // The guard must not reintroduce the float path the rest of this file
    // avoids, and must not reach for BigInt either — ES2020, where this file
    // stays ES5 so it runs in whatever a merchant's theme drags along.
    const code = stripComments(js);
    expect(code).toMatch(/function isPositiveMinorUnits/);
    expect(code).not.toMatch(/Number\s*\(\s*data\./);
    expect(code).not.toMatch(/BigInt/);
  });

  it("renders Best Price Unlocked from the server's flag, not by guessing", () => {
    expect(js).toMatch(/data\.bestPriceUnlocked/);
    expect(js).toMatch(/Best Price Unlocked/);
  });
});

describe("failure behaviour", () => {
  it("never falls back to showing the Buy Now price as the group price", () => {
    // Presenting a non-group price where a group price belongs would misquote
    // the customer — worse than showing nothing.
    const unavailable = js.slice(js.indexOf("function showUnavailable"));
    const body = unavailable.slice(0, unavailable.indexOf("function load"));
    expect(body).not.toMatch(/buyNowComparisonPriceMinorUnits/);
    expect(body).toMatch(/not available/i);
  });

  it("says so plainly when JavaScript is unavailable", () => {
    expect(liquid).toMatch(/<noscript>/);
    expect(liquid).toMatch(/group_buy\.unavailable/);
  });

  it("renders nothing at all when no campaign is configured", () => {
    // An empty block is better than one showing a price for no campaign.
    expect(liquid).toMatch(/if campaign_code != blank/);
  });
});

describe("accessibility", () => {
  it("announces updates politely, since the region changes without a page load", () => {
    expect(liquid).toMatch(/aria-live="polite"/);
    expect(liquid).toMatch(/aria-busy/);
  });

  it("marks the current tier by more than colour", () => {
    // A shopper who cannot distinguish the colours must still be able to tell
    // which price applies to them.
    expect(js).toMatch(/carat-gb__tier-state/);
    expect(stripComments(css)).toMatch(/is-current[\s\S]{0,200}font-weight/);
  });

  it("hides the decorative strikethrough from screen readers", () => {
    // The saving is stated in words; the struck price would otherwise be read
    // aloud as a second, confusing price.
    expect(js).toMatch(/aria-hidden/);
  });

  it("builds DOM with textContent rather than innerHTML", () => {
    expect(stripComments(js)).not.toMatch(/innerHTML/);
  });
});

describe("it does not impose itself on the merchant's theme", () => {
  it("inherits typography and colour instead of setting its own", () => {
    // A block with its own palette looks bolted on in every theme except the
    // one it was built against, and merchants change themes.
    const code = stripComments(css);
    expect(code).toMatch(/color:\s*inherit/);
    expect(code).not.toMatch(/font-family:/);
  });

  it("is mobile-first — the only media query WIDENS the layout", () => {
    const queries = stripComments(css).match(/@media[^{]+/g) ?? [];
    for (const query of queries) {
      if (query.includes("prefers-reduced-motion")) continue;
      expect(query).toMatch(/min-width/);
      expect(query).not.toMatch(/max-width/);
    }
  });
});
