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
    expect(code).toMatch(/data\.groupBuyPriceMinorUnits/);
    expect(code).toMatch(/data\.savingsMinorUnits/);
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
