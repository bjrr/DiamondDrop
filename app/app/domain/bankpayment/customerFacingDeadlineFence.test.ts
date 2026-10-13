import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * FENCE — the 96-hour inactivation deadline must never reach a customer.
 *
 * TWO DEADLINES EXIST AND THEY MEAN DIFFERENT THINGS:
 *
 *   groupBuyInitialPaymentDeadline  = quotedAt + 48h. What the CUSTOMER is
 *                                     told, matching the locked sentence
 *                                     "You have 48 hours to send payment".
 *   groupBuyPaymentWindowDeadline   = quotedAt + 96h. When the sweep may
 *                                     INACTIVATE an unpaid order, after the
 *                                     one automatic extension. Internal
 *                                     lifecycle timing, never a promise.
 *
 * WHY A FENCE AND NOT A CONVENTION. The confusion has already happened TWICE,
 * independently, and neither instance was caught by a unit test:
 *
 *   1. The instructions email printed the 96-hour date directly beneath the
 *      words "You have 48 hours to send payment" — a customer would have read
 *      a date four days out. Caught only by the production configuration
 *      gate, because only there were the two values compared.
 *   2. `groupBuyCheckoutResponseDto.paymentDueBy` — a field literally named
 *      "payment due by", returned to the customer's browser — carried the
 *      96-hour value. Nothing rendered it yet, which is the ONLY reason no
 *      customer saw two different dates.
 *
 * Both were individually reasonable: each value is correct for its own
 * purpose, and the names are similar enough that reaching for the wrong one
 * is a one-character mistake. That is exactly the kind of error a convention
 * cannot prevent and a fence can.
 *
 * WHAT THIS PINS. The modules that produce customer-facing payment text or
 * payload MUST NOT reference the 96-hour helper at all. Internal lifecycle
 * code (the sweep, the staff admin view) may and should.
 *
 * TO ADD A CUSTOMER-FACING MODULE: it goes in the list below and must use the
 * 48-hour helper. To let one legitimately use the 96-hour value — explaining
 * the extension in prose, say — add it to the allowlist with a comment, in a
 * diff a reviewer sees.
 */

const DOMAIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The 96-hour helper, and the constant that defines it. */
const INACTIVATION_SYMBOLS = ["groupBuyPaymentWindowDeadline", "GROUP_BUY_TOTAL_PAYMENT_WINDOW_MS"];

/**
 * Modules that produce text or payload a CUSTOMER sees. Each must speak only
 * the 48-hour deadline.
 */
const CUSTOMER_FACING = [
  "domain/bankpayment/groupBuyPaymentInstructionsEmail.ts",
  "domain/bankpayment/groupBuyCheckoutResponseDto.ts",
  "routes/apps.carat.group-buy-bank-checkout.tsx",
];

/**
 * Allowed to speak the 96-hour value: it IS their subject.
 *   - the window module itself defines both
 *   - the sweep enforces inactivation
 *   - the staff admin view shows staff when an order becomes inactivatable
 */
const INTERNAL_ALLOWED = [
  "domain/bankpayment/groupBuyPaymentWindow.ts",
  "jobs/bankpayment/groupBuyBankPaymentInactivationSweep.server.ts",
  "routes/app.group-buy-bank-payments.$id.tsx",
];

function read(relative: string): string {
  return readFileSync(`${APP_DIR}/${relative}`, "utf8");
}

describe("the 96-hour inactivation deadline never reaches a customer surface", () => {
  it("finds the files it claims to guard — a fence over nothing is not a fence", () => {
    for (const relative of [...CUSTOMER_FACING, ...INTERNAL_ALLOWED]) {
      expect(() => read(relative), `${relative} should exist; update this fence if it moved`).not.toThrow();
    }
  });

  it.each(CUSTOMER_FACING)("%s does not reference the 96-hour helper", (relative) => {
    const source = read(relative);
    const found = INACTIVATION_SYMBOLS.filter((symbol) => source.includes(symbol));
    expect(
      found,
      found.length === 0
        ? ""
        : `${relative} references ${found.join(", ")}. That is the INACTIVATION instant (quotedAt + 96h), ` +
            `not the deadline a customer is given (quotedAt + 48h, ` +
            `\`groupBuyInitialPaymentDeadline\`). Telling a customer the 96-hour date puts a figure four ` +
            `days out beside the words "You have 48 hours" — which has already shipped twice. Use the ` +
            `48-hour helper, or add this file to INTERNAL_ALLOWED with a reason.`
    ).toEqual([]);
  });

  it("the instructions email still explains the extension in PROSE, which is the legitimate 96-hour mention", () => {
    // The email may and should say "if payment hasn't arrived after 96 hours
    // we'll set your order aside" — that is describing the policy, not
    // printing a computed deadline. The distinction this fence draws is
    // between a SENTENCE about the extension and a DATE derived from it.
    const email = read("domain/bankpayment/groupBuyPaymentInstructionsEmail.ts");
    expect(email).toContain("after 96 hours");
    expect(email).toContain("You have 48 hours to send payment");
  });

  it("the internal users DO still use it, so this fence cannot pass by the symbol disappearing", () => {
    // Guard the guard: if the 96-hour helper were deleted or renamed, every
    // assertion above would pass vacuously while the real distinction was
    // lost.
    const stillUsed = INTERNAL_ALLOWED.filter((relative) =>
      INACTIVATION_SYMBOLS.some((symbol) => read(relative).includes(symbol))
    );
    expect(stillUsed.length).toBeGreaterThan(0);
  });

  it("every file in this domain that mentions a payment deadline is classified", () => {
    // Catches a NEW customer-facing module nobody added to the list — the
    // failure mode that would otherwise let instance three through.
    const unclassified = readdirSync(DOMAIN_DIR)
      .filter((name) => /^groupBuy.*\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => `domain/bankpayment/${name}`)
      .filter((relative) => INACTIVATION_SYMBOLS.some((symbol) => read(relative).includes(symbol)))
      .filter((relative) => ![...CUSTOMER_FACING, ...INTERNAL_ALLOWED].includes(relative));

    expect(
      unclassified,
      unclassified.length === 0
        ? ""
        : `These modules reference the 96-hour deadline but are classified neither customer-facing nor ` +
            `internal:\n${unclassified.map((p) => `  - ${p}`).join("\n")}\n\nDecide which they are.`
    ).toEqual([]);
  });
});
