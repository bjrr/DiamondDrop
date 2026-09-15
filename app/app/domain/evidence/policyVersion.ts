import { z } from "zod";

import { hashCanonicalJson } from "./hash";

export const policyVersionInputSchema = z.object({
  slug: z.string().min(1, "slug is required"),
  version: z.number().int().positive("version must be a positive integer"),
  effectiveFrom: z.date(),
  text: z.string().min(1, "text is required"),
});

export type PolicyVersionInput = z.infer<typeof policyVersionInputSchema>;

export interface PolicyVersionRecord extends PolicyVersionInput {
  contentHash: string;
}

export class InvalidPolicyVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicyVersionError";
  }
}

/**
 * Validates policy version input and derives its content hash from the
 * exact text being stored (spec §0.5). "Editing" a live policy must always
 * mean creating a new row with an incremented `version` — never mutating an
 * existing one. The append-only database trigger (see
 * prisma/migrations/20260913000100_append_only_evidence_triggers) enforces
 * that at the database level; this function only guarantees the hash
 * always matches the text actually persisted.
 */
export function buildPolicyVersionRecord(input: unknown): PolicyVersionRecord {
  const result = policyVersionInputSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidPolicyVersionError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
    );
  }
  return { ...result.data, contentHash: hashCanonicalJson(result.data.text) };
}
