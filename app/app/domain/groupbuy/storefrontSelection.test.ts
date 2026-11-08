import { describe, expect, it } from "vitest";

import {
  emptyCampaignBuilderState,
  buildCampaignOptionsJson,
  variantGroupsOf,
  type BuilderOption,
  type CampaignBuilderState,
} from "./campaignBuilder";
import type { GroupBuyCampaignOptions } from "./campaignOptions";
import {
  isSelectionComplete,
  resolveSelection,
  selectableValues,
  toPublicCampaignOptions,
  variantGroupSignatureForSelection,
} from "./storefrontSelection";

/**
 * THE STOREFRONT MUST BE ABLE TO CONFIGURE A RING WITHOUT LEARNING HOW WE
 * PRICE ONE.
 *
 * Two separable claims are tested here:
 *
 *   - RESOLUTION IS CORRECT. An exact ring size resolves through its band to
 *     the variant the merchant mapped, using the builder's own projection
 *     rather than a second copy of it.
 *   - RESOLUTION IS PRIVATE. Nothing the browser receives contains a band
 *     value, a variant id, a pricing role, or any of the vocabulary that
 *     would describe them.
 *
 * The second is the one a future change is most likely to break, because
 * adding a field to a read model is easy and the leak is invisible until
 * someone reads the network tab.
 */

const RING_SIZES = ["6", "6.5", "7", "7.5", "8", "8.5", "9"];
const BANDS: Readonly<Record<string, string>> = {
  "6": "band_4_6",
  "6.5": "band_6_5_8",
  "7": "band_6_5_8",
  "7.5": "band_6_5_8",
  "8": "band_6_5_8",
  "8.5": "band_8_5_11",
  "9": "band_8_5_11",
};

function ringState(): CampaignBuilderState {
  const options: BuilderOption[] = [
    {
      key: "shape",
      label: "Diamond shape",
      required: true,
      displayOrder: 1,
      role: "variant_defining",
      allowedValues: [
        { value: "oval", label: "Oval" },
        { value: "marquise", label: "Marquise" },
      ],
    },
    {
      key: "carat",
      label: "Carat weight",
      required: true,
      displayOrder: 2,
      role: "variant_defining",
      allowedValues: [
        { value: "2_00", label: "2.00 ct" },
        { value: "3_00", label: "3.00 ct" },
      ],
    },
    {
      key: "metal",
      label: "Metal",
      required: true,
      displayOrder: 3,
      role: "variant_defining",
      allowedValues: [
        { value: "platinum", label: "Platinum" },
        { value: "rose_gold", label: "Rose gold" },
      ],
    },
    {
      key: "ring_size",
      label: "Ring size",
      required: true,
      displayOrder: 4,
      role: "variant_defining_band",
      allowedValues: RING_SIZES.map((size) => ({
        value: size,
        label: `Size ${size}`,
        bandValue: BANDS[size]!,
      })),
    },
    {
      key: "engraving",
      label: "Engraving",
      required: false,
      displayOrder: 5,
      role: "customer_preference",
      allowedValues: [{ value: "none", label: "None" }],
    },
  ];

  const base: CampaignBuilderState = {
    ...emptyCampaignBuilderState(),
    productType: "Engagement ring",
    options,
  };

  const mappings: Record<string, string> = {};
  variantGroupsOf(base).forEach((group, index) => {
    mappings[group.signature] = `mv-${index}`;
  });
  return { ...base, variantMappings: mappings };
}

function contractFor(state: CampaignBuilderState): GroupBuyCampaignOptions {
  const generated = buildCampaignOptionsJson(state);
  if (!generated.ok) throw new Error("fixture contract invalid: " + generated.problems.join("; "));
  return generated.value;
}

const STATE = ringState();
const CONTRACT = contractFor(STATE);
const PUBLIC = toPublicCampaignOptions(CONTRACT);

const FULL_SELECTION = {
  shape: "oval",
  carat: "2_00",
  metal: "platinum",
  ring_size: "7.5",
  engraving: "none",
};

describe("what the browser is allowed to receive", () => {
  it("carries the options a shopper chooses from", () => {
    expect(PUBLIC.optionDimensions.map((d) => d.key)).toEqual([
      "shape",
      "carat",
      "metal",
      "ring_size",
      "engraving",
    ]);
    expect(PUBLIC.validCombinations.length).toBe(2 * 2 * 2 * 7 * 1);
  });

  it("offers EXACT ring sizes, never a band", () => {
    const size = PUBLIC.optionDimensions.find((d) => d.key === "ring_size")!;
    expect(size.allowedValues.map((v) => v.value)).toEqual(RING_SIZES);
    expect(size.allowedValues.map((v) => v.label)).toContain("Size 7.5");
  });

  it("contains no band value, variant id, or pricing vocabulary anywhere", () => {
    // The whole payload, serialised. A leak anywhere in it fails this.
    const serialised = JSON.stringify(PUBLIC);
    for (const forbidden of ["band_", "bandValue", "mv-", "variantMapping", "variant_defining", "customer_preference", "role"]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
    // And no pricing of any kind: the contract is forbidden from carrying it.
    expect(serialised.toLowerCase()).not.toContain("price");
    expect(serialised.toLowerCase()).not.toContain("margin");
  });

  it("does not reveal which options affect price", () => {
    // A shopper does not need to know that engraving is free and metal is
    // not; exposing the classification would describe our pricing model.
    const engraving = PUBLIC.optionDimensions.find((d) => d.key === "engraving")!;
    const metal = PUBLIC.optionDimensions.find((d) => d.key === "metal")!;
    expect(Object.keys(engraving).sort()).toEqual(Object.keys(metal).sort());
    expect(Object.keys(metal).sort()).toEqual(
      ["allowedValues", "displayOrder", "key", "label", "required"].sort()
    );
  });
});

describe("resolving a selection to a variant", () => {
  it("resolves an exact ring size through its band", () => {
    const resolved = resolveSelection(CONTRACT, STATE, FULL_SELECTION);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.masterVariantId).toMatch(/^mv-\d+$/);
  });

  it("sends every size in one band to the SAME variant", () => {
    // 6.5, 7, 7.5 and 8 are one band, so they price identically.
    const ids = ["6.5", "7", "7.5", "8"].map((size) => {
      const r = resolveSelection(CONTRACT, STATE, { ...FULL_SELECTION, ring_size: size });
      expect(r.ok, size).toBe(true);
      return r.ok ? r.masterVariantId : null;
    });
    expect(new Set(ids).size).toBe(1);
  });

  it("sends sizes in different bands to DIFFERENT variants", () => {
    const inBand = resolveSelection(CONTRACT, STATE, { ...FULL_SELECTION, ring_size: "8" });
    const nextBand = resolveSelection(CONTRACT, STATE, { ...FULL_SELECTION, ring_size: "8.5" });
    expect(inBand.ok && nextBand.ok).toBe(true);
    if (!inBand.ok || !nextBand.ok) return;
    expect(inBand.masterVariantId).not.toBe(nextBand.masterVariantId);
  });

  it("ignores a non-price-affecting option when choosing the variant", () => {
    // Engraving is a preference: it must not change which ring is sold.
    const a = variantGroupSignatureForSelection(STATE, FULL_SELECTION);
    const b = variantGroupSignatureForSelection(STATE, { ...FULL_SELECTION, engraving: "none" });
    expect(a).toBe(b);
    expect(a).not.toContain("engraving");
  });

  it("refuses a selection that is not a declared combination", () => {
    const resolved = resolveSelection(CONTRACT, STATE, { ...FULL_SELECTION, ring_size: "12" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_a_valid_combination");
  });

  it("refuses a partial selection rather than guessing the rest", () => {
    // The contract matches on an exact key set, so a missing option is not a
    // purchasable configuration — and must not fall back to a default.
    const partial = { shape: "oval", carat: "2_00", metal: "platinum" };
    const resolved = resolveSelection(CONTRACT, STATE, partial);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_a_valid_combination");
  });

  it("refuses a valid combination the merchant never mapped, rather than picking a variant", () => {
    // A tampered or stale client could submit a combination that is declared
    // but unmapped. Selling "the first variant" here would ship the wrong ring.
    const unmapped: CampaignBuilderState = { ...STATE, variantMappings: {} };
    const resolved = resolveSelection(CONTRACT, unmapped, FULL_SELECTION);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("no_variant_mapped");
  });

  it("is not fooled by a selection carrying an extra unknown key", () => {
    const resolved = resolveSelection(CONTRACT, STATE, { ...FULL_SELECTION, injected: "x" });
    expect(resolved.ok).toBe(false);
  });
});

describe("narrowing: which values stay selectable", () => {
  /** A campaign where one combination genuinely does not exist. */
  function narrowedCampaign() {
    const state = ringState();
    // Switch off every Rose gold + 3.00ct + Marquise configuration, which is
    // §16's worked example.
    const disabled: string[] = [];
    for (const size of RING_SIZES) {
      disabled.push(
        JSON.stringify(
          Object.entries({
            carat: "3_00",
            engraving: "none",
            metal: "rose_gold",
            ring_size: size,
            shape: "marquise",
          }).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      );
    }
    const reduced = { ...state, disabledConfigurations: disabled };
    return toPublicCampaignOptions(contractFor(reduced));
  }

  it("keeps everything selectable before anything is chosen", () => {
    const all = selectableValues(PUBLIC, {});
    expect(all.metal).toEqual(["platinum", "rose_gold"]);
    expect(all.ring_size).toEqual(RING_SIZES);
  });

  it("disables the impossible value once the shopper has narrowed (§16's example)", () => {
    const narrowed = narrowedCampaign();
    // Marquise + 3.00ct leaves only platinum.
    const remaining = selectableValues(narrowed, { shape: "marquise", carat: "3_00" });
    expect(remaining.metal).toEqual(["platinum"]);
    expect(remaining.metal).not.toContain("rose_gold");
  });

  it("leaves that same value selectable under a different narrowing", () => {
    // Rose gold is only impossible with Marquise + 3.00ct, so the disabling
    // must be a consequence of the data and not a blanket rule.
    const narrowed = narrowedCampaign();
    expect(selectableValues(narrowed, { shape: "oval", carat: "3_00" }).metal).toEqual([
      "platinum",
      "rose_gold",
    ]);
    expect(selectableValues(narrowed, { shape: "marquise", carat: "2_00" }).metal).toEqual([
      "platinum",
      "rose_gold",
    ]);
  });

  it("does not let a dimension constrain itself", () => {
    // Having picked oval, the shape list must still offer marquise —
    // otherwise the shopper could never change their mind.
    expect(selectableValues(PUBLIC, { shape: "oval" }).shape).toEqual(["oval", "marquise"]);
  });

  it("returns values in the merchant's declared order, not match order", () => {
    expect(selectableValues(PUBLIC, {}).ring_size).toEqual(RING_SIZES);
  });

  it("agrees with the server: nothing it marks unselectable can be resolved", () => {
    // The real guarantee. Whatever the client greys out, the server refuses —
    // so a tampered client gains nothing by un-greying it.
    const state = ringState();
    const disabled = RING_SIZES.map((size) =>
      JSON.stringify(
        Object.entries({
          carat: "3_00",
          engraving: "none",
          metal: "rose_gold",
          ring_size: size,
          shape: "marquise",
        }).sort(([a], [b]) => (a < b ? -1 : 1))
      )
    );
    const reduced = { ...state, disabledConfigurations: disabled };
    const contract = contractFor(reduced);

    const refused = resolveSelection(contract, reduced, {
      shape: "marquise",
      carat: "3_00",
      metal: "rose_gold",
      ring_size: "7",
      engraving: "none",
    });
    expect(refused.ok).toBe(false);
  });
});

describe("selection completeness", () => {
  it("requires every required option", () => {
    expect(isSelectionComplete(PUBLIC, FULL_SELECTION)).toBe(true);
    expect(isSelectionComplete(PUBLIC, { shape: "oval", carat: "2_00", metal: "platinum" })).toBe(false);
  });

  it("does not require an optional option", () => {
    const withoutEngraving = { ...FULL_SELECTION };
    delete (withoutEngraving as Record<string, string>).engraving;
    expect(isSelectionComplete(PUBLIC, withoutEngraving)).toBe(true);
  });

  it("treats an empty string as unchosen", () => {
    expect(isSelectionComplete(PUBLIC, { ...FULL_SELECTION, metal: "" })).toBe(false);
  });
});
