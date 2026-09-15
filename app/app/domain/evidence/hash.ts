import { createHash } from "node:crypto";

import { canonicalJsonStringify, type JsonValue } from "./canonicalJson";

export type { JsonValue };

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonicalizes then SHA-256 hashes a JSON-serializable payload (or a bare
 * string). Takes `unknown`, matching `canonicalJsonStringify` (corrected
 * 2026-09-14) — see its doc comment.
 */
export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}
