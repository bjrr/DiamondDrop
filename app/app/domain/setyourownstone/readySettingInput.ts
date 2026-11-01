/**
 * Validation for operator-entered ready-mount compatibility data.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE, PURE MODULE
 * ---------------------------------------------------------------------------
 * These fields decide what a customer is told about their own diamond. A
 * mistyped nominal width — 7 entered where 70 was meant, a vendor maximum
 * below its minimum, millimetres pasted from a spec sheet with a stray
 * character — must be refused at the point of entry with an explanation, not
 * stored and then quietly matched against.
 *
 * Keeping it out of the route means every rule here is testable without
 * rendering a form or authenticating an admin session, which is the only way
 * the boundary cases actually get covered.
 *
 * MILLIMETRES ARE PARSED FROM STRINGS TO INTEGER MICROMETRES, once, here. The
 * same discipline CLAUDE.md rule 6 applies to money: no float ever holds a
 * dimension, so there is no rounding argument about whether 10.3 is inside a
 * 0.3 mm allowance.
 */
import type { StoneShape } from "~/domain/setyourownstone/matching";

export const READY_SETTING_SHAPES: readonly StoneShape[] = [
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

/** Dimensions are centre stones, not bracelets. 100 mm is absurd by a wide
 *  margin and catches the "typed micrometres into the mm field" mistake. */
const MAX_DIMENSION_UM = 100_000;

export interface ReadySettingInput {
  readonly shopifyProductGid: string;
  readonly shopifyVariantGid: string;
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
}

/** Field-keyed so the form can show each message beside the input that caused
 *  it. An operator correcting six fields should not have to resubmit six
 *  times to discover the next problem. */
export type FieldErrors = Record<string, string>;

export class ReadySettingInputError extends Error {
  constructor(readonly fieldErrors: FieldErrors) {
    super("ready setting compatibility input is invalid");
    this.name = "ReadySettingInputError";
  }
}

/** A Shopify global id for the expected resource, not merely a non-empty
 *  string. A product gid pasted into the variant field would otherwise be
 *  stored and then never match anything, with no clue why. */
function parseGid(raw: unknown, resource: "Product" | "ProductVariant"): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return new RegExp(`^gid://shopify/${resource}/\\d+$`).test(value) ? value : null;
}

/**
 * Millimetres to integer micrometres.
 *
 * Deliberately strict about the FORM of the number, not just its value.
 * `parseFloat` would accept "10.3mm", "1e3" and "10.3 (approx)", each of
 * which means an operator was interrupted mid-thought and the result should
 * be questioned rather than silently truncated.
 */
function parseMm(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const micrometres = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isInteger(micrometres) || micrometres <= 0) return null;
  if (micrometres > MAX_DIMENSION_UM) return null;
  return micrometres;
}

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/** Unchecked checkboxes are absent from a form body, so absence is false. */
function parseBool(raw: unknown): boolean {
  return raw === "on" || raw === "true" || raw === true;
}

/**
 * Parse one operator submission, collecting every problem before failing.
 *
 * @param fields raw values, as they arrive from a form body
 */
export function parseReadySettingInput(fields: Record<string, unknown>): ReadySettingInput {
  const errors: FieldErrors = {};

  const shopifyProductGid = parseGid(fields.shopifyProductGid, "Product");
  if (!shopifyProductGid) {
    errors.shopifyProductGid = "Enter a Shopify product id, e.g. gid://shopify/Product/123456.";
  }

  const shopifyVariantGid = parseGid(fields.shopifyVariantGid, "ProductVariant");
  if (!shopifyVariantGid) {
    errors.shopifyVariantGid =
      "Enter a Shopify variant id, e.g. gid://shopify/ProductVariant/123456. One row per purchasable configuration.";
  }

  const shapeRaw = typeof fields.shape === "string" ? fields.shape.trim() : "";
  const shape = READY_SETTING_SHAPES.find((s) => s === shapeRaw);
  if (!shape) errors.shape = "Choose the centre-stone shape this mounting is made for.";

  const nominalLengthUm = parseMm(fields.nominalLengthMm);
  if (nominalLengthUm === null) {
    errors.nominalLengthMm = "Enter the nominal length in mm, up to 3 decimal places (e.g. 10 or 10.25).";
  }

  const nominalWidthUm = parseMm(fields.nominalWidthMm);
  if (nominalWidthUm === null) {
    errors.nominalWidthMm = "Enter the nominal width in mm, up to 3 decimal places (e.g. 7 or 7.08).";
  }

  // Length is the longer dimension by convention, and the matcher compares
  // like to like. Swapped values would match nothing and look like a bug in
  // the matching rules rather than a typo here. Round stones are equal.
  if (nominalLengthUm !== null && nominalWidthUm !== null && nominalWidthUm > nominalLengthUm) {
    errors.nominalWidthMm = "Width cannot exceed length — check whether these two are swapped.";
  }

  let nominalDepthUm: number | null = null;
  if (!isBlank(fields.nominalDepthMm)) {
    nominalDepthUm = parseMm(fields.nominalDepthMm);
    if (nominalDepthUm === null) {
      errors.nominalDepthMm = "Leave blank, or enter the depth in mm up to 3 decimal places.";
    }
  }

  // ------------------------------------------------------------ vendor range
  //
  // ALL FOUR OR NONE (§6.2). A half-specified range is not a range, and the
  // matcher ignores partial ones — so accepting a partial entry here would
  // store data that silently does nothing. Said plainly instead.
  const rangeKeys = ["minLengthMm", "maxLengthMm", "minWidthMm", "maxWidthMm"] as const;
  const supplied = rangeKeys.filter((key) => !isBlank(fields[key]));

  let minLengthUm: number | null = null;
  let maxLengthUm: number | null = null;
  let minWidthUm: number | null = null;
  let maxWidthUm: number | null = null;

  if (supplied.length > 0 && supplied.length < rangeKeys.length) {
    const missing = rangeKeys.filter((key) => isBlank(fields[key]));
    for (const key of missing) {
      errors[key] =
        "A vendor range needs all four bounds. Fill this in, or clear the range entirely and rely on the nominal size.";
    }
  } else if (supplied.length === rangeKeys.length) {
    const bound = (key: (typeof rangeKeys)[number]): number | null => {
      const um = parseMm(fields[key]);
      if (um === null) errors[key] = "Enter a measurement in mm, up to 3 decimal places.";
      return um;
    };

    minLengthUm = bound("minLengthMm");
    maxLengthUm = bound("maxLengthMm");
    minWidthUm = bound("minWidthMm");
    maxWidthUm = bound("maxWidthMm");

    if (minLengthUm !== null && maxLengthUm !== null && minLengthUm > maxLengthUm) {
      errors.maxLengthMm = "Maximum length cannot be below the minimum.";
    }
    if (minWidthUm !== null && maxWidthUm !== null && minWidthUm > maxWidthUm) {
      errors.maxWidthMm = "Maximum width cannot be below the minimum.";
    }

    // A vendor range OUTRANKS our nominal rules entirely (§6.2.1), so where
    // it came from has to be recorded. "The manufacturer said so" is the
    // whole reason it wins, and six months on that claim needs a source.
    if (isBlank(fields.vendorRangeSource)) {
      errors.vendorRangeSource =
        "Record where this range came from — it overrides the nominal size and the ±0.3 mm allowance.";
    }
  }

  const vendorRangeSource = isBlank(fields.vendorRangeSource)
    ? null
    : String(fields.vendorRangeSource).trim().slice(0, 500);

  if (Object.keys(errors).length > 0) throw new ReadySettingInputError(errors);

  return {
    shopifyProductGid: shopifyProductGid!,
    shopifyVariantGid: shopifyVariantGid!,
    shape: shape!,
    nominalLengthUm: nominalLengthUm!,
    nominalWidthUm: nominalWidthUm!,
    nominalDepthUm,
    minLengthUm,
    maxLengthUm,
    minWidthUm,
    maxWidthUm,
    vendorRangeSource,
    eligibleForSetYourOwnStone: parseBool(fields.eligibleForSetYourOwnStone),
    prongSetToleranceEligible: parseBool(fields.prongSetToleranceEligible),
    // Absent means active. A row being created is active unless the operator
    // says otherwise, matching the column default.
    isActive: fields.isActive === undefined ? true : parseBool(fields.isActive),
  };
}
