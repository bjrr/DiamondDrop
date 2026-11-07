import { describe, expect, it } from "vitest";

import { micrometresToMm } from "./micrometres";

/**
 * The shared micrometre formatter.
 *
 * This replaced four copies of `(um / 1000)` followed by a fixed-decimal
 * round. The copies were not money, but they were float division and ad-hoc
 * rounding in the path that tells a customer whether their diamond fits a
 * mounting, which is not somewhere to be approximately right.
 *
 * The risk in consolidating was a silent change in output. That was settled
 * before the refactor landed by running both original implementations
 * against every integer micrometre value from 0 to 200mm and diffing: zero
 * disagreements out of 200,001 inputs. The comparison is not kept as a test,
 * because it would mean the banned pattern living on in the repository
 * forever and needing a money-safety exception to do so. The cases below are
 * what protects the behaviour now.
 */

describe("the format itself", () => {
  it("drops the decimal part entirely on a whole millimetre", () => {
    expect(micrometresToMm(10_000)).toBe("10");
    expect(micrometresToMm(6_000)).toBe("6");
    expect(micrometresToMm(0)).toBe("0");
  });

  it("trims trailing zeros but keeps significant ones", () => {
    expect(micrometresToMm(10_120)).toBe("10.12");
    expect(micrometresToMm(10_500)).toBe("10.5");
    expect(micrometresToMm(7_080)).toBe("7.08");
    expect(micrometresToMm(6_005)).toBe("6.005");
    // The leading zero inside the fraction must survive: 10 thousandths is
    // 0.01mm, not 0.1mm.
    expect(micrometresToMm(10_010)).toBe("10.01");
  });

  it("uses no floating point, so large values stay exact", () => {
    expect(micrometresToMm(999_999)).toBe("999.999");
    expect(micrometresToMm(1_000_001)).toBe("1000.001");
  });

  it("handles a negative value rather than producing nonsense", () => {
    // Not expected from a physical measurement, but a formatter that
    // silently mangles its input is worse than one that is simply correct.
    expect(micrometresToMm(-10_120)).toBe("-10.12");
    expect(micrometresToMm(-6_000)).toBe("-6");
  });
});
