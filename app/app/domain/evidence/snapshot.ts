import { hashCanonicalJson } from "./hash";

/**
 * Evidence payload contract (Slice 0 finding F-10, docs/specs/
 * SLICE-0-FINDINGS.md; discharged by docs/specs/SLICE-1-PRICING.md §5.6,
 * §6, §8.3).
 *
 * Any decimal quantity in a `SnapshotInput.payload` is a `Money`
 * (serializing to `MoneyJSON`) or a decimal **string** — never a JS
 * `number`. Only counts, indices and enumerated integers may be JSON
 * numbers.
 *
 * This matters because a snapshot is append-only and is the evidence a
 * later dispute, refund or reproducibility check relies on. A gram weight
 * or a price-per-gram stored as a JSON `number` reintroduces binary
 * floating point into that row — and neither the money-safety scan
 * (`check-money-safety.mjs`, which only watches known lexical hazards)
 * nor the `Money` type boundary (which only guards values that actually
 * pass through the `Money` class) can see a plain `number` sitting in a
 * payload object literal. The boundary has to be enforced here, in the
 * payload's shape, not assumed from either of those defenses.
 */
export interface SnapshotInput {
  kind: string;
  /**
   * Widened to `unknown` (corrected 2026-09-14, architect review finding
   * 4 follow-up): the `JsonValue` type this used to carry never actually
   * stopped a `Date` or `Money` from reaching the hasher — it only forced
   * a caller to cast past it to pass one, which is exactly the unchecked
   * call site that caused finding 4. `hashCanonicalJson` (via
   * `canonicalJsonStringify`) is now the real guard: it canonicalizes
   * `Date`/`Money`/any `toJSON()`-bearing value correctly and throws
   * `NonCanonicalizableValueError` on anything it genuinely can't
   * represent. Let callers pass their natural payload and be validated at
   * that boundary instead of casting past a type that was never load-
   * bearing. `JsonValue` remains exported for callers that want to
   * constrain a payload shape by choice.
   */
  payload: unknown;
}

export interface SnapshotRecord extends SnapshotInput {
  contentHash: string;
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSnapshotError";
  }
}

/**
 * Computes the content hash for an immutable typed snapshot (spec §0.5).
 * Identical payloads always hash identically; any difference changes the
 * hash (acceptance criterion 10) because hashing goes through the
 * canonical-JSON serializer in canonicalJson.ts.
 */
export function buildSnapshotRecord(input: SnapshotInput): SnapshotRecord {
  if (!input.kind || input.kind.trim().length === 0) {
    throw new InvalidSnapshotError("kind is required");
  }
  return { ...input, contentHash: hashCanonicalJson(input.payload) };
}
