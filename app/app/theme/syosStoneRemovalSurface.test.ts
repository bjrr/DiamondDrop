import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  STONE_MOUNTED_QUESTION,
  STONE_MOUNTED_STATES,
  STONE_REMOVAL_COPY,
} from "~/domain/setyourownstone/stoneRemoval";

/**
 * The $50 Stone Removal surface (§17.3, owner-locked 2026-11-02).
 *
 * WHY THE COPY EXISTS TWICE. The intake question renders before any server
 * call, so the theme needs the wording in its own locale file; the rule and the
 * responses need it in the domain module. Two copies of owner-approved wording
 * is a drift risk, so this file pins them to each other character for
 * character. Change one without the other and this fails.
 *
 * The rest is the liability boundary as it reaches the page: only a prong-set
 * stone may be charged, the fee is never computed on the client, and the
 * decline must not read as a dead end.
 */
const THEME_ROOT = join(process.cwd(), "..", "theme");
const read = (...parts: string[]) => readFileSync(join(THEME_ROOT, ...parts), "utf8");

const locale = JSON.parse(read("locales", "en.default.json")) as {
  templates: { set_your_own_stone: { stone: Record<string, string> } };
};
const stone = locale.templates.set_your_own_stone.stone;

function stripLiquidComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the approved copy is the same on both sides", () => {
  it("asks the owner's question with the owner's three answers", () => {
    expect(stone.mounted_label).toBe(STONE_MOUNTED_QUESTION.label);
    expect(stone.mounted_loose).toBe(STONE_MOUNTED_QUESTION.answers.LOOSE);
    expect(stone.mounted_prong).toBe(STONE_MOUNTED_QUESTION.answers.MOUNTED_PRONG);
    expect(stone.mounted_unsupported).toBe(
      STONE_MOUNTED_QUESTION.answers.MOUNTED_UNSUPPORTED
    );
  });

  it("names the service and states both outcomes verbatim", () => {
    expect(stone.removal_offer_label).toBe(STONE_REMOVAL_COPY.offerLabel);
    expect(stone.removal_offered).toBe(STONE_REMOVAL_COPY.offered);
    expect(stone.removal_unavailable).toBe(STONE_REMOVAL_COPY.unavailable);
  });

  it("dropped the old two-way answer, which could not express the decision", () => {
    // "Currently set in a piece" says mounted but not whether we may open it.
    expect(stone.mounted_set).toBeUndefined();
    expect(JSON.stringify(locale)).not.toContain("Currently set in a piece");
  });
});

describe("the intake asks all three and defaults to none", () => {
  const section = stripLiquidComments(read("sections", "set-your-own-stone.liquid"));

  it("offers exactly the three states as radio values", () => {
    for (const state of STONE_MOUNTED_STATES) {
      expect(section).toContain(`name="mountedState" value="${state}"`);
    }
    const values = [...section.matchAll(/name="mountedState" value="([^"]+)"/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...STONE_MOUNTED_STATES].sort());
  });

  it("pre-selects nothing", () => {
    // The old control defaulted to Loose. Safe for "where is the stone", not
    // for a question that decides whether we may cut metal away from it.
    const radios = section.match(/<input type="radio" name="mountedState"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio).not.toContain("checked");
  });

  it("does not pre-tick a $50 charge", () => {
    const box = section.match(/<input type="checkbox" name="stoneRemovalSelected"[^>]*>/);
    expect(box).not.toBeNull();
    expect(box?.[0]).not.toContain("checked");
  });

  it("keeps both outcome blocks hidden until the customer answers", () => {
    expect(section).toMatch(/data-carat-syos-removal-prong\s+hidden/);
    expect(section).toMatch(/data-carat-syos-removal-unsupported\s+hidden/);
  });

  it("does not ask the customer to identify a bezel, tension, flush or channel setting", () => {
    // §2: no exhaustive customer-facing taxonomy.
    expect(section).not.toMatch(/bezel|tension|flush|channel/i);
  });
});

describe("the storefront never decides or computes the fee", () => {
  const script = stripJsComments(read("assets", "set-your-own-stone.js"));

  it("never reads or computes the fee", () => {
    // The $50 lives in Shopify's price field on a real product, and the cart
    // line carries no amount at all — so the script has no reason to touch the
    // figure. It does not read `feeMinorUnits`, and does no arithmetic that
    // could turn a flat fee into a scaled one.
    expect(script).not.toContain("feeMinorUnits");
    expect(script).not.toMatch(/priceMinorUnits\s*[*+/-]/);
    expect(script).not.toMatch(/(parseFloat|parseInt|Number)\s*\([^)]*(removal|fee)/i);
  });

  /**
   * The cart-payload region specifically.
   *
   * SCOPED ON PURPOSE. The same `removal.kind === 'offered'` test also appears
   * in `renderRemoval`, which only decides what text to show. Asserting the
   * guard exists somewhere in the file passed even with the guard on the cart
   * line replaced by `true` — found by mutation-testing this fence. What has
   * to hold is that the line added to the cart is guarded, so that is what is
   * read.
   */
  const cartPayload = (() => {
    const fn = script.slice(script.indexOf("function addToCart"));
    return fn.slice(0, fn.indexOf("fetch('/cart/add.js'"));
  })();

  it("adds the service line only when the server said it was offered", () => {
    expect(cartPayload).toContain("removal.kind === 'offered'");
    expect(cartPayload).toContain("removal.selected");
    // And from the last server response, not from the form.
    expect(cartPayload).toContain("lastPayload && lastPayload.removal");
  });

  it("guards the service line on both halves of the verdict", () => {
    // Either half alone is not enough: `offered` without `selected` charges a
    // customer who declined, and `selected` without `offered` charges one who
    // was never eligible.
    const guard = cartPayload.slice(cartPayload.indexOf("items.push"));
    expect(guard).toBeTruthy();
    const condition = cartPayload.slice(0, cartPayload.indexOf("items.push"));
    expect(condition).toMatch(/removal\.kind === 'offered'[\s\S]{0,80}removal\.selected/);
  });

  it("sends no price with the cart line", () => {
    const addToCart = script.slice(script.indexOf("function addToCart"));
    const serviceLine = addToCart.slice(0, addToCart.indexOf("fetch('/cart/add.js'"));
    expect(serviceLine).toContain("_syos_service: 'STONE_REMOVAL'");
    expect(serviceLine).not.toMatch(/price|amount|minorUnits/i);
  });

  it("adds exactly one removal line, never a quantity derived from anything", () => {
    const addToCart = script.slice(script.indexOf("function addToCart"));
    const serviceLine = addToCart.slice(0, addToCart.indexOf("fetch('/cart/add.js'"));
    const quantities = [...serviceLine.matchAll(/quantity:\s*([^,\n]+)/g)].map((m) =>
      m[1]?.trim()
    );
    expect(quantities.length).toBeGreaterThan(0);
    // Every quantity in the cart payload is the literal 1. Not a variable, not
    // a count of anything — a flat fee cannot be allowed to multiply.
    expect(quantities).toEqual(quantities.map(() => "1"));
  });

  it("clears the tick when the customer moves off the prong answer", () => {
    // Otherwise a hidden checkbox could still post true.
    expect(script).toContain("if (box && state !== 'MOUNTED_PRONG') box.checked = false;");
  });

  it("resolves the service variant from the real product, not a hard-coded id", () => {
    const section = stripLiquidComments(read("sections", "set-your-own-stone.liquid"));
    expect(section).toContain("all_products['stone-removal']");
    // A literal Shopify id in the theme would silently break on any store but
    // this one, and would survive the product being deleted.
    expect(section).not.toMatch(/variantId:\s*\d{6,}/);
  });
});

describe("the decline is not a dead end", () => {
  it("tells the customer they can carry on designing", () => {
    expect(stone.removal_unavailable).toMatch(/continue designing your new setting/);
  });

  it("does not block the form or hide the design paths", () => {
    const section = stripLiquidComments(read("sections", "set-your-own-stone.liquid"));
    const script = stripJsComments(read("assets", "set-your-own-stone.js"));
    // Nothing keys submit availability or the two-path fork off the mounted
    // state: an unsupported setting changes what we will do to the stone, not
    // what the customer may design.
    expect(script).not.toMatch(
      /MOUNTED_UNSUPPORTED[\s\S]{0,200}(submit\.disabled|showChoice|hidden = true)/
    );
    expect(section).toMatch(/data-carat-syos-choose-ready/);
    expect(section).toMatch(/data-carat-syos-choose-custom/);
  });
});

describe("no unapproved liability language", () => {
  it("never promises risk-free or damage-free removal anywhere customer-facing", () => {
    // Comments stripped first. A comment that says "do not promise risk-free"
    // is the rule being written down, not the claim being made — scanning it
    // would flag the safeguard as the violation.
    const surfaces = [
      JSON.stringify(locale),
      stripLiquidComments(read("sections", "set-your-own-stone.liquid")),
      stripJsComments(read("assets", "set-your-own-stone.js")),
    ].join("\n");
    for (const banned of [
      /risk[- ]free/i,
      /guaranteed safe/i,
      /no possibility of damage/i,
      /cannot be damaged/i,
      /without any risk/i,
    ]) {
      expect(surfaces).not.toMatch(banned);
    }
  });
});
