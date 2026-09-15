import { hashCanonicalJson } from "./hash";

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
