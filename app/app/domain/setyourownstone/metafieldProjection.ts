/**
 * Shopify metafields → the compatibility index.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1; owner
 * direction 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PLACE SHOPIFY'S STRINGS BECOME OUR INTEGERS
 * ---------------------------------------------------------------------------
 * Every metafield value arrives as a string, because that is what GraphQL
 * metafields are. This module converts millimetre strings to integer
 * micrometres exactly once, validates everything the matcher will later rely
 * on, and produces either a usable row or a list of problems.
 *
 * PURE, AND THAT IS THE POINT. No Prisma, no Shopify client, no clock. The
 * sync handler and the reconciliation job both call this, so there is one
 * definition of "is this mounting configured correctly" rather than two that
 * drift.
 *
 * ---------------------------------------------------------------------------
 * A BAD CONFIGURATION IS RECORDED, NOT DISCARDED
 * ---------------------------------------------------------------------------
 * When something is wrong — a missing dimension, a half-specified vendor
 * range, a range with no source — the row still syncs, but as NOT ELIGIBLE
 * with its problems attached. Two reasons. Dropping it would make the
 * dashboard unable to tell "nobody has configured this yet" from "this is
 * configured wrongly", which are different jobs for different people. And a
 * silent drop is how a mounting disappears from the storefront with nobody
 * able to say why.
 *
 * The matcher never sees a problematic row as eligible, so a misconfiguration
 * costs a missing mounting, never a wrong match.
 */
import type { StoneShape } from "~/domain/setyourownstone/matching";

const SHAPES: readonly StoneShape[] = [
  "round",
  "oval",
  "cushion",
  "princess",
  "emerald",
  "radiant",
  "pear",
  "marquise",
  "asscher",
  "heart",
];

/** Centre stones, not bracelets. Also catches micrometres typed into a
 *  millimetre field, which would otherwise store a plausible integer. */
const MAX_DIMENSION_UM = 100_000;

/** What Shopify hands us for one product, already shaped by the reader. */
export interface ShopifyProductCompatibilityInput {
  readonly productGid: string;
  readonly productStatus: string;
  /** namespace-scoped metafields, key → raw string value. */
  readonly productMetafields: Readonly<Record<string, string | null>>;
  readonly variants: readonly {
    readonly variantGid: string;
    /** Shopify's own display title, e.g. "10 × 7 mm / 14K Yellow Gold / 6.5".
     *  Used ONLY to cross-check the structured data, never to obtain it. */
    readonly title: string;
    /** The centre-size option value, when the product uses that option. */
    readonly centerSizeOptionValueId: string | null;
    readonly centerSizeOptionValueName: string | null;
    readonly metafields: Readonly<Record<string, string | null>>;
  }[];
}

export interface ProjectedReadySetting {
  readonly shopifyProductGid: string;
  readonly shopifyVariantGid: string;
  readonly centerSizeOptionValueId: string | null;
  readonly shape: StoneShape;
  readonly nominalLengthUm: number;
  readonly nominalWidthUm: number;
  readonly nominalDepthUm: number | null;
  readonly minLengthUm: number | null;
  readonly maxLengthUm: number | null;
  readonly minWidthUm: number | null;
  readonly maxWidthUm: number | null;
  readonly vendorRangeSource: string | null;
  readonly eligibleForSetYourOwnStone: boolean;
  readonly prongSetToleranceEligible: boolean;
  readonly isActive: boolean;
  /** Empty when the configuration is complete and coherent. Non-empty rows are
   *  forced ineligible, whatever the metafields say. */
  readonly problems: readonly string[];
}

export interface ProjectionResult {
  readonly rows: readonly ProjectedReadySetting[];
  /** Problems that belong to the product as a whole rather than one variant. */
  readonly productProblems: readonly string[];
}

// -------------------------------------------------------------------- parsing

function mmToUm(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === "") return null;
  // Strict about FORM, not just value. `parseFloat` would accept "10.3mm",
  // "1e3" and "10.3 (approx)", each of which means the value should be
  // questioned rather than silently truncated.
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const um = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isInteger(um) || um <= 0 || um > MAX_DIMENSION_UM) return null;
  return um;
}

/** Shopify writes booleans as the strings "true"/"false". Anything else —
 *  including absent — is false, which is the safe direction for every flag
 *  here: silence must never grant a fit allowance. */
function bool(raw: string | null | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true";
}

function text(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  return value === "" ? null : value;
}

/**
 * Pull the dimensions a label CLAIMS, for cross-checking only.
 *
 * This is the one place a label is read, and it never produces a stored
 * dimension — `projectProduct` compares the result against the structured
 * metafields and reports a mismatch. The distinction matters: the owner's
 * instruction is "do not parse text to DETERMINE dimensions", and validating
 * that two independent sources agree is the opposite of determining.
 *
 * Returns null when the label is not of a recognised form, which is not a
 * problem in itself — a label may legitimately read "Petite" or "Size B".
 */
export function dimensionsClaimedByLabel(
  label: string | null
): { readonly lengthUm: number; readonly widthUm: number } | null {
  if (!label) return null;
  // "10 x 7 mm", "10 × 7 mm", "10.25x7.08", with or without the unit.
  const match = label
    .trim()
    .match(/^(\d{1,2}(?:\.\d{1,3})?)\s*[x×]\s*(\d{1,2}(?:\.\d{1,3})?)\s*(?:mm)?$/i);
  if (!match) return null;
  const lengthUm = mmToUm(match[1]!);
  const widthUm = mmToUm(match[2]!);
  if (lengthUm === null || widthUm === null) return null;
  return { lengthUm, widthUm };
}

// ----------------------------------------------------------------- projection

export function projectProduct(input: ShopifyProductCompatibilityInput): ProjectionResult {
  const productProblems: string[] = [];
  const pm = input.productMetafields;

  const shapeRaw = text(pm.syos_stone_shape);
  const shape = SHAPES.find((s) => s === shapeRaw?.toLowerCase()) ?? null;
  if (shapeRaw === null) {
    productProblems.push("Stone Shape is not set.");
  } else if (shape === null) {
    productProblems.push(`Stone Shape “${shapeRaw}” is not one of the shapes matching understands.`);
  }

  const productEligible = bool(pm.syos_eligible);

  // The ±0.3 mm allowance needs BOTH flags. "Tolerance eligible" ticked on a
  // design nobody marked prong-adjustable is a contradiction, and resolving it
  // silently either way would be guessing about whether a bench can open the
  // setting.
  const prongAdjustable = bool(pm.syos_prong_adjustable);
  const toleranceEligible = bool(pm.syos_prong_tolerance_eligible);
  if (toleranceEligible && !prongAdjustable) {
    productProblems.push(
      "±0.3 mm Prong Tolerance Eligible is on but Prong Adjustable is off. The allowance is not applied until both agree."
    );
  }

  const settingStyle = text(pm.syos_setting_style);
  if (toleranceEligible && settingStyle !== null && settingStyle.toLowerCase() !== "prong") {
    productProblems.push(
      `Setting Style is “${settingStyle}” but the ±0.3 mm allowance is on. The allowance is for prong settings only.`
    );
  }

  // Not ACTIVE is not a misconfiguration — it is a deliberate state — but it
  // does mean nothing here should be offered.
  const productActive = input.productStatus === "ACTIVE";

  const rows = input.variants.map((variant) => {
    const problems: string[] = [...productProblems];
    const vm = variant.metafields;

    const nominalLengthUm = mmToUm(vm.syos_nominal_length_mm);
    const nominalWidthUm = mmToUm(vm.syos_nominal_width_mm);

    if (vm.syos_nominal_length_mm === null || vm.syos_nominal_length_mm === undefined || String(vm.syos_nominal_length_mm).trim() === "") {
      problems.push("Nominal Stone Length (mm) is not set.");
    } else if (nominalLengthUm === null) {
      problems.push(`Nominal Stone Length “${vm.syos_nominal_length_mm}” is not a measurement in millimetres.`);
    }

    if (vm.syos_nominal_width_mm === null || vm.syos_nominal_width_mm === undefined || String(vm.syos_nominal_width_mm).trim() === "") {
      problems.push("Nominal Stone Width (mm) is not set.");
    } else if (nominalWidthUm === null) {
      problems.push(`Nominal Stone Width “${vm.syos_nominal_width_mm}” is not a measurement in millimetres.`);
    }

    if (nominalLengthUm !== null && nominalWidthUm !== null && nominalWidthUm > nominalLengthUm) {
      problems.push("Nominal width is greater than nominal length — check whether the two are swapped.");
    }

    let nominalDepthUm: number | null = null;
    const depthRaw = vm.syos_nominal_depth_mm;
    if (depthRaw !== null && depthRaw !== undefined && String(depthRaw).trim() !== "") {
      nominalDepthUm = mmToUm(depthRaw);
      if (nominalDepthUm === null) {
        problems.push(`Nominal Stone Depth “${depthRaw}” is not a measurement in millimetres.`);
      }
    }

    // ------------------------------------------------------- vendor range
    const bounds = {
      minLengthUm: mmToUm(vm.syos_vendor_min_length_mm),
      maxLengthUm: mmToUm(vm.syos_vendor_max_length_mm),
      minWidthUm: mmToUm(vm.syos_vendor_min_width_mm),
      maxWidthUm: mmToUm(vm.syos_vendor_max_width_mm),
    };
    const boundKeys = [
      "syos_vendor_min_length_mm",
      "syos_vendor_max_length_mm",
      "syos_vendor_min_width_mm",
      "syos_vendor_max_width_mm",
    ] as const;
    const supplied = boundKeys.filter(
      (k) => vm[k] !== null && vm[k] !== undefined && String(vm[k]).trim() !== ""
    );

    let range = { minLengthUm: null, maxLengthUm: null, minWidthUm: null, maxWidthUm: null } as {
      minLengthUm: number | null;
      maxLengthUm: number | null;
      minWidthUm: number | null;
      maxWidthUm: number | null;
    };

    if (supplied.length > 0 && supplied.length < boundKeys.length) {
      // The matcher ignores a partial range, so storing one would be data that
      // silently does nothing while looking like a restriction is in force.
      problems.push(
        `Vendor range is incomplete — ${boundKeys.length - supplied.length} of 4 bounds are missing. All four are required, or none.`
      );
    } else if (supplied.length === boundKeys.length) {
      const unparsed = boundKeys.filter((k) => mmToUm(vm[k]) === null);
      if (unparsed.length > 0) {
        problems.push(`Vendor range bounds are not measurements in millimetres: ${unparsed.join(", ")}.`);
      } else {
        if (bounds.minLengthUm! > bounds.maxLengthUm!) {
          problems.push("Vendor Max Length is below Vendor Min Length.");
        }
        if (bounds.minWidthUm! > bounds.maxWidthUm!) {
          problems.push("Vendor Max Width is below Vendor Min Width.");
        }
        range = bounds as typeof range;

        if (text(vm.syos_vendor_range_source) === null) {
          problems.push(
            "Vendor Range Source is required when a range is entered — the range overrides every rule of ours, so the claim needs a source."
          );
        }
      }
    }

    // --------------------------------------- label ↔ structured data check
    //
    // The option label is display data. This compares what it CLAIMS against
    // the structured authority and reports disagreement; it never adopts the
    // label's numbers. A label with no recognisable dimensions is fine.
    const claimed = dimensionsClaimedByLabel(variant.centerSizeOptionValueName);
    if (claimed && nominalLengthUm !== null && nominalWidthUm !== null) {
      if (claimed.lengthUm !== nominalLengthUm || claimed.widthUm !== nominalWidthUm) {
        problems.push(
          `Centre-size option “${variant.centerSizeOptionValueName}” does not match the structured dimensions ` +
            `(${umToMm(nominalLengthUm)} × ${umToMm(nominalWidthUm)} mm). The structured values are authoritative; ` +
            `correct one of the two.`
        );
      }
    }

    const compatibilityActive = bool(vm.syos_compatibility_active);

    return {
      shopifyProductGid: input.productGid,
      shopifyVariantGid: variant.variantGid,
      centerSizeOptionValueId: variant.centerSizeOptionValueId,
      shape: shape ?? "round",
      // A row with problems is forced ineligible, so these placeholders are
      // never consulted by the matcher. 1µm rather than 0 because the column
      // is constrained positive.
      nominalLengthUm: nominalLengthUm ?? 1,
      nominalWidthUm: nominalWidthUm ?? 1,
      nominalDepthUm,
      ...range,
      vendorRangeSource: text(vm.syos_vendor_range_source),
      // THE GATE. Every condition must hold. A problem of any kind, a product
      // that is not ACTIVE, an unset product-level flag, or an unparseable
      // shape all mean "do not offer this".
      eligibleForSetYourOwnStone:
        problems.length === 0 && productEligible && productActive && shape !== null,
      prongSetToleranceEligible: prongAdjustable && toleranceEligible,
      isActive: compatibilityActive,
      problems,
    };
  });

  return { rows, productProblems };
}

/** Micrometres back to a readable millimetre figure, for problem messages. */
export function umToMm(um: number): string {
  return (um / 1000).toFixed(3).replace(/\.?0+$/, "");
}
