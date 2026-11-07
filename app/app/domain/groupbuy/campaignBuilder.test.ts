import { describe, expect, it } from "vitest";

import {
  MAX_CONFIGURATIONS,
  ConfigurationSpaceTooLargeError,
  assessCampaignBuilderCompleteness,
  buildCampaignOptionsJson,
  builderStateFromCampaignOptions,
  configurationCount,
  configurationSignature,
  describeVariantGroup,
  emptyCampaignBuilderState,
  enumerateConfigurations,
  isReadyToOpen,
  MAX_DISPLAY_DETAILS,
  MAX_HIGHLIGHTS,
  MAX_OPTIONS,
  MAX_TEXT_LENGTH,
  MAX_VALUES_PER_OPTION,
  mappedVariantIds,
  normaliseOptionKey,
  parseCampaignBuilderState,
  parseConfigurationSignature,
  variantGroupsOf,
  type BuilderOption,
  type CampaignBuilderState,
} from "./campaignBuilder";
import { isGroupBuyOptionSelectionValid, validateGroupBuyCampaignOptions } from "./campaignOptions";

/**
 * The builder's job is to let a merchant configure a campaign without
 * writing JSON or knowing a variant id, and to be incapable of producing a
 * contract the locked validator would reject.
 *
 * The tests that matter most here are not the happy paths. They are:
 *
 *   - the signature cannot collide, because a collision sells the wrong
 *     variant;
 *   - the generated contract is checked by the REAL validator, so the
 *     forbidden-pricing-key backstop still applies to anything the builder
 *     emits;
 *   - nothing is ring-shaped, exercised with a bracelet rather than asserted
 *     by the absence of the word "ring";
 *   - an incomplete campaign is BLOCKED rather than opened.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** §19's case: 3 shapes x 3 carat weights x 3 metals x 15 sizes over 3 bands. */
const RING_SIZES = [
  "4", "4.5", "5", "5.5", "6",
  "6.5", "7", "7.5", "8",
  "8.5", "9", "9.5", "10", "10.5", "11",
];

/**
 * Sizes to bands, spelled out rather than compared numerically. Parsing the
 * size string to a number would trip the repository's money-safety gate,
 * which is lexical and does not care that a ring size is not money — and a
 * literal table is in any case a better fixture: it states the three bands
 * §19 names instead of deriving them from boundary arithmetic the test
 * would then be asserting against itself.
 */
const BANDS: Readonly<Record<string, string>> = {
  "4": "band_4_6", "4.5": "band_4_6", "5": "band_4_6", "5.5": "band_4_6", "6": "band_4_6",
  "6.5": "band_6_5_8", "7": "band_6_5_8", "7.5": "band_6_5_8", "8": "band_6_5_8",
  "8.5": "band_8_5_11", "9": "band_8_5_11", "9.5": "band_8_5_11",
  "10": "band_8_5_11", "10.5": "band_8_5_11", "11": "band_8_5_11",
};

function bandFor(size: string): string {
  const band = BANDS[size];
  if (band === undefined) throw new Error(`fixture has no band for size ${size}`);
  return band;
}

function engagementRingState(overrides: Partial<CampaignBuilderState> = {}): CampaignBuilderState {
  const options: BuilderOption[] = [
    {
      key: "stone_shape",
      label: "Diamond shape",
      required: true,
      displayOrder: 1,
      role: "variant_defining",
      allowedValues: [
        { value: "round", label: "Round brilliant" },
        { value: "oval", label: "Oval" },
        { value: "emerald", label: "Emerald" },
      ],
    },
    {
      key: "carat_weight",
      label: "Carat weight",
      required: true,
      displayOrder: 2,
      role: "variant_defining",
      allowedValues: [
        { value: "1_00", label: "1.00 ct" },
        { value: "1_50", label: "1.50 ct" },
        { value: "2_00", label: "2.00 ct" },
      ],
    },
    {
      key: "metal",
      label: "Metal",
      required: true,
      displayOrder: 3,
      role: "variant_defining",
      allowedValues: [
        { value: "14k_white", label: "14k white gold" },
        { value: "14k_yellow", label: "14k yellow gold" },
        { value: "platinum", label: "Platinum" },
      ],
    },
    {
      key: "ring_size",
      label: "Ring size",
      required: true,
      displayOrder: 4,
      role: "variant_defining_band",
      allowedValues: RING_SIZES.map((size) => ({ value: size, label: `Size ${size}`, bandValue: bandFor(size) })),
    },
  ];

  return {
    ...emptyCampaignBuilderState(),
    productType: "Engagement ring",
    title: "Signature Solitaire Group Buy",
    options,
    ...overrides,
  };
}

/** Mappings for every variant group, so a state can reach "ready to open". */
function mapEveryGroup(state: CampaignBuilderState): CampaignBuilderState {
  const mappings: Record<string, string> = {};
  variantGroupsOf(state).forEach((group, index) => {
    mappings[group.signature] = `variant-${index}`;
  });
  return { ...state, variantMappings: mappings };
}

// ---------------------------------------------------------------------------

describe("configuration signatures", () => {
  it("is independent of key insertion order", () => {
    expect(configurationSignature({ metal: "platinum", size: "7" })).toBe(
      configurationSignature({ size: "7", metal: "platinum" })
    );
  });

  it("cannot be forged by a value containing the separator characters", () => {
    // The failure this guards: a joined "key=value;key=value" encoding lets
    // a merchant-entered value smuggle in a separator and produce the same
    // signature as a different configuration. Signatures decide which
    // variant a configuration prices from, so a collision sells the wrong
    // item at the wrong price.
    const a = configurationSignature({ a: 'x","b","y', b: "z" });
    const b = configurationSignature({ a: "x", b: "y", c: "z" });
    expect(a).not.toBe(b);

    const c = configurationSignature({ metal: "gold;size=7" });
    const d = configurationSignature({ metal: "gold", size: "7" });
    expect(c).not.toBe(d);
  });

  it("distinguishes an empty value from an absent key", () => {
    expect(configurationSignature({ a: "" })).not.toBe(configurationSignature({}));
  });

  it("round-trips through the parser", () => {
    const values = { metal: "14k_white", ring_size: "7.5", shape: 'odd"quoted' };
    expect(parseConfigurationSignature(configurationSignature(values))).toEqual(values);
  });

  it("refuses to parse anything it did not produce", () => {
    expect(parseConfigurationSignature("not json")).toBeNull();
    expect(parseConfigurationSignature('{"a":"b"}')).toBeNull();
    expect(parseConfigurationSignature('[["a",1]]')).toBeNull();
    expect(parseConfigurationSignature('[["a","b","c"]]')).toBeNull();
  });
});

describe("internal keys", () => {
  it("prefills a usable key from a merchant's label", () => {
    expect(normaliseOptionKey("Carat Weight")).toBe("carat_weight");
    expect(normaliseOptionKey("  Diamond Shape  ")).toBe("diamond_shape");
    expect(normaliseOptionKey("Metal / Finish")).toBe("metal_finish");
  });

  it("keeps a key startable with a letter", () => {
    // A label beginning with a digit would otherwise produce a key that
    // reads as broken to whoever later looks at the JSON.
    expect(normaliseOptionKey("4 Cs")).toBe("option_4_cs");
    expect(normaliseOptionKey("!!!")).toBe("");
  });
});

describe("the engagement ring case (§19)", () => {
  const state = engagementRingState();

  it("produces one configuration per exact customer choice", () => {
    // 3 shapes x 3 weights x 3 metals x 15 sizes.
    expect(configurationCount(state.options)).toBe(405);
    expect(enumerateConfigurations(state)).toHaveLength(405);
  });

  it("collapses the 15 sizes into 3 bands, so the merchant maps 81 variants and not 405", () => {
    // 3 shapes x 3 weights x 3 metals = 27 combinations, each in 3 size
    // bands, so 81 priced variants cover 405 purchasable configurations.
    const groups = variantGroupsOf(state);
    expect(groups).toHaveLength(81);
    // Each group covers exactly the sizes in its band: 5 in band 4-6, 4 in
    // band 6.5-8, 6 in band 8.5-11. Deliberately NOT asserted as "5 each" —
    // the bands are different widths, and a test that expected them equal
    // would be pinning an arithmetic slip rather than the behaviour.
    const coverage = groups.map((group) => group.configurationSignatures.length).sort();
    expect(coverage.filter((n) => n === 4)).toHaveLength(27);
    expect(coverage.filter((n) => n === 5)).toHaveLength(27);
    expect(coverage.filter((n) => n === 6)).toHaveLength(27);
    // Every configuration is covered exactly once.
    expect(coverage.reduce((a, b) => a + b, 0)).toBe(405);
  });

  it("prices every size in a band from the same variant group", () => {
    const configurations = enumerateConfigurations(state);
    const sameBand = configurations.filter(
      (configuration) =>
        configuration.values.stone_shape === "round" &&
        configuration.values.carat_weight === "1_00" &&
        configuration.values.metal === "platinum" &&
        ["6.5", "7", "7.5", "8"].includes(configuration.values.ring_size!)
    );
    expect(sameBand).toHaveLength(4);
    expect(new Set(sameBand.map((configuration) => configuration.variantGroupSignature)).size).toBe(1);
  });

  it("prices sizes from different bands from different variant groups", () => {
    const configurations = enumerateConfigurations(state);
    const find = (size: string) =>
      configurations.find(
        (configuration) =>
          configuration.values.stone_shape === "round" &&
          configuration.values.carat_weight === "1_00" &&
          configuration.values.metal === "platinum" &&
          configuration.values.ring_size === size
      );
    // 6 is the last size of band 4-6 and 6.5 the first of band 6.5-8.
    expect(find("6")!.variantGroupSignature).not.toBe(find("6.5")!.variantGroupSignature);
  });

  it("names a variant group in words a merchant can act on", () => {
    const groups = variantGroupsOf(state);
    const described = describeVariantGroup(state, groups[0]!);
    expect(described).toContain("Diamond shape: Round brilliant");
    expect(described).toContain("Metal:");
    expect(described).toContain("Ring size: band_4_6");
    // No internal keys and no variant ids in merchant-facing text (§18).
    expect(described).not.toContain("stone_shape");
    expect(described).not.toContain("variant-");
  });

  it("generates a contract the real validator accepts", () => {
    const generated = buildCampaignOptionsJson(state);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.schemaVersion).toBe(1);
    expect(generated.value.validCombinations).toHaveLength(405);
    expect(generated.value.optionDimensions).toHaveLength(4);
  });

  it("generates combinations the storefront's own validity check accepts", () => {
    // The selection check matches by EXACT key set, so a generated
    // combination that omitted an option would be unpurchasable.
    const generated = buildCampaignOptionsJson(state);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(
      isGroupBuyOptionSelectionValid(generated.value, {
        stone_shape: "oval",
        carat_weight: "1_50",
        metal: "platinum",
        ring_size: "7.5",
      })
    ).toBe(true);
    // A size that is not offered is not purchasable.
    expect(
      isGroupBuyOptionSelectionValid(generated.value, {
        stone_shape: "oval",
        carat_weight: "1_50",
        metal: "platinum",
        ring_size: "12",
      })
    ).toBe(false);
  });

  it("is ready to open once every variant group is mapped", () => {
    const blocking = assessCampaignBuilderCompleteness(mapEveryGroup(state)).filter((p) => p.blocking);
    expect(blocking).toEqual([]);
    expect(isReadyToOpen(assessCampaignBuilderCompleteness(mapEveryGroup(state)))).toBe(true);
  });
});

describe("switching configurations off (§7)", () => {
  const state = engagementRingState();

  it("removes them from the generated contract", () => {
    const configurations = enumerateConfigurations(state);
    const disabled = configurations.slice(0, 5).map((configuration) => configuration.signature);
    const generated = buildCampaignOptionsJson({ ...state, disabledConfigurations: disabled });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.validCombinations).toHaveLength(400);
  });

  it("makes them unpurchasable", () => {
    const target = {
      stone_shape: "emerald",
      carat_weight: "2_00",
      metal: "platinum",
      ring_size: "11",
    };
    const generated = buildCampaignOptionsJson({
      ...state,
      disabledConfigurations: [configurationSignature(target)],
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(isGroupBuyOptionSelectionValid(generated.value, target)).toBe(false);
  });

  it("drops a variant group entirely once all of its configurations are off", () => {
    // Switching off all 5 sizes of one band for one shape/weight/metal
    // removes that priced group, so the merchant is not asked to map a
    // variant that cannot be bought.
    const doomed = enumerateConfigurations(state).filter(
      (configuration) =>
        configuration.values.stone_shape === "round" &&
        configuration.values.carat_weight === "1_00" &&
        configuration.values.metal === "14k_white" &&
        bandFor(configuration.values.ring_size!) === "band_4_6"
    );
    expect(doomed).toHaveLength(5);
    const reduced = {
      ...state,
      disabledConfigurations: doomed.map((configuration) => configuration.signature),
    };
    expect(variantGroupsOf(reduced)).toHaveLength(80);
  });

  it("blocks the open when everything is switched off", () => {
    const allOff = {
      ...state,
      disabledConfigurations: enumerateConfigurations(state).map((c) => c.signature),
    };
    const problems = assessCampaignBuilderCompleteness(allOff);
    expect(problems.some((p) => p.blocking && p.section === "configurations")).toBe(true);
  });
});

describe("price-affecting classification (§4)", () => {
  function withPreference(): CampaignBuilderState {
    const base = engagementRingState();
    return {
      ...base,
      options: [
        ...base.options,
        {
          key: "engraving_style",
          label: "Engraving style",
          required: false,
          displayOrder: 5,
          role: "customer_preference",
          allowedValues: [
            { value: "none", label: "No engraving" },
            { value: "script", label: "Script" },
          ],
        },
      ],
    };
  }

  it("multiplies the configurations a customer can pick", () => {
    expect(configurationCount(withPreference().options)).toBe(810);
  });

  it("but does not multiply the variants the merchant has to map", () => {
    // This is the whole point of the classification: a preference option
    // doubles the purchasable configurations and adds zero priced variants.
    expect(variantGroupsOf(withPreference())).toHaveLength(81);
  });

  it("is excluded from the public comparison table", () => {
    const generated = buildCampaignOptionsJson(withPreference());
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.tableView.columns).toEqual([
      "stone_shape",
      "carat_weight",
      "metal",
      "ring_size",
    ]);
    // ... but the customer still has to choose it, so it stays in the flow.
    expect(generated.value.orderingFlow.steps).toContain("engraving_style");
  });

  it("refuses a campaign where nothing affects price", () => {
    const state: CampaignBuilderState = {
      ...emptyCampaignBuilderState(),
      productType: "Gift card",
      options: [
        {
          key: "wrap",
          label: "Gift wrap",
          required: false,
          displayOrder: 1,
          role: "customer_preference",
          allowedValues: [{ value: "none", label: "None" }],
        },
      ],
    };
    const problems = assessCampaignBuilderCompleteness(state);
    expect(problems.some((p) => p.blocking && /affect price/i.test(p.message))).toBe(true);
  });
});

describe("size bands (§5)", () => {
  it("blocks the open until every size has a band", () => {
    const base = engagementRingState();
    const unassigned = base.options.map((option) =>
      option.key !== "ring_size"
        ? option
        : {
            ...option,
            allowedValues: option.allowedValues.map((value) =>
              value.value === "7" ? { value: value.value, label: value.label } : value
            ),
          }
    );
    const problems = assessCampaignBuilderCompleteness({ ...base, options: unassigned });
    expect(problems.some((p) => p.blocking && /size band/i.test(p.message))).toBe(true);
  });

  it("puts an unassigned size in its own group rather than guessing a band", () => {
    // §6 forbids silently guessing a mapping. Folding an unassigned size
    // into a neighbouring band would be exactly that, so it becomes its own
    // group — visibly unmapped in the mapping table.
    const base = engagementRingState();
    const unassigned: CampaignBuilderState = {
      ...base,
      options: base.options.map((option) =>
        option.key !== "ring_size"
          ? option
          : {
              ...option,
              allowedValues: option.allowedValues.map((value) =>
                value.value === "7" ? { value: value.value, label: value.label } : value
              ),
            }
      ),
    };
    // The three bands survive (6.5-8 still holds 6.5, 7.5 and 8), and size 7
    // becomes a fourth, unmapped group for each shape/weight/metal.
    expect(variantGroupsOf(unassigned)).toHaveLength(81 + 27);
  });
});

describe("variant mapping (§6)", () => {
  it("blocks the open while any group is unmapped, naming each one", () => {
    const state = engagementRingState();
    const problems = assessCampaignBuilderCompleteness(state);
    const mapping = problems.filter((p) => p.section === "variant_mapping" && p.blocking);
    expect(mapping).toHaveLength(81);
    expect(mapping[0]!.message).toMatch(/Choose the product variant for Diamond shape:/);
  });

  it("blocks the open when only some groups are mapped", () => {
    const state = engagementRingState();
    const groups = variantGroupsOf(state);
    const partial = {
      ...state,
      variantMappings: { [groups[0]!.signature]: "variant-0" },
    };
    const problems = assessCampaignBuilderCompleteness(partial);
    expect(problems.filter((p) => p.section === "variant_mapping" && p.blocking)).toHaveLength(80);
  });

  it("reports a mapping stranded by an option change instead of dropping it", () => {
    // A merchant who removes a metal still has that metal's mappings saved.
    // Silently discarding them would mean the campaign maps fewer variants
    // than the merchant believes.
    const state = mapEveryGroup(engagementRingState());
    const fewerMetals: CampaignBuilderState = {
      ...state,
      options: state.options.map((option) =>
        option.key !== "metal"
          ? option
          : { ...option, allowedValues: option.allowedValues.filter((v) => v.value !== "platinum") }
      ),
    };
    const problems = assessCampaignBuilderCompleteness(fewerMetals);
    const stale = problems.find((p) => /no longer match any available configuration/.test(p.message));
    expect(stale).toBeDefined();
    expect(stale!.blocking).toBe(false);
    // Removing platinum strands 3 shapes x 3 weights x 3 bands of mappings.
    expect(stale!.message).toContain("27 saved variant mapping(s)");
  });
});

describe("the locked contract is still the authority (§13, §15)", () => {
  it("routes every generation through the real validator, so the forbidden-key backstop still applies", () => {
    // An option key containing "price" must be refused. The builder does not
    // pre-screen for this; the generation is simply handed to
    // `validateGroupBuyCampaignOptions`, which means the backstop cannot be
    // bypassed by going through the visual editor instead of raw JSON.
    const state: CampaignBuilderState = {
      ...emptyCampaignBuilderState(),
      productType: "Ring",
      options: [
        {
          key: "price_band",
          label: "Budget",
          required: true,
          displayOrder: 1,
          role: "variant_defining",
          allowedValues: [{ value: "low", label: "Under $2,000" }],
        },
      ],
    };
    const generated = buildCampaignOptionsJson(state);
    expect(generated.ok).toBe(false);
    if (generated.ok) return;
    expect(generated.problems.join("\n")).toMatch(/"price_band" is pricing data/);
  });

  it("surfaces that rejection in the completeness report rather than at save time", () => {
    const state: CampaignBuilderState = {
      ...emptyCampaignBuilderState(),
      productType: "Ring",
      options: [
        {
          key: "margin_tier",
          label: "Tier",
          required: true,
          displayOrder: 1,
          role: "variant_defining",
          allowedValues: [{ value: "a", label: "A" }],
        },
      ],
    };
    const problems = assessCampaignBuilderCompleteness(state);
    expect(problems.some((p) => p.section === "contract" && /margin rule/.test(p.message))).toBe(true);
  });

  it("never writes a band assignment into the contract", () => {
    // `bandValue` is pricing structure. §12 keeps it out of the contract,
    // and the backstop would not catch it because the key is not named
    // "price" — so this has to be asserted directly.
    const generated = buildCampaignOptionsJson(engagementRingState());
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(JSON.stringify(generated.value)).not.toContain("bandValue");
    expect(JSON.stringify(generated.value)).not.toContain("band_6_5_8");
  });

  it("never writes a variant id into the contract", () => {
    const generated = buildCampaignOptionsJson(mapEveryGroup(engagementRingState()));
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(JSON.stringify(generated.value)).not.toContain("variant-");
  });

  it("omits optional campaign metadata rather than sending an empty string", () => {
    const generated = buildCampaignOptionsJson({ ...engagementRingState(), title: "", description: "  " });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.campaign.title).toBeUndefined();
    expect(generated.value.campaign.description).toBeUndefined();
  });
});

describe("reading an existing contract back (§13, §16)", () => {
  it("round-trips a generated contract without changing it", () => {
    const original = buildCampaignOptionsJson(engagementRingState());
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const reimported = builderStateFromCampaignOptions(original.value, engagementRingState());
    const regenerated = buildCampaignOptionsJson(reimported);
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.value).toEqual(original.value);
  });

  it("recovers which configurations were switched off", () => {
    const base = engagementRingState();
    const target = configurationSignature({
      stone_shape: "oval",
      carat_weight: "2_00",
      metal: "platinum",
      ring_size: "9",
    });
    const generated = buildCampaignOptionsJson({ ...base, disabledConfigurations: [target] });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const reimported = builderStateFromCampaignOptions(generated.value, base);
    expect(reimported.disabledConfigurations).toEqual([target]);
  });

  it("treats a legacy contract's options as price-affecting, which fails loud", () => {
    // The contract never held roles, so none can be recovered. Defaulting to
    // price-affecting means the merchant is asked to map more variant groups
    // than necessary, which is visible and blocks the open. The opposite
    // default would quietly merge real priced variants into one group.
    const legacy = validateGroupBuyCampaignOptions({
      schemaVersion: 1,
      campaign: { productType: "bracelet" },
      optionDimensions: [
        {
          key: "length",
          label: "Length",
          required: true,
          displayOrder: 1,
          allowedValues: [
            { value: "7in", label: "7 inches" },
            { value: "8in", label: "8 inches" },
          ],
        },
        {
          key: "clasp",
          label: "Clasp",
          required: true,
          displayOrder: 2,
          allowedValues: [
            { value: "lobster", label: "Lobster" },
            { value: "box", label: "Box" },
          ],
        },
      ],
      validCombinations: [
        { values: { length: "7in", clasp: "lobster" } },
        { values: { length: "7in", clasp: "box" } },
        { values: { length: "8in", clasp: "lobster" } },
        { values: { length: "8in", clasp: "box" } },
      ],
      tableView: { columns: ["length", "clasp"] },
      orderingFlow: { steps: ["length", "clasp"] },
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;

    const state = builderStateFromCampaignOptions(legacy.value);
    expect(state.options.map((option) => option.role)).toEqual(["variant_defining", "variant_defining"]);
    expect(variantGroupsOf(state)).toHaveLength(4);
    expect(assessCampaignBuilderCompleteness(state).filter((p) => p.section === "variant_mapping")).toHaveLength(4);
  });

  it("keeps roles, bands and mappings the builder already knew", () => {
    const base = mapEveryGroup(engagementRingState());
    const generated = buildCampaignOptionsJson(base);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const reimported = builderStateFromCampaignOptions(generated.value, base);
    expect(reimported.options.find((o) => o.key === "ring_size")!.role).toBe("variant_defining_band");
    expect(reimported.options.find((o) => o.key === "ring_size")!.allowedValues[0]!.bandValue).toBe("band_4_6");
    expect(reimported.variantMappings).toEqual(base.variantMappings);
    expect(isReadyToOpen(assessCampaignBuilderCompleteness(reimported))).toBe(true);
  });

  it("drops an overlaid role for an option the contract no longer declares", () => {
    const base = engagementRingState();
    const generated = buildCampaignOptionsJson(base);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const trimmed = {
      ...generated.value,
      optionDimensions: generated.value.optionDimensions.filter((d) => d.key !== "metal"),
      validCombinations: generated.value.validCombinations.map((c) => {
        const values = { ...c.values };
        delete values.metal;
        return { values };
      }),
      tableView: { columns: generated.value.tableView.columns.filter((c) => c !== "metal") },
      orderingFlow: { steps: generated.value.orderingFlow.steps.filter((s) => s !== "metal") },
    };
    const reimported = builderStateFromCampaignOptions(trimmed, base);
    expect(reimported.options.map((o) => o.key)).toEqual(["stone_shape", "carat_weight", "ring_size"]);
  });
});

describe("nothing is ring-shaped (§11 of the options contract)", () => {
  it("builds a bracelet campaign with no size band at all", () => {
    const state: CampaignBuilderState = {
      ...emptyCampaignBuilderState(),
      productType: "Tennis bracelet",
      options: [
        {
          key: "length",
          label: "Length",
          required: true,
          displayOrder: 1,
          role: "variant_defining",
          allowedValues: [
            { value: "6_5in", label: "6.5 inches" },
            { value: "7in", label: "7 inches" },
          ],
        },
        {
          key: "total_weight",
          label: "Total carat weight",
          required: true,
          displayOrder: 2,
          role: "variant_defining",
          allowedValues: [
            { value: "3ct", label: "3 ct" },
            { value: "5ct", label: "5 ct" },
          ],
        },
      ],
    };
    expect(variantGroupsOf(state)).toHaveLength(4);
    const ready = mapEveryGroup(state);
    expect(isReadyToOpen(assessCampaignBuilderCompleteness(ready))).toBe(true);
    const generated = buildCampaignOptionsJson(ready);
    expect(generated.ok).toBe(true);
  });
});

describe("the configuration space is bounded", () => {
  function hugeState(): CampaignBuilderState {
    const values = Array.from({ length: 50 }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));
    return {
      ...emptyCampaignBuilderState(),
      productType: "Ring",
      options: [1, 2, 3].map((n) => ({
        key: `dimension_${n}`,
        label: `Dimension ${n}`,
        required: true,
        displayOrder: n,
        role: "variant_defining" as const,
        allowedValues: values,
      })),
    };
  }

  it("counts without building, so an absurd option set is cheap to refuse", () => {
    expect(configurationCount(hugeState().options)).toBe(125_000);
    expect(configurationCount(hugeState().options)).toBeGreaterThan(MAX_CONFIGURATIONS);
  });

  it("throws rather than materialising 125,000 rows into an admin page", () => {
    expect(() => enumerateConfigurations(hugeState())).toThrow(ConfigurationSpaceTooLargeError);
  });

  it("reports the limit as a merchant-facing problem instead of crashing the editor", () => {
    const problems = assessCampaignBuilderCompleteness(hugeState());
    const tooLarge = problems.find((p) => p.section === "configurations");
    expect(tooLarge).toBeDefined();
    expect(tooLarge!.blocking).toBe(true);
    expect(tooLarge!.message).toContain("125000");
  });

  it("refuses the generation too, rather than returning a partial contract", () => {
    const generated = buildCampaignOptionsJson(hugeState());
    expect(generated.ok).toBe(false);
  });
});

describe("content completeness (§2)", () => {
  it("does not block an open on a missing image", () => {
    // An unattractive campaign is not an unsellable one, and blocking an
    // open on a photo would be this editor inventing a policy.
    const state = mapEveryGroup(engagementRingState());
    const problems = assessCampaignBuilderCompleteness(state);
    const content = problems.filter((p) => p.section === "content");
    expect(content.length).toBeGreaterThan(0);
    expect(content.every((p) => !p.blocking)).toBe(true);
    expect(isReadyToOpen(problems)).toBe(true);
  });

  it("blocks an over-long gallery, which is a mistake rather than a style", () => {
    const image = (n: number) => ({ fileGid: `gid://shopify/GenericFile/${n}`, url: `u${n}`, altText: "" });
    const state = mapEveryGroup(engagementRingState());
    const problems = assessCampaignBuilderCompleteness({
      ...state,
      content: { ...state.content, galleryImages: [1, 2, 3, 4, 5, 6, 7].map(image) },
    });
    expect(problems.some((p) => p.blocking && /gallery image/.test(p.message))).toBe(true);
  });

  it("blocks a half-filled display detail", () => {
    const state = mapEveryGroup(engagementRingState());
    const problems = assessCampaignBuilderCompleteness({
      ...state,
      content: { ...state.content, displayDetails: [{ label: "Production time", value: "" }] },
    });
    expect(problems.some((p) => p.blocking && /Display detail 1/.test(p.message))).toBe(true);
  });
});

describe("option hygiene", () => {
  const base = () => mapEveryGroup(engagementRingState());

  it("rejects a duplicate internal key", () => {
    const state = base();
    const problems = assessCampaignBuilderCompleteness({
      ...state,
      options: [...state.options, { ...state.options[0]!, label: "Shape again" }],
    });
    expect(problems.some((p) => /share the internal key/.test(p.message))).toBe(true);
  });

  it("rejects a repeated choice within one option", () => {
    const state = base();
    const problems = assessCampaignBuilderCompleteness({
      ...state,
      options: state.options.map((option) =>
        option.key !== "metal"
          ? option
          : { ...option, allowedValues: [...option.allowedValues, option.allowedValues[0]!] }
      ),
    });
    expect(problems.some((p) => /repeats the choice/.test(p.message))).toBe(true);
  });

  it("rejects an option with no choices", () => {
    const state = base();
    const problems = assessCampaignBuilderCompleteness({
      ...state,
      options: [
        ...state.options,
        {
          key: "finish",
          label: "Finish",
          required: false,
          displayOrder: 9,
          role: "customer_preference",
          allowedValues: [],
        },
      ],
    });
    expect(problems.some((p) => /has no choices yet/.test(p.message))).toBe(true);
  });

  it("requires a product type", () => {
    const problems = assessCampaignBuilderCompleteness({ ...base(), productType: "  " });
    expect(problems.some((p) => p.blocking && p.section === "basics")).toBe(true);
  });

  it("refuses an empty campaign outright", () => {
    const problems = assessCampaignBuilderCompleteness(emptyCampaignBuilderState());
    expect(isReadyToOpen(problems)).toBe(false);
    expect(problems.some((p) => /at least one customer option/i.test(p.message))).toBe(true);
  });
});

describe("parsing an untrusted submission", () => {
  // The editor posts the whole builder state back as one JSON field, so this
  // is the boundary between the browser and anything that prices money.
  function validPayload(): unknown {
    return JSON.parse(JSON.stringify(mapEveryGroup(engagementRingState())));
  }

  it("accepts what the editor itself produces, unchanged", () => {
    const parsed = parseCampaignBuilderState(validPayload());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.options).toHaveLength(4);
    expect(parsed.value.options[3]!.allowedValues[0]!.bandValue).toBe("band_4_6");
    expect(isReadyToOpen(assessCampaignBuilderCompleteness(parsed.value))).toBe(true);
  });

  it("refuses anything that is not an object", () => {
    for (const input of [null, undefined, 42, "state", [], true]) {
      expect(parseCampaignBuilderState(input).ok).toBe(false);
    }
  });

  it("refuses an unrecognised price setting rather than defaulting one", () => {
    // Defaulting an unknown role would silently decide whether an option
    // affects price, which is the one thing this field exists to state.
    const payload = validPayload() as any;
    payload.options[0].role = "free_text";
    const parsed = parseCampaignBuilderState(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(" ")).toMatch(/unrecognised price setting/);
  });

  it("refuses campaign imagery hosted anywhere but Shopify", () => {
    // A campaign image is rendered to customers. An arbitrary remote address
    // would have the storefront loading imagery from a host nobody vetted.
    for (const url of [
      "https://evil.example/x.png",
      "http://cdn.shopify.com/s/files/1/x.jpg", // not https
      "https://cdn.shopify.com.evil.example/x.jpg", // prefix-matching trick
      "//cdn.shopify.com/s/files/1/x.jpg",
    ]) {
      const payload = validPayload() as any;
      payload.content.heroImage = { fileGid: "", url, altText: "" };
      const parsed = parseCampaignBuilderState(payload);
      expect(parsed.ok, url).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problems.join(" ")).toMatch(/must be a Shopify Files image/);
    }
  });

  it("accepts a Shopify Files link, with or without a file id", () => {
    const withId = validPayload() as any;
    withId.content.heroImage = {
      fileGid: "gid://shopify/MediaImage/123",
      url: "https://cdn.shopify.com/s/files/1/x.jpg",
      altText: "Solitaire ring",
    };
    const parsedWithId = parseCampaignBuilderState(withId);
    expect(parsedWithId.ok).toBe(true);
    if (!parsedWithId.ok) return;
    expect(parsedWithId.value.content.heroImage?.altText).toBe("Solitaire ring");

    // The merchant copies a link rather than an id today, so an empty id is
    // the normal case and must not be refused.
    const withoutId = validPayload() as any;
    withoutId.content.heroImage = { fileGid: "", url: "https://cdn.shopify.com/s/files/1/y.jpg", altText: "" };
    expect(parseCampaignBuilderState(withoutId).ok).toBe(true);
  });

  it("refuses a file id that is not a MediaImage", () => {
    const payload = validPayload() as any;
    payload.content.heroImage = {
      // The picker is invoked with mediaTypes: [MediaImage], so a Video id
      // arriving here did not come from where it claims to.
      fileGid: "gid://shopify/Video/123",
      url: "https://cdn.shopify.com/s/files/1/x.jpg",
      altText: "",
    };
    const parsed = parseCampaignBuilderState(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(" ")).toMatch(/not a Shopify image file/);
  });

  it("refuses oversized text instead of truncating it", () => {
    // A merchant whose description came back quietly shortened would not
    // know which half survived.
    const payload = validPayload() as any;
    payload.description = "x".repeat(MAX_TEXT_LENGTH + 1);
    const parsed = parseCampaignBuilderState(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(" ")).toMatch(/longer than 2000 characters/);
  });

  it("bounds the number of options, choices, highlights and details", () => {
    const tooManyOptions = validPayload() as any;
    tooManyOptions.options = Array.from({ length: MAX_OPTIONS + 1 }, () => tooManyOptions.options[0]);
    expect(parseCampaignBuilderState(tooManyOptions).ok).toBe(false);

    const tooManyValues = validPayload() as any;
    tooManyValues.options[0].allowedValues = Array.from(
      { length: MAX_VALUES_PER_OPTION + 1 },
      (_, i) => ({ value: `v${i}`, label: `V${i}` })
    );
    expect(parseCampaignBuilderState(tooManyValues).ok).toBe(false);

    const tooManyHighlights = validPayload() as any;
    tooManyHighlights.content.highlights = Array.from({ length: MAX_HIGHLIGHTS + 1 }, () => "x");
    expect(parseCampaignBuilderState(tooManyHighlights).ok).toBe(false);

    const tooManyDetails = validPayload() as any;
    tooManyDetails.content.displayDetails = Array.from({ length: MAX_DISPLAY_DETAILS + 1 }, () => ({
      label: "a",
      value: "b",
    }));
    expect(parseCampaignBuilderState(tooManyDetails).ok).toBe(false);
  });

  it("refuses a variant mapping with no variant", () => {
    const payload = validPayload() as any;
    const firstKey = Object.keys(payload.variantMappings)[0]!;
    payload.variantMappings[firstKey] = "";
    const parsed = parseCampaignBuilderState(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join(" ")).toMatch(/no product variant/);
  });

  it("collects every problem rather than stopping at the first", () => {
    const payload = validPayload() as any;
    payload.options[0].role = "nonsense";
    payload.options[1].required = "yes";
    payload.content.highlights = "not a list";
    const parsed = parseCampaignBuilderState(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("lists the variant ids a caller still has to check against the campaign", () => {
    // parseCampaignBuilderState cannot know whether a variant belongs to this
    // campaign — that is a database fact — so the route cross-checks these.
    const state = mapEveryGroup(engagementRingState());
    expect(mappedVariantIds(state)).toHaveLength(81);

    const duplicated = { ...state, variantMappings: Object.fromEntries(
      Object.keys(state.variantMappings).map((key) => [key, "variant-same"])
    ) };
    expect(mappedVariantIds(duplicated)).toEqual(["variant-same"]);
  });
});
