/**
 * Reading the vendor's base ring size at import, and refusing when unsure.
 *
 * The expensive failure is not a crash, it is a GUESS: a wrong base size
 * prices most variants of a mounting $25, $40 or $100 off and looks entirely
 * normal. So most of these tests are about refusing.
 */
import { describe, expect, it } from "vitest";

import {
  extractVendorDefaultRingSize,
  verifyStoredDefaultRingSize,
} from "./vendorDefaultRingSize";

function size(title: string) {
  const r = extractVendorDefaultRingSize(title);
  return r.ok ? r.ringSize : null;
}
function reason(title: string) {
  const r = extractVendorDefaultRingSize(title);
  return r.ok ? null : r.reason;
}

describe("the owner's examples", () => {
  it("reads 7 from a whole-size title", () => {
    expect(size("14K Emerald Solitaire — Flat Band Pave (Size 7)")).toBe("7");
  });

  it("reads 6.5 from a half-size title", () => {
    expect(size("14K Pear Solitaire — Ultra Light Tulip (Size 6.5)")).toBe("6.5");
  });

  it("reads the real pilot's title", () => {
    const r = extractVendorDefaultRingSize("14K Pear Solitaire — Ultra Light Tulip (Size 6.5)");
    expect(r.ok && r.ringSize).toBe("6.5");
    expect(r.ok && r.matchedText).toBe("(Size 6.5)");
  });
});

describe("forms that are still clearly one stated size", () => {
  it("is case-insensitive", () => {
    expect(size("A Ring (SIZE 7)")).toBe("7");
    expect(size("A Ring (size 7)")).toBe("7");
  });

  it("tolerates the spacing vendors actually use", () => {
    expect(size("A Ring ( Size 7 )")).toBe("7");
    expect(size("A Ring (Size7)")).toBe("7");
  });

  it("canonicalises a trailing zero so one size is one stored value", () => {
    expect(size("A Ring (Size 7.0)")).toBe("7");
    expect(size("A Ring (Size 06)")).toBe("6");
  });

  it("accepts the ends of the supported range", () => {
    expect(size("A Ring (Size 1)")).toBe("1");
    expect(size("A Ring (Size 11)")).toBe("11");
  });

  it("accepts a base size above 8, which is legitimate", () => {
    // The base size always gets +$0, whatever its number. A parser that
    // rejected 9 would force every large-base mounting through manual review.
    expect(size("A Ring (Size 9)")).toBe("9");
    expect(size("A Ring (Size 10.5)")).toBe("10.5");
  });
});

describe("it refuses rather than guessing", () => {
  it("refuses a title with no size at all", () => {
    expect(size("14K Pear Solitaire — Ultra Light Tulip Mounting")).toBeNull();
    expect(reason("14K Pear Solitaire — Ultra Light Tulip Mounting")).toMatch(
      /states no default ring size/
    );
  });

  it("refuses the CLEANED-UP customer-facing title", () => {
    // This is the case the metafield exists for. Once the suffix is gone the
    // parser must refuse, never fall back to some other number in the title.
    expect(size("14K Emerald Solitaire — Flat Band Pavé")).toBeNull();
  });

  it("does NOT read a bare 'Size 7' outside parentheses", () => {
    // Too loose: "Size 7 center stone" and "Size 7" are indistinguishable to
    // a looser pattern, and one of them is not the base ring size.
    expect(size("14K Solitaire Size 7")).toBeNull();
    expect(reason("14K Solitaire Size 7")).toMatch(/not as a "\(Size X\)" suffix/);
  });

  it("does not mistake a stone count or a millimetre figure for a size", () => {
    expect(size("14K 7 Stone Band")).toBeNull();
    expect(size("14K Solitaire — 7 mm Cushion")).toBeNull();
    expect(size("14K Three Stone (3 Stone)")).toBeNull();
  });

  it("refuses a title stating two different sizes", () => {
    expect(size("A Ring (Size 7) (Size 8)")).toBeNull();
    expect(reason("A Ring (Size 7) (Size 8)")).toMatch(/more than one size \(7, 8\)/);
  });

  it("accepts a title that repeats the SAME size", () => {
    expect(size("A Ring (Size 7) — base (Size 7.0)")).toBe("7");
  });

  it("refuses a fraction form it cannot parse, and says so", () => {
    expect(size("A Ring (Size 6 1/2)")).toBeNull();
    expect(reason("A Ring (Size 6 1/2)")).toMatch(/not as a "\(Size X\)" suffix/);
  });

  it("refuses a size outside the supported 1-11 range", () => {
    expect(size("A Ring (Size 12)")).toBeNull();
    expect(reason("A Ring (Size 12)")).toMatch(/outside the supported 1-11 range/);
    expect(size("A Ring (Size 0.5)")).toBeNull();
  });

  it("refuses a size finer than a half step", () => {
    expect(size("A Ring (Size 6.25)")).toBeNull();
    expect(size("A Ring (Size 6.7)")).toBeNull();
  });

  it("refuses an empty title", () => {
    expect(size("")).toBeNull();
  });
});

describe("verifying what was actually stored against the vendor source", () => {
  const TITLE = "14K Pear Solitaire — Ultra Light Tulip (Size 6.5)";

  it("passes when the stored field matches the source title", () => {
    const r = verifyStoredDefaultRingSize("6.5", TITLE);
    expect(r.ok).toBe(true);
    expect(r.ok && r.ringSize).toBe("6.5");
  });

  it("passes across equivalent spellings of the same size", () => {
    expect(verifyStoredDefaultRingSize("6.50", TITLE).ok).toBe(true);
    expect(verifyStoredDefaultRingSize("7", "A Ring (Size 7.0)").ok).toBe(true);
    expect(verifyStoredDefaultRingSize("7.0", "A Ring (Size 7)").ok).toBe(true);
  });

  it("fails when the stored field disagrees with the source", () => {
    const r = verifyStoredDefaultRingSize("7", TITLE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/is 7 but the vendor title says 6\.5/);
  });

  it("fails when the field was never set", () => {
    expect(verifyStoredDefaultRingSize(null, TITLE).ok).toBe(false);
    expect(verifyStoredDefaultRingSize("", TITLE).ok).toBe(false);
    expect(verifyStoredDefaultRingSize("   ", TITLE).ok).toBe(false);
  });

  it("fails when the stored value is not a ring size", () => {
    const r = verifyStoredDefaultRingSize("six and a half", TITLE);
    expect(r.ok).toBe(false);
  });

  it("reports the extraction problem when the SOURCE is unusable", () => {
    // Nothing can be verified against a title that states no size, and the
    // reason returned must be about the title rather than the stored value.
    const r = verifyStoredDefaultRingSize("6.5", "14K Pear Solitaire — Ultra Light Tulip");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/states no default ring size/);
  });

  it("does not pass by comparing the parser with itself", () => {
    // The whole point of the verify step: a stored value that happens to be
    // absent or wrong must fail even though the title parses cleanly.
    expect(verifyStoredDefaultRingSize("8", "A Ring (Size 7)").ok).toBe(false);
  });
});
