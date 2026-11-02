/**
 * The CaratForUs SKU transformation: a +3 shift applied to every vendor SKU.
 *
 * Authoritative requirements: owner decision 2026-11-02, store-wide.
 *
 * ---------------------------------------------------------------------------
 * ONE STORE, ONE RULE
 * ---------------------------------------------------------------------------
 * Every vendor/manufacturer SKU is transformed before it becomes Shopify's
 * normal variant `sku` or reaches a customer. George's Mountings, Kira, future
 * vendors, SYOS mountings, Buy Now merchandise — the same transformation, with
 * no per-vendor schemes.
 *
 *   letters  forward 3 in the alphabet, wrapping (X→A, Y→B, Z→C), case kept
 *   digits   +3 with wraparound (0→3 … 7→0, 8→1, 9→2)
 *   anything else  unchanged — symbols, punctuation, hyphens, underscores,
 *                  slashes, periods, spaces, separators
 *
 * Canonical: `KJ10249N` → `NM43572Q`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INVERSE EXISTS HERE TOO
 * ---------------------------------------------------------------------------
 * Not to recover a vendor SKU for operational use — the untransformed SKU is
 * retained in `carat.vendor_sku` precisely so nothing has to decode anything.
 * The inverse exists so a migration can PROVE a round trip before writing, and
 * so `looksTransformedFrom` can answer "has this already been converted?"
 * without a guess.
 *
 * ---------------------------------------------------------------------------
 * THE DOUBLE-TRANSFORM HAZARD
 * ---------------------------------------------------------------------------
 * Applying the shift twice yields a +6 SKU that is still well-formed and still
 * unique, so nothing downstream would complain — it would simply be wrong, on
 * every label and every customer-facing surface, with no error anywhere.
 *
 * The defence is structural rather than a flag: the transformation always
 * derives from the RETAINED vendor SKU, never from the current Shopify SKU.
 * `caratSkuFor` takes the vendor SKU as its only input, so a repricing,
 * re-import, inventory sync or theme render has nothing to re-shift. Running
 * it again on the same vendor SKU is idempotent by construction.
 *
 * PURE. No Shopify, no Prisma, no clock.
 */

/** Owner-locked 2026-11-02. A different shift would be a new rule id. */
export const CARAT_SKU_RULE_ID = "CARAT_SKU_SHIFT_PLUS_3_V1" as const;
const SHIFT = 3;

const UPPER_A = 65; // 'A'
const LOWER_A = 97; // 'a'
const ALPHABET = 26;
const DIGIT_0 = 48; // '0'
const DIGITS = 10;

/** One character, shifted. Everything that is not A-Z, a-z or 0-9 is returned
 *  untouched — that is the rule, not an oversight. */
function shiftChar(ch: string, by: number): string {
  const code = ch.charCodeAt(0);
  // Normalised into 0..25 / 0..9 then rotated, so the wrap is arithmetic
  // rather than a special case for X, Y and Z.
  const rotate = (base: number, span: number) =>
    String.fromCharCode(base + (((code - base + by) % span) + span) % span);

  if (code >= UPPER_A && code < UPPER_A + ALPHABET) return rotate(UPPER_A, ALPHABET);
  if (code >= LOWER_A && code < LOWER_A + ALPHABET) return rotate(LOWER_A, ALPHABET);
  if (code >= DIGIT_0 && code < DIGIT_0 + DIGITS) return rotate(DIGIT_0, DIGITS);
  return ch;
}

function shiftAll(value: string, by: number): string {
  // Array.from, not split(""), so a character outside the BMP is moved as one
  // unit instead of being torn into surrogate halves.
  return Array.from(value).map((ch) => shiftChar(ch, by)).join("");
}

export class InvalidVendorSkuError extends Error {
  constructor(readonly value: unknown, readonly why: string) {
    super(`Cannot transform vendor SKU ${JSON.stringify(value)}: ${why}`);
    this.name = "InvalidVendorSkuError";
  }
}

/**
 * The CaratForUs SKU for a vendor SKU.
 *
 * Takes the VENDOR SKU and nothing else. That signature is the no-double-
 * transform guarantee: there is no way to hand this the current Shopify SKU
 * and have it shift an already-shifted value, because callers have only the
 * retained original to give it.
 */
export function caratSkuFor(vendorSku: string): string {
  if (typeof vendorSku !== "string") throw new InvalidVendorSkuError(vendorSku, "not a string");
  // NOT trimmed, NOT case-folded, NOT normalised. A vendor SKU is an identifier
  // we must be able to hand back to the vendor unchanged; silently tidying it
  // would make our record of it disagree with theirs.
  if (vendorSku === "") throw new InvalidVendorSkuError(vendorSku, "empty");
  return shiftAll(vendorSku, SHIFT);
}

/** The reverse shift. For verification and migration safety only. */
export function vendorSkuFrom(caratSku: string): string {
  if (typeof caratSku !== "string") throw new InvalidVendorSkuError(caratSku, "not a string");
  if (caratSku === "") throw new InvalidVendorSkuError(caratSku, "empty");
  return shiftAll(caratSku, -SHIFT);
}

/**
 * Is `candidate` already the CaratForUs SKU for `vendorSku`?
 *
 * Used by migration to stay idempotent: a variant already holding the right
 * value is left alone rather than rewritten, and — more importantly — is never
 * mistaken for a raw SKU and shifted a second time.
 */
export function isCaratSkuFor(candidate: string | null | undefined, vendorSku: string): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  return candidate === caratSkuFor(vendorSku);
}

/**
 * What a migration should do with one variant, decided from the two values
 * Shopify holds rather than from a heuristic about what a SKU "looks like".
 *
 *   `migrate`      the current SKU is the raw vendor SKU; save it and shift it
 *   `already`      the current SKU is already correct for the retained vendor
 *                  SKU; touch nothing
 *   `conflict`     a vendor SKU is retained but the current SKU is neither raw
 *                  nor correctly transformed — a human decides, because
 *                  guessing here is how a SKU gets shifted twice
 *   `no_source`    nothing to derive from
 */
export type SkuMigrationAction =
  | { readonly kind: "migrate"; readonly vendorSku: string; readonly caratSku: string }
  | { readonly kind: "already"; readonly vendorSku: string; readonly caratSku: string }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "no_source"; readonly reason: string };

export interface VariantSkuState {
  /** Shopify's normal `variant.sku`. */
  readonly currentSku: string | null;
  /** `carat.vendor_sku`, when it has already been captured. */
  readonly retainedVendorSku: string | null;
  /**
   * Whether `currentSku` is a SKU the vendor actually publishes.
   *
   * Supplied by the caller from the vendor's own data, NOT inferred from the
   * string's shape. A pattern check would be a guess, and the cost of guessing
   * wrong is a double-shifted SKU that looks perfectly valid.
   */
  readonly currentSkuIsPublishedByVendor?: boolean;
}

export function planSkuMigration(state: VariantSkuState): SkuMigrationAction {
  const current = state.currentSku ?? "";
  const retained = state.retainedVendorSku ?? "";

  if (retained !== "") {
    const expected = caratSkuFor(retained);
    if (current === expected) return { kind: "already", vendorSku: retained, caratSku: expected };
    if (current === retained) return { kind: "migrate", vendorSku: retained, caratSku: expected };
    return {
      kind: "conflict",
      reason:
        `carat.vendor_sku is "${retained}" (which transforms to "${expected}") but the Shopify SKU ` +
        `is "${current}". Neither raw nor transformed — resolve by hand rather than shifting again.`,
    };
  }

  if (current === "") return { kind: "no_source", reason: "no Shopify SKU and no carat.vendor_sku" };

  // No retained SKU: the only safe reading is that the current value is the
  // raw vendor SKU, and that has to be CONFIRMED against the vendor rather
  // than assumed — otherwise an already-migrated variant whose metafield went
  // missing would be shifted a second time.
  if (state.currentSkuIsPublishedByVendor !== true) {
    return {
      kind: "no_source",
      reason:
        `no carat.vendor_sku retained, and "${current}" was not confirmed against the vendor's own ` +
        `published SKUs. Confirm the source before transforming; do not infer it from the string.`,
    };
  }
  return { kind: "migrate", vendorSku: current, caratSku: caratSkuFor(current) };
}
