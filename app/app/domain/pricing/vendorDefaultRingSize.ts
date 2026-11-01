/**
 * The vendor's default/base ring size: read ONCE at import, then never again.
 *
 * Authoritative requirements: owner direction 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * WHY A TITLE PARSER EXISTS AT ALL, AND WHY IT RUNS ONLY ONCE
 * ---------------------------------------------------------------------------
 * The vendor states the base size only in its product title — "14K Pear
 * Solitaire — Ultra Light Tulip (Size 6.5)". That size decides every
 * ring-size price adjustment, so it has to be read from somewhere.
 *
 * It is read at IMPORT TIME and written to the Shopify product metafield
 * `carat.default_ring_size`. From then on, pricing reads the metafield. The
 * title is an import source, never an operational one, for two reasons:
 *
 *  1. THE CUSTOMER-FACING TITLE WILL CHANGE. It is expected to lose the
 *     "(Size 6.5)" suffix once the listing is cleaned up. A parser in the
 *     pricing path would then silently stop finding a size — or worse, find
 *     a different number elsewhere in the title — and re-price the product.
 *  2. PARSING IS NOT A PRICING INPUT. A stored, staff-visible, pinned field
 *     can be verified by a human against the vendor source. A regex run
 *     inside a price calculation cannot.
 *
 * `vendorDefaultRingSizeFence.test.ts` enforces that nothing in the pricing
 * path calls this module.
 *
 * ---------------------------------------------------------------------------
 * IT REFUSES RATHER THAN GUESSES
 * ---------------------------------------------------------------------------
 * Every outcome other than "exactly one size, clearly stated, in range" is a
 * refusal with a reason, because the owner's rule is to stop and flag. A
 * guessed base size does not fail loudly: it produces a plausible price that
 * is wrong by $25, $40 or $100 on most variants of the mounting.
 *
 * PURE. No Shopify, no Prisma, no clock.
 */

/** The owner's ceiling for the standard mounting flow. */
export const MIN_VENDOR_RING_SIZE = 1;
export const MAX_VENDOR_RING_SIZE = 11;

export type VendorDefaultRingSize =
  | {
      readonly ok: true;
      /** Canonical decimal string, e.g. "6.5" or "7". Never "7.0". */
      readonly ringSize: string;
      /** The exact text matched, so a human can check it against the source. */
      readonly matchedText: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * A parenthesised size suffix, which is the only form treated as a statement
 * of the base size.
 *
 * DELIBERATELY NARROW. A bare "Size 7" anywhere in a title, or a loose number
 * near the word "size", would also match things that are not the base size —
 * "7 stone", "Size 7 center", a 7 mm measurement. A title that does not use
 * the parenthesised form is refused and flagged, which is cheap; a title
 * mis-read is not.
 */
const SIZE_SUFFIX = /\(\s*size\s*([0-9]+(?:\.[0-9]+)?)\s*\)/gi;

/**
 * Anything that says "size" but not in the form above. Matched separately so
 * the refusal can say "this title states a size I will not parse" rather than
 * the much weaker "no size stated" — the difference between a vendor who
 * omitted it and a vendor who wrote it as "Size 6 1/2".
 */
const UNPARSED_SIZE_MENTION = /\bsizes?\b/i;

/** Trailing zeros removed so "7.0" and "7" are one stored value, not two. */
function canonicalise(raw: string): string {
  if (!raw.includes(".")) return raw.replace(/^0+(?=\d)/, "");
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.replace(/^0+(?=\d)/, "");
}

/**
 * Extract the base ring size from the VENDOR'S original title.
 *
 * Call this exactly once, during import, and write the result to
 * `carat.default_ring_size`. Do not call it from pricing.
 */
export function extractVendorDefaultRingSize(vendorTitle: string): VendorDefaultRingSize {
  const matches = [...vendorTitle.matchAll(SIZE_SUFFIX)];

  if (matches.length === 0) {
    if (UNPARSED_SIZE_MENTION.test(vendorTitle)) {
      return {
        ok: false,
        reason:
          "the vendor title mentions a size but not as a \"(Size X)\" suffix; " +
          "read it manually and set carat.default_ring_size by hand",
      };
    }
    return {
      ok: false,
      reason:
        "the vendor title states no default ring size; stop pricing this mounting " +
        "and flag it for review",
    };
  }

  const distinct = [...new Set(matches.map((m) => canonicalise(m[1]!)))];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `the vendor title states more than one size (${distinct.join(", ")}); ` +
        `which one is the base size cannot be inferred`,
    };
  }

  const ringSize = distinct[0]!;
  // Compared as integers in tenths — ring sizes come in half steps, so tenths
  // are exact and no float comparison is needed at a boundary.
  const tenths = toTenths(ringSize);
  if (tenths === null) {
    return { ok: false, reason: `size "${ringSize}" is not a half-step ring size` };
  }
  if (tenths < MIN_VENDOR_RING_SIZE * 10 || tenths > MAX_VENDOR_RING_SIZE * 10) {
    return {
      ok: false,
      reason:
        `size ${ringSize} is outside the supported ${MIN_VENDOR_RING_SIZE}-${MAX_VENDOR_RING_SIZE} ` +
        `range for the standard mounting flow`,
    };
  }

  return { ok: true, ringSize, matchedText: matches[0]![0] };
}

/** `"6.5"` -> `65`. Returns null for anything finer than a half step. */
function toTenths(ringSize: string): number | null {
  const [whole, frac = ""] = ringSize.split(".");
  if (frac.length > 1) return null;
  const tenths = Number.parseInt(whole!, 10) * 10 + (frac === "" ? 0 : Number.parseInt(frac, 10));
  if (!Number.isInteger(tenths)) return null;
  // Whole or half sizes only: x.0 and x.5.
  if (tenths % 10 !== 0 && tenths % 10 !== 5) return null;
  return tenths;
}

/**
 * Verification step 3 of the import rule: does the value now stored in
 * `carat.default_ring_size` agree with the vendor's source title?
 *
 * Separate from extraction on purpose. The write can succeed and still be
 * wrong — a staff edit, a mis-keyed value, the wrong product — and the check
 * that catches that has to compare the stored field against the source, not
 * re-run the parser and compare it with itself.
 */
export function verifyStoredDefaultRingSize(
  storedValue: string | null,
  vendorTitle: string
): { readonly ok: true; readonly ringSize: string } | { readonly ok: false; readonly reason: string } {
  const extracted = extractVendorDefaultRingSize(vendorTitle);
  if (!extracted.ok) return extracted;

  if (storedValue === null || storedValue.trim() === "") {
    return {
      ok: false,
      reason: `carat.default_ring_size is not set; the vendor title says ${extracted.ringSize}`,
    };
  }

  const stored = toTenths(canonicalise(storedValue.trim()));
  const fromTitle = toTenths(extracted.ringSize);
  if (stored === null) {
    return { ok: false, reason: `stored value "${storedValue}" is not a half-step ring size` };
  }
  if (stored !== fromTitle) {
    return {
      ok: false,
      reason:
        `carat.default_ring_size is ${canonicalise(storedValue.trim())} but the vendor title ` +
        `says ${extracted.ringSize}`,
    };
  }
  return { ok: true, ringSize: extracted.ringSize };
}
