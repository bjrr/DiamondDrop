/**
 * The CaratForUs +3 SKU transformation (owner decision 2026-11-02).
 *
 * The owner's required cases are stated LITERALLY — `ABC → DEF`, `XYZ → ABC`,
 * `0123456789 → 3456789012`, `KJ10249N → NM43572Q` — rather than recomputed
 * from the shift constant. A test that re-derives its expectation from the
 * same constant it is checking passes even when the constant is wrong.
 *
 * The double-transform tests matter most. A twice-shifted SKU is still
 * well-formed and still unique, so nothing downstream would complain: it would
 * just be wrong on every label, with no error anywhere.
 */
import { describe, expect, it } from "vitest";

import {
  CARAT_SKU_RULE_ID,
  InvalidVendorSkuError,
  caratSkuFor,
  isCaratSkuFor,
  planSkuMigration,
  vendorSkuFrom,
} from "./caratSku";

describe("the owner's required cases, stated literally", () => {
  it("letters: ABC -> DEF", () => {
    expect(caratSkuFor("ABC")).toBe("DEF");
  });

  it("wraparound: XYZ -> ABC", () => {
    expect(caratSkuFor("XYZ")).toBe("ABC");
  });

  it("digits: 0123456789 -> 3456789012", () => {
    expect(caratSkuFor("0123456789")).toBe("3456789012");
  });

  it("canonical: KJ10249N -> NM43572Q", () => {
    expect(caratSkuFor("KJ10249N")).toBe("NM43572Q");
  });

  it("symbols and separators pass through untouched", () => {
    expect(caratSkuFor("-_/. ")).toBe("-_/. ");
    expect(caratSkuFor("A-B_C/D.E F")).toBe("D-E_F/G.H I");
    expect(caratSkuFor("##@@!!")).toBe("##@@!!");
  });
});

describe("the shift itself", () => {
  it("moves every letter forward exactly three", () => {
    expect(caratSkuFor("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("DEFGHIJKLMNOPQRSTUVWXYZABC");
  });

  it("preserves case, shifting each case independently", () => {
    expect(caratSkuFor("abcxyz")).toBe("defabc");
    expect(caratSkuFor("AbCxYz")).toBe("DeFaBc");
  });

  it("wraps each digit past 9", () => {
    expect(caratSkuFor("789")).toBe("012");
  });

  it("leaves accented and non-Latin characters alone", () => {
    // The rule names A-Z and 0-9. Anything else is a separator as far as this
    // is concerned, and mangling it would corrupt an identifier we owe the
    // vendor back unchanged.
    expect(caratSkuFor("É-Ω-日")).toBe("É-Ω-日");
    expect(caratSkuFor("A-É-Z")).toBe("D-É-C");
  });

  it("does not trim, case-fold or otherwise tidy the input", () => {
    // A vendor SKU must round-trip to the vendor exactly as they wrote it.
    expect(caratSkuFor("  AB  ")).toBe("  DE  ");
    expect(caratSkuFor("ab")).toBe("de");
  });

  it("refuses an empty or non-string SKU", () => {
    expect(() => caratSkuFor("")).toThrow(InvalidVendorSkuError);
    // @ts-expect-error deliberately wrong type
    expect(() => caratSkuFor(null)).toThrow(InvalidVendorSkuError);
  });

  it("stamps a versioned rule id", () => {
    expect(CARAT_SKU_RULE_ID).toBe("CARAT_SKU_SHIFT_PLUS_3_V1");
  });
});

describe("the transformation is reversible and one-to-one", () => {
  it("round-trips every required case", () => {
    for (const s of ["ABC", "XYZ", "0123456789", "KJ10249N", "A-B_C/D.E F", "R-6.5-TU-7.7x5.7 mm"]) {
      expect(vendorSkuFrom(caratSkuFor(s))).toBe(s);
    }
  });

  it("cannot map two different vendor SKUs onto one CaratForUs SKU", () => {
    // Being a bijection is why the transformation can never CREATE a SKU
    // collision: any duplicate in the output was already a duplicate in the
    // input. The audit relies on this.
    const seen = new Map();
    for (let i = 0; i < 2000; i += 1) {
      const src = `KJ${String(i).padStart(5, "0")}N-${i % 7}`;
      const out = caratSkuFor(src);
      expect(seen.has(out)).toBe(false);
      seen.set(out, src);
    }
  });
});

describe("it never double-transforms", () => {
  const VENDOR = "KJ10249N";
  const CARAT = "NM43572Q";

  it("shifting twice would be wrong AND undetectable without this rule", () => {
    // Stated so the hazard is visible: +6 is still a clean, unique SKU.
    expect(caratSkuFor(CARAT)).toBe("QP76805T");
    expect(caratSkuFor(CARAT)).not.toBe(CARAT);
  });

  it("deriving from the retained vendor SKU is idempotent", () => {
    expect(caratSkuFor(VENDOR)).toBe(CARAT);
    expect(caratSkuFor(VENDOR)).toBe(CARAT);
    expect(caratSkuFor(VENDOR)).toBe(CARAT);
  });

  it("recognises a SKU that is already correct", () => {
    expect(isCaratSkuFor(CARAT, VENDOR)).toBe(true);
    expect(isCaratSkuFor(VENDOR, VENDOR)).toBe(false);
    expect(isCaratSkuFor(null, VENDOR)).toBe(false);
    expect(isCaratSkuFor("", VENDOR)).toBe(false);
  });
});

describe("migration planning decides from stored data, never from a hunch", () => {
  const VENDOR = "R-7--7x5 mm-WG-3.09G-1ST-1.00cts--2mm";
  const CARAT = caratSkuFor(VENDOR);

  it("migrates a confirmed raw vendor SKU", () => {
    const plan = planSkuMigration({
      currentSku: VENDOR,
      retainedVendorSku: null,
      currentSkuIsPublishedByVendor: true,
    });
    expect(plan).toEqual({ kind: "migrate", vendorSku: VENDOR, caratSku: CARAT });
  });

  it("REFUSES to migrate an unconfirmed SKU rather than guessing from its shape", () => {
    // This is the guard against the worst case: an already-migrated variant
    // whose metafield went missing being shifted a second time.
    const plan = planSkuMigration({ currentSku: VENDOR, retainedVendorSku: null });
    expect(plan.kind).toBe("no_source");
    expect(plan.kind === "no_source" && plan.reason).toMatch(/not confirmed against the vendor/);
  });

  it("leaves an already-correct variant completely alone", () => {
    const plan = planSkuMigration({ currentSku: CARAT, retainedVendorSku: VENDOR });
    expect(plan).toEqual({ kind: "already", vendorSku: VENDOR, caratSku: CARAT });
  });

  it("re-running after migration is a no-op, not a second shift", () => {
    const first = planSkuMigration({
      currentSku: VENDOR, retainedVendorSku: null, currentSkuIsPublishedByVendor: true,
    });
    expect(first.kind).toBe("migrate");
    // State after that write: metafield retained, SKU transformed.
    const second = planSkuMigration({ currentSku: CARAT, retainedVendorSku: VENDOR });
    expect(second.kind).toBe("already");
    expect(second.kind === "already" && second.caratSku).toBe(CARAT);
  });

  it("re-migrates a retained SKU whose Shopify value slipped back to raw", () => {
    const plan = planSkuMigration({ currentSku: VENDOR, retainedVendorSku: VENDOR });
    expect(plan).toEqual({ kind: "migrate", vendorSku: VENDOR, caratSku: CARAT });
  });

  it("flags a conflict instead of overwriting something it cannot explain", () => {
    const plan = planSkuMigration({ currentSku: "SOMETHING-ELSE", retainedVendorSku: VENDOR });
    expect(plan.kind).toBe("conflict");
    expect(plan.kind === "conflict" && plan.reason).toMatch(/Neither raw nor transformed/);
  });

  it("flags a double-shifted SKU as a conflict, not as already-correct", () => {
    const plan = planSkuMigration({ currentSku: caratSkuFor(CARAT), retainedVendorSku: VENDOR });
    expect(plan.kind).toBe("conflict");
  });

  it("reports no source when there is nothing to derive from", () => {
    expect(planSkuMigration({ currentSku: null, retainedVendorSku: null }).kind).toBe("no_source");
    expect(planSkuMigration({ currentSku: "", retainedVendorSku: "" }).kind).toBe("no_source");
  });
});

describe("the real pilot SKUs", () => {
  it("transforms each George's SKU deterministically and reversibly", () => {
    const real = [
      "R-6.5-TU-7.7x5.7 mm-WG-1.77G-1ST-1.00cts--2mm",
      "R-7--7x5 mm-WG-3.09G-1ST-1.00cts--2mm",
      "R-6.5-HH-7.7x5.7 mm-WG-3.08G-1ST-1.00cts--2mm",
    ];
    for (const vendor of real) {
      const carat = caratSkuFor(vendor);
      expect(carat).not.toBe(vendor);
      expect(vendorSkuFrom(carat)).toBe(vendor);
      // Separators survive, so the shape stays recognisable to staff.
      expect(carat.split("-").length).toBe(vendor.split("-").length);
      expect((carat.match(/ /g) ?? []).length).toBe((vendor.match(/ /g) ?? []).length);
    }
  });

  it("obscures the gram-weight segment a customer must not read", () => {
    // Owner §6: a George's gram weight must never be customer-facing. The
    // transformation is not a privacy mechanism, but it does mean "1.77G" does
    // not appear verbatim in the SKU a customer sees.
    const carat = caratSkuFor("R-6.5-TU-7.7x5.7 mm-WG-1.77G-1ST-1.00cts--2mm");
    expect(carat).not.toContain("1.77G");
    expect(carat).not.toContain("3.09G");
  });
});
