import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money";

import { canonicalJsonStringify, NonCanonicalizableValueError } from "./canonicalJson";
import { hashCanonicalJson } from "./hash";

describe("canonicalJsonStringify", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it("preserves array order (arrays are not sorted)", () => {
    const a = [3, 1, 2];
    const b = [1, 2, 3];
    expect(canonicalJsonStringify(a)).not.toBe(canonicalJsonStringify(b));
  });

  it("sorts keys recursively inside arrays of objects", () => {
    const a = [{ b: 1, a: 2 }];
    const b = [{ a: 2, b: 1 }];
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it("differs when any nested value differs", () => {
    const a = { x: { y: 1 } };
    const b = { x: { y: 2 } };
    expect(canonicalJsonStringify(a)).not.toBe(canonicalJsonStringify(b));
  });

  // Finding 4 (architect review, 2026-09-14): sortKeysDeep must not rebuild
  // a value from its own enumerable keys alone -- that silently destroys a
  // Date (no own enumerable keys -> `{}`) and throws deep inside
  // JSON.stringify on Money's raw bigint field.
  describe("Date handling", () => {
    it("serializes a Date via its own toJSON(), never as an empty object", () => {
      const date = new Date("2026-09-14T12:00:00.000Z");
      const json = canonicalJsonStringify({ occurredAt: date });
      expect(json).toBe(`{"occurredAt":"2026-09-14T12:00:00.000Z"}`);
      expect(json).not.toContain("{}");
    });

    it("hashes a payload containing a Date deterministically", () => {
      const a = { occurredAt: new Date("2026-09-14T12:00:00.000Z"), amount: 100 };
      const b = { amount: 100, occurredAt: new Date("2026-09-14T12:00:00.000Z") };
      expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
    });

    it("produces a different hash when the Date differs", () => {
      const a = { occurredAt: new Date("2026-09-14T12:00:00.000Z") };
      const b = { occurredAt: new Date("2026-09-15T12:00:00.000Z") };
      expect(hashCanonicalJson(a)).not.toBe(hashCanonicalJson(b));
    });
  });

  describe("Money handling", () => {
    it("serializes Money losslessly via its own toJSON(), rather than throwing on the raw bigint", () => {
      const price = Money.fromMinorUnits(999_99n, "USD");
      const json = canonicalJsonStringify({ price });
      expect(json).toBe(`{"price":{"amountMinorUnits":"99999","currency":"USD"}}`);
    });

    it("hashes a payload containing Money deterministically regardless of key order", () => {
      const a = { currency: "note", price: Money.fromMinorUnits(500n, "USD") };
      const b = { price: Money.fromMinorUnits(500n, "USD"), currency: "note" };
      expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
    });

    it("produces a different hash for a different Money amount", () => {
      const a = { price: Money.fromMinorUnits(500n, "USD") };
      const b = { price: Money.fromMinorUnits(501n, "USD") };
      expect(hashCanonicalJson(a)).not.toBe(hashCanonicalJson(b));
    });
  });

  describe("values that must fail loudly rather than corrupt silently", () => {
    it("throws on a raw bigint rather than letting JSON.stringify throw uncontrolled", () => {
      expect(() => canonicalJsonStringify({ amount: 100n })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on NaN instead of silently coercing to null", () => {
      expect(() => canonicalJsonStringify({ amount: NaN })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on Infinity instead of silently coercing to null", () => {
      expect(() => canonicalJsonStringify({ amount: Infinity })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on -Infinity instead of silently coercing to null", () => {
      expect(() => canonicalJsonStringify({ amount: -Infinity })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on an undefined-valued object key instead of silently dropping it", () => {
      expect(() => canonicalJsonStringify({ reason: undefined })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on a function value", () => {
      expect(() => canonicalJsonStringify({ handler: () => {} })).toThrow(NonCanonicalizableValueError);
    });

    it("throws on a symbol value", () => {
      expect(() => canonicalJsonStringify({ tag: Symbol("x") })).toThrow(NonCanonicalizableValueError);
    });

    it("throws when a non-representable value is nested inside an array", () => {
      expect(() => canonicalJsonStringify([1, 2, NaN])).toThrow(NonCanonicalizableValueError);
    });
  });

  // Finding 4 follow-up (architect review, 2026-09-14): honoring toJSON()
  // opened a stack-overflow path -- a payload containing itself, or a
  // toJSON() that returns its own receiver -- that must raise the named
  // error instead of blowing the stack.
  describe("circular references", () => {
    it("throws on a direct self-reference instead of overflowing the stack", () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(() => canonicalJsonStringify(cyclic)).toThrow(NonCanonicalizableValueError);
    });

    it("throws on an indirect cycle (a -> b -> a)", () => {
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = { a };
      a.b = b;
      expect(() => canonicalJsonStringify(a)).toThrow(NonCanonicalizableValueError);
    });

    it("throws on a self-referencing array", () => {
      const cyclic: unknown[] = [1, 2];
      cyclic.push(cyclic);
      expect(() => canonicalJsonStringify(cyclic)).toThrow(NonCanonicalizableValueError);
    });

    it("throws when toJSON() returns its own receiver", () => {
      const pathological = {
        toJSON() {
          return this;
        },
      };
      expect(() => canonicalJsonStringify(pathological)).toThrow(NonCanonicalizableValueError);
    });

    it("does not throw when the same object legitimately appears twice in sibling positions", () => {
      const shared = { x: 1 };
      expect(() => canonicalJsonStringify({ a: shared, b: shared })).not.toThrow();
      expect(canonicalJsonStringify({ a: shared, b: shared })).toBe(
        `{"a":{"x":1},"b":{"x":1}}`
      );
    });

    it("does not throw when the same Money instance is reused across sibling keys", () => {
      const price = Money.fromMinorUnits(500n, "USD");
      expect(() => canonicalJsonStringify({ subtotal: price, total: price })).not.toThrow();
    });
  });
});

describe("hashCanonicalJson", () => {
  it("hashes identical payloads identically regardless of key order", () => {
    const a = { price: 100, currency: "USD" };
    const b = { currency: "USD", price: 100 };
    expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
  });

  it("produces a different hash for any payload difference", () => {
    const a = { price: 100, currency: "USD" };
    const b = { price: 101, currency: "USD" };
    expect(hashCanonicalJson(a)).not.toBe(hashCanonicalJson(b));
  });

  it("hashes a bare string deterministically", () => {
    expect(hashCanonicalJson("policy text")).toBe(hashCanonicalJson("policy text"));
    expect(hashCanonicalJson("policy text")).not.toBe(hashCanonicalJson("different text"));
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    const hash = hashCanonicalJson({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});


/**
 * F-10 — evidence payloads must not carry decimal quantities as JS numbers.
 *
 * Slice 1 puts cost data into these payloads, which is exactly the condition
 * the finding anticipated. A binary double cannot hold 0.1, 2.9% or 3.45 grams
 * exactly, so a payload containing one has already lost the input it claims to
 * preserve — silently, because the value round-trips through JSON looking
 * perfectly reasonable.
 */
describe("F-10 — decimal quantities may not be JS numbers", () => {
  it("rejects a non-integer number anywhere in the payload", () => {
    expect(() => canonicalJsonStringify({ weightGrams: 3.45 })).toThrow(
      NonCanonicalizableValueError
    );
    expect(() => canonicalJsonStringify({ weightGrams: 3.45 })).toThrow(
      /decimal quantities must be exact strings/
    );
  });

  it("rejects one nested inside arrays and objects", () => {
    // The hazard is not at the top level — it is buried in a breakdown.
    expect(() => canonicalJsonStringify({ stones: [{ carat: 0.75 }] })).toThrow(/F-10/);
    expect(() => canonicalJsonStringify({ a: { b: { c: [1, 2, 2.5] } } })).toThrow(/F-10/);
  });

  it("names the classic float that cannot be represented", () => {
    expect(() => canonicalJsonStringify({ rate: 0.1 })).toThrow(/non-integer number 0.1/);
  });

  it("ALLOWS integers, which are exact and meaningless as strings", () => {
    // Counts, positions, versions and basis points. Rejecting these would push
    // people to stringify things that were never at risk.
    expect(canonicalJsonStringify({ quantity: 3, profileVersion: 2, deltaBps: -250 })).toBe(
      '{"deltaBps":-250,"profileVersion":2,"quantity":3}'
    );
  });

  it("allows the exact-string form that replaces a float", () => {
    expect(canonicalJsonStringify({ weightGrams: "3.4500" })).toBe('{"weightGrams":"3.4500"}');
  });

  it("still rejects non-finite numbers, and says something different", () => {
    // Two distinct failures; conflating them would make the message unhelpful.
    expect(() => canonicalJsonStringify({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify({ x: 1.5 })).toThrow(/non-integer/);
  });
});