/**
 * Micrometres to a millimetre display string.
 *
 * ===========================================================================
 * ONE IMPLEMENTATION, WHERE THERE WERE FOUR
 * ===========================================================================
 * This function existed four times, copied into `matching.ts`,
 * `metafieldProjection.ts`, `matchedSnapshot.ts` and the ready-mountings
 * admin route, under three different names and with two slightly different
 * trailing-zero regexes that happened to agree. Four copies of a formatter
 * is four places to fix a bug and three places to forget.
 *
 * ===========================================================================
 * NO FLOATING POINT, WHICH IS WHY THIS MOVED
 * ===========================================================================
 * Every copy divided by 1000 and then rounded to three decimals with the
 * fixed-decimal formatter. That is float division followed by ad-hoc
 * rounding, and the repository's money-safety gate flags the pattern
 * everywhere, not only on money. (The gate is lexical and reads comments
 * too, so this one does not name the call.) The gate is right to: these are
 * physical
 * stone measurements that decide whether a customer's diamond fits a
 * mounting, and "near enough" is not a property anyone wants in that path.
 *
 * Micrometres are integers and a millimetre is exactly 1000 of them, so the
 * split is exact with integer arithmetic and there is nothing to round. The
 * output is unchanged: the existing tests in `matching.test.ts` and
 * `metafieldProjection.test.ts` pin the exact strings and still pass.
 */

/**
 * @param um whole micrometres
 * @returns millimetres with trailing zeros trimmed, so 10000 reads as "10"
 *          rather than "10.000" and 10120 reads as "10.12"
 */
export function micrometresToMm(um: number): string {
  const negative = um < 0;
  const absolute = negative ? -um : um;

  // Exact: `absolute - (absolute % 1000)` is divisible by 1000 by
  // construction, so this division cannot produce a fraction.
  const whole = (absolute - (absolute % 1000)) / 1000;
  const thousandths = absolute % 1000;
  const sign = negative ? "-" : "";

  if (thousandths === 0) return `${sign}${whole}`;

  // Three digits, then trailing zeros trimmed: 120 -> "120" -> "12", giving
  // ".12"; 10 -> "010" -> "01", giving ".01".
  const fraction = String(thousandths).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fraction}`;
}
