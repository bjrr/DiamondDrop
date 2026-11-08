/**
 * Resolving a CUSTOMER'S SELECTION to the variant it buys, and deciding what
 * the storefront is allowed to know about that resolution.
 *
 * PURE. No database, no I/O. Imports the Admin Builder's model but does not
 * modify it: the builder is finished, and a storefront integration has no
 * business reaching into it.
 *
 * ===========================================================================
 * THE LINE THIS MODULE EXISTS TO DRAW
 * ===========================================================================
 * A customer picks: Oval / 2.00 ct / Platinum / Size 7.5.
 *
 * Turning that into a price requires two things the customer must never see:
 *
 *   1. THE SIZE BAND. Size 7.5 prices from band 6.5-8. Bands are a
 *      manufacturing and pricing construct; a shopper buying a ring should
 *      see "7.5" and nothing else. Leaking band ids or band vocabulary onto
 *      the storefront would expose how we buy rather than what they get.
 *   2. THE VARIANT MAPPING. Which `MasterVariant` a configuration resolves to
 *      is internal inventory structure, and the ids are meaningless to a
 *      shopper and useful to anyone probing.
 *
 * So BOTH stay here, on the server. The browser sends the selection it made
 * from the public options contract; this resolves it; the caller prices the
 * resulting variant. The browser never receives a band value or a variant id.
 *
 * ===========================================================================
 * WHAT THE STOREFRONT *DOES* GET, AND WHY THAT IS SAFE
 * ===========================================================================
 * `validCombinations` and `optionDimensions` — straight from the frozen
 * `schemaVersion: 1` contract, which is already the public description of
 * what may be sold, and which §12 of the owner decisions forbids from
 * carrying any pricing data at all.
 *
 * The browser needs them to do one thing the server cannot do for it
 * responsively: grey out choices that cannot combine, as the shopper
 * narrows. That is a UX affordance computed from public data. It is NOT the
 * authority on what is purchasable — `resolveSelection` is, and it runs here.
 * A tampered browser can tick a disabled pill all it likes; the resolution
 * below will not find a mapping for it.
 */

import {
  configurationSignature,
  isVariantDefiningRole,
  type CampaignBuilderState,
} from "./campaignBuilder";
import type {
  GroupBuyCampaignOptions,
  GroupBuyOptionDimension,
} from "./campaignOptions";
import { isGroupBuyOptionSelectionValid } from "./campaignOptions";

/** What the browser may know about one option. No roles, no bands. */
export interface PublicOptionValue {
  readonly value: string;
  readonly label: string;
}

export interface PublicOptionDimension {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly displayOrder: number;
  readonly allowedValues: readonly PublicOptionValue[];
}

/**
 * The customer-safe projection of the frozen options contract.
 *
 * Note what is NOT here and could have been: the option's pricing role, and
 * any band assignment. The contract never carried either (they live in the
 * builder state), and this type having no field for them is what keeps it
 * that way if someone later wires the builder state into this path.
 */
export interface PublicCampaignOptions {
  readonly optionDimensions: readonly PublicOptionDimension[];
  readonly validCombinations: readonly { readonly values: Readonly<Record<string, string>> }[];
  readonly orderingFlow: readonly string[];
}

function toPublicDimension(dimension: GroupBuyOptionDimension): PublicOptionDimension {
  return {
    key: dimension.key,
    label: dimension.label,
    required: dimension.required,
    displayOrder: dimension.displayOrder,
    allowedValues: dimension.allowedValues.map((value) => ({ value: value.value, label: value.label })),
  };
}

export function toPublicCampaignOptions(options: GroupBuyCampaignOptions): PublicCampaignOptions {
  return {
    optionDimensions: [...options.optionDimensions]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(toPublicDimension),
    validCombinations: options.validCombinations.map((combination) => ({ values: combination.values })),
    orderingFlow: [...options.orderingFlow.steps],
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type SelectionResolution =
  | { readonly ok: true; readonly masterVariantId: string }
  /** The selection is not a declared purchasable combination. */
  | { readonly ok: false; readonly reason: "not_a_valid_combination" }
  /** Valid to choose, but the campaign has no variant mapped for it. */
  | { readonly ok: false; readonly reason: "no_variant_mapped" };

/**
 * The customer's selection -> the `MasterVariant` it buys.
 *
 * TWO GATES, IN THIS ORDER, and the order matters:
 *
 *   1. `isGroupBuyOptionSelectionValid` against the FROZEN contract. This is
 *      the same function the rest of the system uses to decide what is
 *      purchasable, matching on an exact key set. It runs first so that a
 *      selection which is simply not offered is refused as such, rather than
 *      falling through to a mapping lookup and being reported as an
 *      unmapped variant — two different problems with two different fixes.
 *   2. The mapping lookup, through the SAME band projection and the SAME
 *      signature function the Admin Builder used when the merchant built the
 *      mapping. Reimplementing either here would be a second definition of
 *      "which variant does this configuration sell", and the two would
 *      diverge silently, selling the wrong ring.
 *
 * NEVER GUESSES. There is no nearest-match, no partial match and no fallback
 * to "the first variant". A selection that does not resolve is refused, and
 * the caller tells the shopper the configuration is unavailable.
 */
export function resolveSelection(
  options: GroupBuyCampaignOptions,
  builderState: CampaignBuilderState,
  selection: Readonly<Record<string, string>>
): SelectionResolution {
  if (!isGroupBuyOptionSelectionValid(options, selection)) {
    return { ok: false, reason: "not_a_valid_combination" };
  }

  const signature = variantGroupSignatureForSelection(builderState, selection);
  const masterVariantId = builderState.variantMappings[signature];
  if (masterVariantId === undefined || masterVariantId.trim() === "") {
    return { ok: false, reason: "no_variant_mapped" };
  }

  return { ok: true, masterVariantId };
}

/**
 * The price-affecting projection of a selection, with size bands resolved —
 * the key the merchant's variant mapping is stored under.
 *
 * Mirrors the builder's own projection exactly: price-affecting options only,
 * and a band option contributes its BAND rather than the exact value the
 * customer chose. This is the single place the storefront performs that
 * translation, and its output never leaves the server.
 */
export function variantGroupSignatureForSelection(
  state: CampaignBuilderState,
  selection: Readonly<Record<string, string>>
): string {
  const projection: Record<string, string> = {};

  for (const option of state.options) {
    if (!isVariantDefiningRole(option.role)) continue;
    const chosen = selection[option.key];
    if (chosen === undefined) continue;

    if (option.role === "variant_defining_band") {
      const value = option.allowedValues.find((candidate) => candidate.value === chosen);
      const band = value?.bandValue;
      projection[option.key] = band !== undefined && band.trim() !== "" ? band : chosen;
    } else {
      projection[option.key] = chosen;
    }
  }

  return configurationSignature(projection);
}

/**
 * Every combination that remains reachable given a partial selection.
 *
 * The storefront uses this to decide which pills to disable as the shopper
 * narrows: an option value is selectable if at least one valid combination
 * contains it alongside everything already chosen. §16's example — Rose Gold
 * greying out once Marquise and 3ct are picked — falls straight out of it.
 *
 * Exported and tested here rather than written in the browser, so the rule
 * has one definition and the client's copy is a rendering of it. The client
 * does run the same filter over the public `validCombinations` it was sent;
 * what matters is that the SERVER refuses anything that slips through, which
 * `resolveSelection` does.
 */
export function selectableValues(
  options: PublicCampaignOptions,
  partialSelection: Readonly<Record<string, string>>
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};

  for (const dimension of options.optionDimensions) {
    const reachable = new Set<string>();

    for (const combination of options.validCombinations) {
      // A combination is compatible when it agrees with every OTHER choice
      // already made. The dimension being tested is excluded from the check,
      // because the question is "what could this one still be".
      const compatible = Object.entries(partialSelection).every(
        ([key, value]) => key === dimension.key || combination.values[key] === value
      );
      if (!compatible) continue;

      const candidate = combination.values[dimension.key];
      if (candidate !== undefined) reachable.add(candidate);
    }

    result[dimension.key] = dimension.allowedValues
      .map((value) => value.value)
      .filter((value) => reachable.has(value));
  }

  return result;
}

/** Whether every required option has been chosen. */
export function isSelectionComplete(
  options: PublicCampaignOptions,
  selection: Readonly<Record<string, string>>
): boolean {
  return options.optionDimensions
    .filter((dimension) => dimension.required)
    .every((dimension) => {
      const chosen = selection[dimension.key];
      return chosen !== undefined && chosen !== "";
    });
}
