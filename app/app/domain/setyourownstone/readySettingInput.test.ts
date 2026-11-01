/**
 * Operator input validation for ready-mount compatibility data.
 *
 * These rules are the only thing between a typo and a confident, wrong
 * "Matches your stone size" — which nobody discovers until a bench has the
 * customer's own diamond in hand. So the boundaries get tested, not just the
 * happy path.
 */
import { describe, expect, it } from "vitest";

import {
  parseReadySettingInput,
  READY_SETTING_SHAPES,
  ReadySettingInputError,
} from "./readySettingInput";

/** A complete, valid submission: oval 10 x 7, prong-adjustable, no vendor range. */
const VALID = {
  shopifyProductGid: "gid://shopify/Product/111",
  shopifyVariantGid: "gid://shopify/ProductVariant/222",
  shape: "oval",
  nominalLengthMm: "10",
  nominalWidthMm: "7",
  eligibleForSetYourOwnStone: "on",
  prongSetToleranceEligible: "on",
  isActive: "on",
};

function errorsFor(fields: Record<string, unknown>): Record<string, string> {
  try {
    parseReadySettingInput(fields);
  } catch (e) {
    if (e instanceof ReadySettingInputError) return e.fieldErrors;
    throw e;
  }
  throw new Error("expected the input to be refused");
}

describe("a complete valid submission", () => {
  it("converts millimetres to integer micrometres", () => {
    const out = parseReadySettingInput({ ...VALID, nominalLengthMm: "10.25", nominalWidthMm: "7.08" });
    // Integers, so "is 10.3 within 0.3 of 10.0" has one answer and no
    // floating-point argument about it.
    expect(out.nominalLengthUm).toBe(10_250);
    expect(out.nominalWidthUm).toBe(7_080);
    expect(Number.isInteger(out.nominalLengthUm)).toBe(true);
  });

  it("treats a whole number and its padded form identically", () => {
    expect(parseReadySettingInput({ ...VALID, nominalLengthMm: "10" }).nominalLengthUm).toBe(10_000);
    expect(parseReadySettingInput({ ...VALID, nominalLengthMm: "10.0" }).nominalLengthUm).toBe(10_000);
    expect(parseReadySettingInput({ ...VALID, nominalLengthMm: "10.000" }).nominalLengthUm).toBe(10_000);
  });

  it("leaves optional depth and the vendor range null when blank", () => {
    const out = parseReadySettingInput({ ...VALID, nominalDepthMm: "", minLengthMm: "" });
    expect(out.nominalDepthUm).toBeNull();
    expect(out.minLengthUm).toBeNull();
    expect(out.maxWidthUm).toBeNull();
  });

  it("accepts every shape the matcher knows, and nothing else", () => {
    for (const shape of READY_SETTING_SHAPES) {
      expect(parseReadySettingInput({ ...VALID, shape }).shape).toBe(shape);
    }
    expect(errorsFor({ ...VALID, shape: "trillion" })).toHaveProperty("shape");
  });
});

describe("the flags default safe", () => {
  it("treats an absent prong checkbox as NOT eligible", () => {
    // An unchecked box is simply missing from a form body. It must never be
    // read as consent to apply a fit allowance.
    const { prongSetToleranceEligible: _prongSetToleranceEligible, ...withoutFlag } = VALID;
    expect(parseReadySettingInput(withoutFlag).prongSetToleranceEligible).toBe(false);
  });

  it("treats an absent eligibility checkbox as NOT eligible", () => {
    const { eligibleForSetYourOwnStone: _eligibleForSetYourOwnStone, ...withoutFlag } = VALID;
    expect(parseReadySettingInput(withoutFlag).eligibleForSetYourOwnStone).toBe(false);
  });

  it("treats an absent active field as active, matching the column default", () => {
    const { isActive: _isActive, ...withoutFlag } = VALID;
    expect(parseReadySettingInput(withoutFlag).isActive).toBe(true);
  });

  it("does not accept arbitrary truthy strings as a tick", () => {
    expect(
      parseReadySettingInput({ ...VALID, prongSetToleranceEligible: "no" }).prongSetToleranceEligible
    ).toBe(false);
  });
});

describe("millimetre parsing is strict about form, not just value", () => {
  it.each([
    ["10.3mm", "a unit pasted in with the number"],
    ["1e2", "exponent notation"],
    ["10.1234", "more precision than we measure"],
    ["-5", "negative"],
    ["0", "zero"],
    ["", "empty"],
    ["abc", "not a number"],
    ["10,3", "a decimal comma"],
    ["10.3 (approx)", "an annotation"],
  ])("refuses %s — %s", (value) => {
    expect(errorsFor({ ...VALID, nominalLengthMm: value })).toHaveProperty("nominalLengthMm");
  });

  it("accepts the largest dimension the format allows", () => {
    const out = parseReadySettingInput({ ...VALID, nominalLengthMm: "99.999", nominalWidthMm: "99.999" });
    expect(out.nominalLengthUm).toBe(99_999);
  });

  it("rejects anything with three digits before the decimal", () => {
    // Two digits is the cap, so a centre stone can never be recorded at
    // 100 mm or more. This is what catches the "typed micrometres into the
    // millimetre field" mistake — 10250 would otherwise store a
    // plausible-looking integer and match nothing.
    for (const value of ["100", "10250", "123.4"]) {
      expect(errorsFor({ ...VALID, nominalLengthMm: value })).toHaveProperty("nominalLengthMm");
    }
  });
});

describe("length and width must not be swapped", () => {
  it("refuses a width greater than the length", () => {
    // Swapped values match nothing, which looks like a bug in the matching
    // rules rather than a typo on this form.
    const errors = errorsFor({ ...VALID, nominalLengthMm: "7", nominalWidthMm: "10" });
    expect(errors.nominalWidthMm).toMatch(/swapped/i);
  });

  it("allows them equal, which is what a round or square mounting is", () => {
    const out = parseReadySettingInput({ ...VALID, shape: "round", nominalLengthMm: "6", nominalWidthMm: "6" });
    expect(out.nominalLengthUm).toBe(out.nominalWidthUm);
  });
});

describe("a vendor range is all four bounds or none (§6.2)", () => {
  const FULL_RANGE = {
    minLengthMm: "9.8",
    maxLengthMm: "10.3",
    minWidthMm: "6.8",
    maxWidthMm: "7.2",
    vendorRangeSource: "Vendor spec sheet p.4",
  };

  it("accepts all four with a source", () => {
    const out = parseReadySettingInput({ ...VALID, ...FULL_RANGE });
    expect(out.minLengthUm).toBe(9_800);
    expect(out.maxWidthUm).toBe(7_200);
    expect(out.vendorRangeSource).toBe("Vendor spec sheet p.4");
  });

  it("refuses a partial range, naming each missing bound", () => {
    // Accepting a partial range would store data the matcher ignores — worse
    // than refusing, because the operator would believe a restriction is in
    // force when none is.
    const errors = errorsFor({ ...VALID, minLengthMm: "9.8", maxLengthMm: "10.3" });
    expect(errors).toHaveProperty("minWidthMm");
    expect(errors).toHaveProperty("maxWidthMm");
    expect(errors).not.toHaveProperty("minLengthMm");
  });

  it("requires a source, because the range outranks every rule of ours", () => {
    const { vendorRangeSource: _vendorRangeSource, ...noSource } = FULL_RANGE;
    const errors = errorsFor({ ...VALID, ...noSource });
    expect(errors.vendorRangeSource).toMatch(/where this range came from/i);
  });

  it("refuses a maximum below its minimum", () => {
    expect(
      errorsFor({ ...VALID, ...FULL_RANGE, minLengthMm: "10.5", maxLengthMm: "10.0" })
    ).toHaveProperty("maxLengthMm");
    expect(
      errorsFor({ ...VALID, ...FULL_RANGE, minWidthMm: "7.5", maxWidthMm: "7.0" })
    ).toHaveProperty("maxWidthMm");
  });

  it("allows a degenerate single-size range", () => {
    // min === max is a vendor saying "this size exactly". Unusual, not wrong.
    const out = parseReadySettingInput({
      ...VALID,
      ...FULL_RANGE,
      minLengthMm: "10",
      maxLengthMm: "10",
      minWidthMm: "7",
      maxWidthMm: "7",
    });
    expect(out.minLengthUm).toBe(out.maxLengthUm);
  });
});

describe("Shopify identities must be the right kind of id", () => {
  it("refuses a product gid in the variant field", () => {
    // Stored as-is this would simply never match, with nothing to indicate
    // why — the row looks complete.
    const errors = errorsFor({ ...VALID, shopifyVariantGid: "gid://shopify/Product/222" });
    expect(errors).toHaveProperty("shopifyVariantGid");
  });

  it("refuses a bare numeric id", () => {
    expect(errorsFor({ ...VALID, shopifyVariantGid: "222" })).toHaveProperty("shopifyVariantGid");
  });

  it("refuses a variant gid in the product field", () => {
    expect(errorsFor({ ...VALID, shopifyProductGid: "gid://shopify/ProductVariant/111" })).toHaveProperty(
      "shopifyProductGid"
    );
  });
});

describe("every problem is reported at once", () => {
  it("collects errors across unrelated fields in one pass", () => {
    // An operator correcting six fields should not resubmit six times to find
    // the next complaint.
    const errors = errorsFor({
      shopifyProductGid: "nope",
      shopifyVariantGid: "nope",
      shape: "trillion",
      nominalLengthMm: "abc",
      nominalWidthMm: "",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "nominalLengthMm",
      "nominalWidthMm",
      "shape",
      "shopifyProductGid",
      "shopifyVariantGid",
    ]);
  });
});
