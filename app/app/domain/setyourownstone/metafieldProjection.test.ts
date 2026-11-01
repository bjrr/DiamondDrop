/**
 * Projecting Shopify metafields into the compatibility index.
 *
 * The headline property: a misconfiguration must cost a MISSING mounting,
 * never a WRONG match. Every problem case below therefore asserts
 * `eligibleForSetYourOwnStone === false` as well as the message — a readable
 * complaint on a row the matcher still offers would be worse than no
 * validation at all.
 */
import { describe, expect, it } from "vitest";

import {
  dimensionsClaimedByLabel,
  projectProduct,
  umToMm,
  type ShopifyProductCompatibilityInput,
  type SizeProfile,
} from "./metafieldProjection";

const PRODUCT = "gid://shopify/Product/111";
const VARIANT = "gid://shopify/ProductVariant/222";

/** A correctly configured prong-set pear mounting at 10 × 7 mm. */
function input(
  overrides: {
    productStatus?: string;
    product?: Record<string, string | null>;
    variant?: Record<string, string | null>;
    profile?: Partial<SizeProfile> | null;
    optionValueName?: string | null;
    optionValueId?: string | null;
  } = {}
): ShopifyProductCompatibilityInput {
  return {
    productGid: PRODUCT,
    productStatus: overrides.productStatus ?? "ACTIVE",
    productMetafields: {
      syos_eligible: "true",
      syos_stone_shape: "pear",
      syos_setting_style: "prong",
      syos_prong_adjustable: "true",
      syos_prong_tolerance_eligible: "true",
      syos_vendor: "Stuller",
      ...(overrides.product ?? {}),
    },
    variants: [
      {
        variantGid: VARIANT,
        title: "10 × 7 mm / 14K Yellow Gold / 6.5",
        centerSizeOptionValueId:
          overrides.optionValueId === undefined
            ? "gid://shopify/ProductOptionValue/9"
            : overrides.optionValueId,
        centerSizeOptionValueName:
          overrides.optionValueName === undefined ? "10 × 7 mm" : overrides.optionValueName,
        profile:
          overrides.profile === null
            ? null
            : {
                metaobjectId: "gid://shopify/Metaobject/55",
                displayName: "Pear 10 × 7 mm",
                stoneShape: "pear",
                nominalLengthMm: "10",
                nominalWidthMm: "7",
                nominalDepthMm: null,
                ...(overrides.profile ?? {}),
              },
        metafields: {
          syos_vendor_min_length_mm: null,
          syos_vendor_max_length_mm: null,
          syos_vendor_min_width_mm: null,
          syos_vendor_max_width_mm: null,
          syos_vendor_range_source: null,
          syos_compatibility_active: "true",
          ...(overrides.variant ?? {}),
        },
      },
    ],
  };
}

const only = (i: ShopifyProductCompatibilityInput) => projectProduct(i).rows[0]!;

describe("a correctly configured mounting", () => {
  const row = only(input());

  it("converts millimetres to integer micrometres", () => {
    expect(row.nominalLengthUm).toBe(10_000);
    expect(row.nominalWidthUm).toBe(7_000);
    expect(Number.isInteger(row.nominalLengthUm)).toBe(true);
  });

  it("is eligible, prong-tolerant and active, with no problems", () => {
    expect(row.problems).toEqual([]);
    expect(row.eligibleForSetYourOwnStone).toBe(true);
    expect(row.prongSetToleranceEligible).toBe(true);
    expect(row.isActive).toBe(true);
  });

  it("carries the shape and both Shopify identities", () => {
    expect(row.shape).toBe("pear");
    expect(row.shopifyProductGid).toBe(PRODUCT);
    expect(row.shopifyVariantGid).toBe(VARIANT);
    expect(row.centerSizeOptionValueId).toBe("gid://shopify/ProductOptionValue/9");
  });

  it("accepts a decimal depth", () => {
    expect(only(input({ profile: { nominalDepthMm: "4.25" } })).nominalDepthUm).toBe(4_250);
  });
});

describe("every flag defaults to the safe value", () => {
  it("treats an absent eligibility flag as not eligible", () => {
    const row = only(input({ product: { syos_eligible: null } }));
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("treats an absent prong flag as no allowance", () => {
    // Silence must never grant a fit allowance.
    const row = only(
      input({ product: { syos_prong_adjustable: null, syos_prong_tolerance_eligible: null } })
    );
    expect(row.prongSetToleranceEligible).toBe(false);
  });

  it("reads only the literal string true as true", () => {
    for (const value of ["1", "yes", "TRUE ", "on", ""]) {
      const row = only(input({ product: { syos_eligible: value } }));
      expect(row.eligibleForSetYourOwnStone, `value ${JSON.stringify(value)}`).toBe(
        value.trim().toLowerCase() === "true"
      );
    }
  });

  it("treats an absent compatibility-active flag as inactive", () => {
    expect(only(input({ variant: { syos_compatibility_active: null } })).isActive).toBe(false);
  });
});

describe("the two prong flags must agree", () => {
  it("refuses the allowance when tolerance is on but adjustable is off", () => {
    // Resolving this silently either way would be guessing about whether a
    // bench can open the setting.
    const row = only(input({ product: { syos_prong_adjustable: "false" } }));
    expect(row.prongSetToleranceEligible).toBe(false);
    expect(row.problems.join(" ")).toMatch(/both agree/i);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags a non-prong setting style carrying the allowance", () => {
    const row = only(input({ product: { syos_setting_style: "bezel" } }));
    expect(row.problems.join(" ")).toMatch(/prong settings only/i);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("is content with a bezel setting that claims no allowance", () => {
    const row = only(
      input({
        product: {
          syos_setting_style: "bezel",
          syos_prong_adjustable: "false",
          syos_prong_tolerance_eligible: "false",
        },
      })
    );
    expect(row.problems).toEqual([]);
    expect(row.eligibleForSetYourOwnStone).toBe(true);
    expect(row.prongSetToleranceEligible).toBe(false);
  });
});

describe("shape comes from the profile, and the declaration is checked against it", () => {
  it("takes the shape from the linked profile", () => {
    expect(only(input()).shape).toBe("pear");
  });

  it("flags a profile with no shape", () => {
    const row = only(input({ profile: { stoneShape: null } }));
    expect(row.problems.join(" ")).toMatch(/has no Stone Shape/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags a profile shape the matcher does not know", () => {
    const row = only(input({ profile: { stoneShape: "trillion" } }));
    expect(row.problems.join(" ")).toMatch(/matching does not understand/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("accepts a profile shape in any casing", () => {
    expect(only(input({ profile: { stoneShape: "Pear" } })).shape).toBe("pear");
  });

  it("flags a pear mounting wired to an oval profile, and the PROFILE wins", () => {
    // The exact mistake the duplicated product-level shape exists to catch.
    const row = only(
      input({ product: { syos_stone_shape: "pear" }, profile: { stoneShape: "oval" } })
    );
    expect(row.problems.join(" ")).toMatch(/is linked to a/);
    expect(row.problems.join(" ")).toMatch(/profile is authoritative/);
    expect(row.shape).toBe("oval");
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags an unusable product declaration without letting it decide", () => {
    const row = only(input({ product: { syos_stone_shape: "trillion" } }));
    expect(row.problems.join(" ")).toMatch(/not one of the shapes/);
    expect(row.shape).toBe("pear");
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("is content when the product declares nothing at all", () => {
    const row = only(input({ product: { syos_stone_shape: null } }));
    expect(row.problems).toEqual([]);
    expect(row.shape).toBe("pear");
    expect(row.eligibleForSetYourOwnStone).toBe(true);
  });
});

describe("an unlinked configuration is a misconfiguration, not a fallback", () => {
  it("refuses to guess when no profile is linked", () => {
    const row = only(input({ profile: null }));
    expect(row.problems.join(" ")).toMatch(/not linked to a Center Stone Size Profile/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
    expect(row.centerSizeProfileId).toBeNull();
  });

  it("does NOT fall back to the option label, even when the label looks perfect", () => {
    const row = only(input({ profile: null, optionValueName: "10 × 7 mm" }));
    expect(row.eligibleForSetYourOwnStone).toBe(false);
    expect(row.nominalLengthUm).toBe(1);
  });
});

describe("the profile display name", () => {
  it("is required, because without it the option shows an app identifier", () => {
    const row = only(input({ profile: { displayName: null } }));
    expect(row.problems.join(" ")).toMatch(/no Display Name/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });
});

describe("nominal dimensions come from the profile", () => {
  it("records which profile supplied them", () => {
    // So a profile edit can find every row it must re-project.
    expect(only(input()).centerSizeProfileId).toBe("gid://shopify/Metaobject/55");
  });

  it("flags a missing length, and stays ineligible", () => {
    const row = only(input({ profile: { nominalLengthMm: null } }));
    expect(row.problems.join(" ")).toMatch(/has no Nominal Stone Length/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it.each([["10.3mm"], ["1e2"], ["10.1234"], ["-5"], ["0"], ["abc"], ["10,3"], ["about 10"]])(
    "flags %s rather than truncating it",
    (value) => {
      const row = only(input({ profile: { nominalLengthMm: value } }));
      expect(row.problems.join(" ")).toMatch(/not a measurement in millimetres/);
      expect(row.eligibleForSetYourOwnStone).toBe(false);
    }
  );

  it("flags a dimension of 100 mm or more", () => {
    // Catches micrometres typed into a millimetre field, which would store a
    // plausible-looking integer.
    const row = only(input({ profile: { nominalLengthMm: "10250" } }));
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags swapped length and width", () => {
    const row = only(input({ profile: { nominalLengthMm: "7", nominalWidthMm: "10" } }));
    expect(row.problems.join(" ")).toMatch(/swapped/i);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("allows equal length and width, which is what a round stone is", () => {
    const row = only(
      input({
        product: { syos_stone_shape: "round" },
        profile: { stoneShape: "round", nominalLengthMm: "6", nominalWidthMm: "6" },
        optionValueName: "6 mm",
      })
    );
    expect(row.problems).toEqual([]);
  });
});

describe("the vendor range is all four bounds or none", () => {
  const FULL = {
    syos_vendor_min_length_mm: "9.8",
    syos_vendor_max_length_mm: "10.3",
    syos_vendor_min_width_mm: "6.8",
    syos_vendor_max_width_mm: "7.2",
    syos_vendor_range_source: "Stuller spec sheet p.4",
  };

  it("accepts all four with a source", () => {
    const row = only(input({ variant: FULL }));
    expect(row.problems).toEqual([]);
    expect(row.minLengthUm).toBe(9_800);
    expect(row.maxWidthUm).toBe(7_200);
    expect(row.vendorRangeSource).toBe("Stuller spec sheet p.4");
    expect(row.eligibleForSetYourOwnStone).toBe(true);
  });

  it("flags a partial range and stores none of it", () => {
    // The matcher ignores a partial range, so storing one would look like a
    // restriction is in force when none is.
    const row = only(
      input({ variant: { syos_vendor_min_length_mm: "9.8", syos_vendor_max_length_mm: "10.3" } })
    );
    expect(row.problems.join(" ")).toMatch(/Vendor range is incomplete — 2 of 4/);
    expect(row.minLengthUm).toBeNull();
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("requires a source, because the range outranks every rule of ours", () => {
    const { syos_vendor_range_source: _dropped, ...noSource } = FULL;
    const row = only(input({ variant: { ...noSource, syos_vendor_range_source: null } }));
    expect(row.problems.join(" ")).toMatch(/Vendor Range Source is required/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags a maximum below its minimum", () => {
    const row = only(
      input({ variant: { ...FULL, syos_vendor_min_length_mm: "10.5", syos_vendor_max_length_mm: "10.0" } })
    );
    expect(row.problems.join(" ")).toMatch(/Max Length is below Vendor Min Length/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("flags unparseable bounds", () => {
    const row = only(input({ variant: { ...FULL, syos_vendor_min_width_mm: "about 7" } }));
    expect(row.problems.join(" ")).toMatch(/not measurements in millimetres/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });
});

describe("the label is cross-checked, never trusted", () => {
  it("flags a label that disagrees with the structured dimensions", () => {
    const row = only(input({ optionValueName: "9 × 6 mm" }));
    expect(row.problems.join(" ")).toMatch(/does not match the structured dimensions/);
    expect(row.problems.join(" ")).toMatch(/structured values are authoritative/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });

  it("NEVER adopts the label's numbers", () => {
    // The whole point. Even while complaining, the stored dimensions are the
    // metafields', not the label's.
    const row = only(input({ optionValueName: "9 × 6 mm" }));
    expect(row.nominalLengthUm).toBe(10_000);
    expect(row.nominalWidthUm).toBe(7_000);
  });

  it("accepts a label with no dimensions in it at all", () => {
    // "Petite" or "Size B" is a legitimate label, not a misconfiguration.
    expect(only(input({ optionValueName: "Petite" })).problems).toEqual([]);
    expect(only(input({ optionValueName: null })).problems).toEqual([]);
  });

  it("accepts the common spellings of the same size", () => {
    for (const label of ["10 × 7 mm", "10x7mm", "10 x 7", "10.000 × 7.000 mm"]) {
      expect(only(input({ optionValueName: label })).problems, label).toEqual([]);
    }
  });

  it("cannot be used to supply a missing dimension", () => {
    // A label that reads "10 × 7 mm" does not rescue an unset metafield.
    const row = only(input({ profile: { nominalLengthMm: null }, optionValueName: "10 × 7 mm" }));
    expect(row.problems.join(" ")).toMatch(/has no Nominal Stone Length/);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });
});

describe("product status gates everything", () => {
  it.each([["DRAFT"], ["ARCHIVED"]])("makes a %s product ineligible without calling it broken", (status) => {
    const row = only(input({ productStatus: status }));
    // Not a misconfiguration — a deliberate state. So no problem is recorded,
    // but nothing is offered either.
    expect(row.problems).toEqual([]);
    expect(row.eligibleForSetYourOwnStone).toBe(false);
  });
});

describe("product-level problems reach every variant", () => {
  it("attaches a bad shape to all configurations", () => {
    const base = input({ product: { syos_stone_shape: "trillion" } });
    const two: ShopifyProductCompatibilityInput = {
      ...base,
      variants: [
        base.variants[0]!,
        { ...base.variants[0]!, variantGid: "gid://shopify/ProductVariant/333" },
      ],
    };

    const result = projectProduct(two);
    expect(result.rows).toHaveLength(2);
    expect(result.productProblems.join(" ")).toMatch(/not one of the shapes/);
    for (const row of result.rows) {
      expect(row.eligibleForSetYourOwnStone).toBe(false);
    }
  });

  it("returns no rows for a product with no variants", () => {
    const result = projectProduct({ ...input(), variants: [] });
    expect(result.rows).toEqual([]);
  });
});

describe("dimensionsClaimedByLabel", () => {
  it("reads the forms a jeweller actually types", () => {
    expect(dimensionsClaimedByLabel("10 × 7 mm")).toEqual({ lengthUm: 10_000, widthUm: 7_000 });
    expect(dimensionsClaimedByLabel("10.25x7.08")).toEqual({ lengthUm: 10_250, widthUm: 7_080 });
  });

  it("returns null for anything else, rather than guessing", () => {
    for (const label of ["Petite", "", "10", "10 × 7 × 4 mm", "about 10 x 7"]) {
      expect(dimensionsClaimedByLabel(label), label).toBeNull();
    }
    expect(dimensionsClaimedByLabel(null)).toBeNull();
  });
});

describe("umToMm", () => {
  it("renders a nominal size as a human would write it", () => {
    expect(umToMm(10_000)).toBe("10");
    expect(umToMm(10_250)).toBe("10.25");
    expect(umToMm(7_080)).toBe("7.08");
  });
});
