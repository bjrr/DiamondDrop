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

describe("Bank Payment display (docs/BANK-CARD-PRICING.md §6)", () => {
  const code = stripComments(js);

  it("leads with the REGULAR/CARD price and shows Bank Payment beneath it", () => {
    // The primary advertised price is the card price; the Bank Payment Price is
    // secondary. The order is the policy, not a styling preference, so it is
    // asserted structurally rather than left to whoever next edits the template.
    const headline = code.indexOf("groupBuyRegularCardPriceMinorUnits");
    const bank = code.indexOf("groupBuyBankPaymentPriceMinorUnits");
    expect(headline).toBeGreaterThan(-1);
    expect(bank).toBeGreaterThan(-1);
    expect(headline).toBeLessThan(bank);
  });

  it("uses the words the owner specified, verbatim", () => {
    // Customer-facing terminology is locked. "Bank Payment Price: $X" and
    // "Save $Y with Bank Payment" are the approved strings.
    expect(code).toMatch(/Bank Payment Price: /);
    expect(code).toMatch(/with Bank Payment/);
    expect(code).toMatch(/Group Buy Price/);
  });

  it("uses NO superseded or forbidden payment wording", () => {
    // The whole point of the terminology change. Checked on the rendered
    // strings AND the comments, because a stale comment is how the old wording
    // creeps back into the next edit.
    const everything = (js + css + liquid).toLowerCase();
    for (const forbidden of [
      "cash price",
      "cash-equivalent",
      "cash discount",
      "credit card fee",
      "card fee",
      "surcharge",
    ]) {
      expect(everything, `must not contain "${forbidden}"`).not.toContain(forbidden);
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

  it("renders the OWNER-APPROVED wording, character for character", () => {
    // Approved copy, not a paraphrase. Asserted as exact strings because these
    // three lines were signed off as written and a well-meant rewording is the
    // most likely way they drift.
    expect(code).toContain('"Bank Payment Price: "');
    expect(code).toContain('" with Bank Payment"');
    expect(code).toContain(
      '"Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment."'
    );
  });

  it("promises no checkout behaviour the platform cannot deliver", () => {
    // Shopify cannot change the payable total at payment-method selection
    // (docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md). For MVP1 Phase 1 the Bank
    // Payment Price is obtained by arrangement, so the copy must say contact —
    // never "select at checkout", which the platform would not honour.
    expect(code).toMatch(/Contact us to arrange payment/);
    expect(code).not.toMatch(/select .{0,30}at checkout/i);
    expect(code).not.toMatch(/choose .{0,30}at checkout/i);
    expect(code).not.toMatch(/at checkout/i);
  });

  it("shows the bank saving as an absolute amount from the server", () => {
    // Policy §9: computed after the $5 ceiling, server-side. The block must
    // render the figure it was given rather than subtract two prices itself —
    // client arithmetic on money is the habit this whole file guards against.
    expect(code).toMatch(/data\.groupBuyBankPaymentSavingsMinorUnits/);
  });

  it("keeps the two savings distinguishable in the copy", () => {
    // "Save $111 with Bank Payment" and "You save $250 vs buying now" are
    // different quantities. Rendered adjacently and worded alike they would
    // read as one number, or be added together.
    expect(code).toMatch(/with Bank Payment/);
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
