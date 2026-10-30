import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `1234.56` MUST become `123456`, deterministically.
 *
 * The storefront converts a typed dollar amount into the integer minor units
 * the submission route demands (`/^\d{1,15}$/`). CLAUDE.md rule 6 forbids
 * floating point for money, and this is exactly why:
 *
 *     parseFloat("1234.56") * 100  ===  123455.99999999999
 *
 * Rounding that away would work most of the time and be wrong occasionally,
 * which is the worst property a money function can have. The implementation
 * is pure string manipulation instead.
 *
 * THE OTHER HALF OF THE REQUIREMENT. Normal two-decimal USD must be
 * ACCEPTED, not rejected. A converter that refuses `1234.56` because floats
 * are scary is just as broken as one that mangles it. These cases pin both
 * directions.
 *
 * The function is extracted from the shipped theme asset rather than
 * reimplemented here, so this tests the code customers actually run.
 */

const THEME = join(process.cwd(), "..", "theme");

function loadToMinorUnits(): (raw: unknown) => string | null {
  const source = readFileSync(join(THEME, "assets", "beat-quote-form.js"), "utf8");
  const match = source.match(/function toMinorUnits\(raw\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error("toMinorUnits not found in beat-quote-form.js");
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return toMinorUnits;`)() as (raw: unknown) => string | null;
}

const toMinorUnits = loadToMinorUnits();

describe("customer-entered amounts become exact minor units", () => {
  it.each([
    ["1234.56", "123456"], // the case named in the requirement
    ["0.01", "1"],
    ["0.10", "10"],
    ["0.1", "10"], // one decimal place is tenths, not hundredths
    ["5", "500"],
    ["2450", "245000"],
    ["2450.00", "245000"],
    ["19.99", "1999"],
    ["100000", "10000000"],
    ["0.99", "99"],
  ])("%s dollars -> %s cents", (input, expected) => {
    expect(toMinorUnits(input)).toBe(expected);
  });

  it("accepts the formatting a customer actually types", () => {
    // Currency symbol, thousands separators and stray whitespace are
    // stripped rather than refused — rejecting "$1,234.56" would be
    // pedantry aimed at the customer instead of at the data.
    expect(toMinorUnits("$1,234.56")).toBe("123456");
    expect(toMinorUnits("  2450.00  ")).toBe("245000");
    expect(toMinorUnits("$12,500")).toBe("1250000");
  });

  it.each([
    ["1234.567", "three decimal places — not representable in cents"],
    ["12.3456", "four decimal places"],
    ["abc", "not a number"],
    ["", "empty"],
    ["-50.00", "negative"],
    ["1.2.3", "malformed"],
    ["1e5", "exponent notation"],
  ])("rejects %s (%s)", (input) => {
    expect(toMinorUnits(input)).toBeNull();
  });

  it("never loses a cent to floating point, across a wide sweep", () => {
    // The specific failure this guards: dollars*100 in IEEE-754 drifts for
    // many ordinary values. Walking every cent of a realistic jewelry price
    // range would catch any reintroduction of float arithmetic.
    for (let cents = 1; cents <= 500_000; cents += 7) {
      const whole = Math.trunc(cents / 100);
      const frac = cents % 100;
      const typed = `${whole}.${String(frac).padStart(2, "0")}`;
      expect(toMinorUnits(typed)).toBe(String(cents));
    }
  });

  it("the result always satisfies the route's own pattern", () => {
    const routePattern = /^\d{1,15}$/;
    for (const input of ["1234.56", "0.01", "999999999.99", "1"]) {
      const out = toMinorUnits(input);
      expect(out).not.toBeNull();
      expect(routePattern.test(out!)).toBe(true);
    }
  });
});
