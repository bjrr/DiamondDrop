export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Raised when a value cannot be represented as canonical JSON without
 * corrupting it (corrected 2026-09-14, architect review finding 4). Evidence
 * payloads (snapshots, audit before/after, acknowledgment context) must
 * fail loudly rather than silently produce something wrong: a raw `Date`
 * rebuilt from its own enumerable keys becomes `{}`; a raw `bigint` (e.g.
 * Money's internal `amountMinorUnits`) throws deep inside `JSON.stringify`
 * with no context; `NaN`/`Infinity` are silently coerced to `null` by
 * `JSON.stringify`; `undefined` inside an object is silently dropped. All
 * of those are unacceptable for a table backing acknowledgment and
 * snapshot evidence. Also raised on a circular reference (directly or via
 * a `toJSON()` that returns its own receiver), which would otherwise
 * recurse until the stack overflows instead of failing cleanly.
 */
export class NonCanonicalizableValueError extends Error {
  constructor(reason: string) {
    super(`Value is not representable as canonical JSON: ${reason}`);
    this.name = "NonCanonicalizableValueError";
  }
}

/**
 * Produces a canonical JSON string with recursively, deterministically
 * sorted object keys, so that two payloads carrying identical data — but
 * built with keys in a different order — always serialize (and therefore
 * hash, see hash.ts) identically (spec §0.5, acceptance criterion 10).
 *
 * Takes `unknown` rather than the nominal `JsonValue` (corrected
 * 2026-09-14): `JsonValue` at the public boundary nominally rules out
 * `Date`, `Money`, `bigint`, etc., but a caller building a payload
 * dynamically will cast, and this evidence primitive must not depend on
 * every future caller getting that cast right. It either canonicalizes the
 * value correctly or throws `NonCanonicalizableValueError` — it never
 * silently corrupts.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * `seen` tracks objects currently being canonicalized on the current call
 * stack path (added on entry, removed on exit via `finally`) so that a
 * circular reference throws `NonCanonicalizableValueError` instead of
 * recursing until the stack overflows. Scoping the add/delete to each
 * recursive frame — rather than accumulating for the whole payload — is
 * what lets the *same* object legitimately appear twice in sibling
 * positions (e.g. two keys pointing at the same shared value) without
 * being mistaken for a cycle.
 */
function sortKeysDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null) return null;

  const type = typeof value;

  if (type === "bigint" || type === "function" || type === "symbol" || type === "undefined") {
    throw new NonCanonicalizableValueError(`unsupported type "${type}"`);
  }

  if (type === "number") {
    if (!Number.isFinite(value)) {
      // JSON.stringify silently turns NaN/Infinity/-Infinity into `null`,
      // which would make e.g. a corrupted price look like a legitimately
      // absent one. Fail loudly instead.
      throw new NonCanonicalizableValueError(
        `non-finite number ${String(value)} — JSON.stringify would silently turn this into null`
      );
    }
    return value as number;
  }

  if (type === "boolean" || type === "string") {
    return value as boolean | string;
  }

  // From here, type === "object" (null already handled above).
  const object = value as object;
  if (seen.has(object)) {
    throw new NonCanonicalizableValueError(
      "circular reference — a value that (directly or indirectly) contains itself cannot be canonicalized"
    );
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sortKeysDeep(item, seen));
    }

    const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJSON === "function") {
      // Honor toJSON() — the same contract JSON.stringify itself honors —
      // instead of rebuilding the value from its own enumerable keys.
      // Rebuilding from Object.keys() alone discards the prototype method:
      // a Date has no own enumerable keys and would silently canonicalize
      // as `{}`; Money's own keys expose the raw `amountMinorUnits`
      // bigint, which JSON.stringify cannot serialize at all.
      // Money.toJSON() already returns a lossless, JSON-safe
      // `{ amountMinorUnits: string, currency }`, and Date.prototype
      // .toJSON() already returns a stable ISO-8601 string, so recursing
      // on the result of toJSON() handles both (and any future domain
      // type exposing toJSON()) correctly for free.
      const result = (maybeToJSON as () => unknown).call(value);
      if (result === value) {
        // Would otherwise recurse on the identical reference forever. The
        // `seen` check below would also catch this, but this gives a
        // clearer, purpose-specific message.
        throw new NonCanonicalizableValueError(
          "toJSON() returned its own receiver, which would recurse infinitely"
        );
      }
      return sortKeysDeep(result, seen);
    }

    const record = value as Record<string, unknown>;
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) {
        // JSON.stringify silently drops an undefined-valued object key,
        // which would make evidence look complete when a field is
        // actually missing. Fail loudly instead.
        throw new NonCanonicalizableValueError(`key "${key}" has an undefined value`);
      }
      sorted[key] = sortKeysDeep(entry, seen);
    }
    return sorted;
  } finally {
    seen.delete(object);
  }
}
