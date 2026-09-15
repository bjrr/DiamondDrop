import { z } from "zod";

const nonEmptyOptional = z.string().min(1).optional();

export const acknowledgmentInputSchema = z.object({
  exactText: z.string().min(1, "exactText is required"),
  policyVersionId: z.string().min(1, "policyVersionId is required"),
  acknowledgedAt: z.date(),
  affirmativeActionLabel: z.string().min(1, "affirmativeActionLabel is required"),
  customerRef: nonEmptyOptional,
  orderRef: nonEmptyOptional,
  cartRef: nonEmptyOptional,
  campaignRef: nonEmptyOptional,
  submissionRef: nonEmptyOptional,
  productRef: nonEmptyOptional,
  variantRef: nonEmptyOptional,
  sourceIp: nonEmptyOptional,
  userAgent: nonEmptyOptional,
});

export type AcknowledgmentInput = z.infer<typeof acknowledgmentInputSchema>;

export class InvalidAcknowledgmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAcknowledgmentError";
  }
}

/**
 * Validates acknowledgment input. There is no "accepted" boolean anywhere
 * in this type, no pre-checked state, and no inference: a caller must
 * supply the exact displayed text, a policy version id, a timestamp, and a
 * non-empty label describing the affirmative action actually taken (e.g.
 * "Customer clicked 'I acknowledge this is a Final Sale purchase'"). Any
 * missing or blank required field throws — there is no default that lets a
 * caller record an acknowledgment without one (spec §0.5, acceptance
 * criterion 7).
 */
export function buildAcknowledgmentRecord(input: unknown): AcknowledgmentInput {
  const result = acknowledgmentInputSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidAcknowledgmentError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
    );
  }
  return result.data;
}
