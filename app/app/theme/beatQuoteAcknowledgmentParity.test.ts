import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_GROUP_BUY_ACTION,
  BEAT_QUOTE_GROUP_BUY_TEXT,
  BEAT_QUOTE_OLDER_QUOTE_ACTION,
  BEAT_QUOTE_OLDER_QUOTE_TEXT,
  BEAT_QUOTE_ONLINE_LISTING_ACTION,
  BEAT_QUOTE_ONLINE_LISTING_TEXT,
  BEAT_QUOTE_RECENT_QUOTE_ACTION,
  BEAT_QUOTE_RECENT_QUOTE_TEXT,
  BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
} from "../domain/beatyourquote/acknowledgmentText";

/**
 * THE ACKNOWLEDGMENT A CUSTOMER READS MUST BE THE ONE WE RECORD.
 *
 * The storefront cannot import from the app, so the four path
 * acknowledgments and the two universal ones exist twice: as TypeScript
 * constants the route writes into evidence, and as strings the theme shows
 * on screen. Two copies of a legal sentence drift. When they drift, our
 * evidence says the customer agreed to wording they never saw — which is
 * exactly the failure the acknowledgment system exists to prevent.
 *
 * This pins them character for character. A reworded term now fails the
 * build until BOTH sides move, which is the cheapest possible place to
 * catch it.
 *
 * WHY THE WHOLE STRING AND NOT A FUZZY MATCH. "Substantially the same" is
 * not a standard anyone can defend in a dispute. Either the customer read
 * this sentence or they did not.
 */

const THEME = join(process.cwd(), "..", "theme");

function themeJs(): string {
  return readFileSync(join(THEME, "assets", "beat-quote-form.js"), "utf8");
}

/**
 * Comments stripped. The banned-construct checks below scan for things like
 * `parseFloat`, and the file's own header comment EXPLAINS why parseFloat is
 * not used — so a naive scan fails on the documentation rather than on the
 * code. Same trap the money-safety scan hit elsewhere in this project.
 */
function themeJsCode(): string {
  return themeJs()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function locale(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(THEME, "locales", "en.default.json"), "utf8")) as {
    templates?: { beat_quote?: Record<string, string> };
  };
  const block = raw.templates?.beat_quote;
  if (!block) throw new Error("templates.beat_quote missing from en.default.json");
  return block;
}

/**
 * The theme JS wraps long strings across lines with `+` concatenation, and
 * the locale file uses typographic apostrophes where the TS constants use
 * straight ones. Normalising both sides compares the SENTENCE, not its
 * source formatting — the thing a customer actually reads.
 */
function normalise(s: string): string {
  return s
    .replace(/['‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Pulls a concatenated JS string literal out of the theme asset by key. */
function jsString(source: string, key: string): string {
  const re = new RegExp(key + "\\s*:\\s*((?:\\s*'(?:[^'\\\\]|\\\\.)*'\\s*\\+?)+)", "m");
  const m = source.match(re);
  if (!m || m[1] === undefined) throw new Error("could not find JS string for key: " + key);
  return m[1]
    .split("+")
    .map((part) => part.trim().replace(/^'/, "").replace(/'$/, ""))
    .join("");
}

describe("Beat Your Quote acknowledgment copy is identical in the app and the theme", () => {
  it("the two universal acknowledgments match the locale strings", () => {
    const l = locale();
    const need = (k: string): string => {
      const v = l[k];
      if (v === undefined) throw new Error("locale key missing: templates.beat_quote." + k);
      return v;
    };
    expect(normalise(need("ack_what_we_match"))).toBe(normalise(BEAT_QUOTE_WHAT_WE_MATCH_TEXT));
    expect(normalise(need("ack_authenticity"))).toBe(normalise(BEAT_QUOTE_AUTHENTICITY_TEXT));
  });

  it.each([
    ["recent_quote", BEAT_QUOTE_RECENT_QUOTE_TEXT],
    ["older_quote", BEAT_QUOTE_OLDER_QUOTE_TEXT],
    ["group_buy", BEAT_QUOTE_GROUP_BUY_TEXT],
    ["online_listing", BEAT_QUOTE_ONLINE_LISTING_TEXT],
  ])("path acknowledgment %s matches the server constant", (key, expected) => {
    const js = themeJs();
    expect(normalise(jsString(js, "text"))).toBeTypeOf("string");
    // Locate the block for this path, then read its `text:` member.
    const block = js.slice(js.indexOf(key + ":"));
    expect(normalise(jsString(block, "text"))).toBe(normalise(expected));
  });

  it.each([
    ["recent_quote", BEAT_QUOTE_RECENT_QUOTE_ACTION],
    ["older_quote", BEAT_QUOTE_OLDER_QUOTE_ACTION],
    ["group_buy", BEAT_QUOTE_GROUP_BUY_ACTION],
    ["online_listing", BEAT_QUOTE_ONLINE_LISTING_ACTION],
  ])("affirmative action label for %s matches the server constant", (key, expected) => {
    const js = themeJs();
    const block = js.slice(js.indexOf(key + ":"));
    expect(normalise(jsString(block, "action"))).toBe(normalise(expected));
  });

  it("all four path acknowledgments are present — a missing one would fall back silently", () => {
    const js = themeJs();
    for (const key of ["recent_quote", "older_quote", "group_buy", "online_listing"]) {
      expect(js, `PATH_ACK is missing ${key}`).toContain(key + ":");
    }
  });

  it("the guarantee window in the theme matches the server's 7 calendar days", () => {
    // The theme mirrors this rule to decide which acknowledgment to SHOW.
    // If the window ever moves, a stale client would show the guarantee
    // wording for a quote the server treats as review-only.
    expect(themeJs()).toContain("GUARANTEE_WINDOW_DAYS = 7");
  });

  it("the theme never decides treatment — it posts kind and date only", () => {
    const js = themeJsCode();
    // `treatment` must not appear as a field the client sends. The route
    // derives it, and accepting it from the body would be a trust boundary
    // violation the route's .strict() already refuses.
    expect(js).not.toMatch(/payload\.treatment/);
    expect(js).not.toMatch(/treatment\s*:/);
  });

  it("money is converted by string, never through a float", () => {
    const js = themeJsCode();
    expect(js).not.toMatch(/parseFloat/);
    expect(js).not.toMatch(/Number\s*\(\s*(?:raw|s|priceRaw)/);
    expect(js).toContain("toMinorUnits");
  });
});
