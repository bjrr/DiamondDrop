import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * OWNER-APPROVED CUSTOMER-FACING COPY, PINNED CHARACTER FOR CHARACTER.
 *
 * These four strings are material pricing communication. The owner approved
 * this exact wording on 2026-09-21; nobody may reword them without going back
 * for approval, and a well-meant edit is the likeliest way that happens by
 * accident.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER THEME GUARDS. The existing
 * tests assert what must NOT appear — no internal percentage, no "cash", no
 * "card fee", no "surcharge", no error/warning framing. That is a necessary
 * check and it is not this one. A string can satisfy every prohibition and
 * still not be the sentence the owner signed off. Slice 1's Group Buy block
 * established the pattern of pinning approved copy verbatim; these four had
 * only the prohibitions, so a rewording would have passed silently.
 *
 * The copy changed once already: the owner revised the reprice notice and the
 * switch note away from the drafted versions. That is exactly the event this
 * file makes visible in a diff rather than invisible in a locale blob.
 */

const LOCALES = join(process.cwd(), "..", "theme", "locales", "en.default.json");

function locale(): Record<string, unknown> {
  return JSON.parse(readFileSync(LOCALES, "utf8")) as Record<string, unknown>;
}

/** Walks a dotted path, so a moved key fails loudly rather than reading undefined. */
function at(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, locale());
}

/** Owner-approved 2026-09-21. Do not edit without owner approval. */
const APPROVED: ReadonlyArray<readonly [string, string]> = [
  [
    "sections.cart.pricing.card_checkout_reprice_notice",
    "Your cart is now set to Card pricing. The Card Total above is the amount you'll pay if you continue to Card Checkout. To use Bank Payment pricing, switch back to Bank Payment.",
  ],
  ["sections.cart.card_checkout_confirm", "Continue to Card Checkout"],
  ["sections.cart.pricing.switch_to_bank_payment", "Switch to Bank Payment Pricing"],
  [
    "sections.cart.pricing.switch_to_bank_payment_note",
    "Eligible items will update to their Bank Payment Price.",
  ],
];

describe("owner-approved customer-facing copy is pinned verbatim", () => {
  it.each(APPROVED)("%s matches the approved wording exactly", (path, expected) => {
    expect(
      at(path),
      `${path} does not match the wording the owner approved on 2026-09-21. This is ` +
        `material pricing communication: it tells a customer which basis they are ` +
        `about to pay on. If the wording genuinely needs to change, take the new ` +
        `text to the owner and update this file in the same commit — do not edit ` +
        `the locale alone, or the approval record and the storefront drift apart.`
    ).toBe(expected);
  });

  it("guards the guard: every pinned key actually resolves", () => {
    // A typo'd path would make every assertion above compare undefined to a
    // string and fail loudly — but a path that resolves to the WRONG node
    // could compare undefined and pass if the expectation were also undefined.
    // This asserts each key is a real, non-empty string in the locale.
    for (const [path] of APPROVED) {
      const value = at(path);
      expect(typeof value, `${path} is missing from the locale file`).toBe("string");
      expect((value as string).length, `${path} is empty`).toBeGreaterThan(0);
    }
  });

  it("the approved copy itself contains no forbidden terminology", () => {
    // The prohibitions apply to approved copy too. If an approved string ever
    // contained one of these, the conflict should surface here rather than in
    // the separate forbidden-terms sweep, where it would look like a drafting
    // slip rather than an approval that needs revisiting.
    const forbidden = /\b(cash|cash discount|card fee|credit card fee|surcharge)\b/i;
    for (const [path, text] of APPROVED) {
      expect(forbidden.test(text), `${path} contains forbidden terminology`).toBe(false);
    }
  });
});
