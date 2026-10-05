import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  CustomJewelryFollowUpPreference,
  CustomJewelryProject,
  CustomJewelryStartingPoint,
} from "@prisma/client";

import { prisma } from "../client.server";

/**
 * Custom Jewelry intake persistence (Slice 9, README "Custom Jewelry — MVP1
 * Locked Direction").
 *
 * ============================================================================
 * PROJECT REFERENCE STRATEGY
 * ============================================================================
 * Generated here with a collision retry, mirroring
 * `warrantyClaimRepository.server.ts` deliberately — including the alphabet,
 * which drops I, L, O and U so a reference survives being read aloud to
 * support or typed from a photograph.
 *
 * A COLLISION IS NOT A DUPLICATE SUBMISSION. Two different enquiries that
 * happen to generate the same reference must both exist, so the response is a
 * fresh candidate and another attempt — never returning the other project.
 * Safety comes from the unique constraint plus retry, not from the randomness
 * alone.
 *
 * 32 characters and 256 byte values: 256 is exactly 8 x 32, so `byte % 32`
 * is uniform. That is luck worth stating, because the same construction with
 * a 30-character alphabet would be quietly biased.
 *
 * ============================================================================
 * NO MONEY, NO DEPOSIT, NO CHARGE
 * ============================================================================
 * The README is explicit that intake must "not charge the Design Deposit
 * yet". Nothing here touches payment, and the table has no payment columns to
 * touch. The $49 is a later, staff-initiated step.
 */

const PROJECT_REFERENCE_PREFIX = "CJ-";
const PROJECT_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PROJECT_REFERENCE_SUFFIX_LENGTH = 8;
const MAX_PROJECT_REFERENCE_ATTEMPTS = 8;

function randomProjectReferenceSuffix(): string {
  const bytes = randomBytes(PROJECT_REFERENCE_SUFFIX_LENGTH);
  let out = "";
  for (const byte of bytes) {
    out += PROJECT_REFERENCE_ALPHABET[byte % PROJECT_REFERENCE_ALPHABET.length];
  }
  return out;
}

export class CustomJewelryProjectReferenceExhaustedError extends Error {
  constructor() {
    super(
      `Could not generate an unused Custom Jewelry project reference in ${MAX_PROJECT_REFERENCE_ATTEMPTS} attempts.`
    );
    this.name = "CustomJewelryProjectReferenceExhaustedError";
  }
}

export interface CreateCustomJewelryProjectInput {
  /**
   * The AUTHENTICATED Shopify customer, or null for an anonymous enquiry.
   * Intake is deliberately open (README: "free and intentionally
   * low-friction"); the purchase path is not. Never accepted from the browser
   * — the caller passes the signed `logged_in_customer_id` or nothing.
   */
  readonly customerRef: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly startingPoint: CustomJewelryStartingPoint;
  readonly promptText: string;
  readonly jewelryType?: string | null;
  /** Free text. Stored, never fetched server-side — see the column comment on why. */
  readonly inspirationLinks?: string | null;
  /** Minor units and currency travel together or not at all — the database enforces it too. */
  readonly approximateBudget?: { readonly amountMinorUnits: bigint; readonly currency: string } | null;
  /** A date OR `hasNoDeadline`, never both. The database refuses the combination. */
  readonly desiredCompletionDate?: Date | null;
  readonly hasNoDeadline?: boolean;
  readonly followUpPreference: CustomJewelryFollowUpPreference;
}

/**
 * Records an intake submission and returns the created project.
 *
 * Retries ONLY on a project-reference collision. Any other failure propagates
 * untouched: a retry loop that swallows unrelated errors turns a schema
 * problem into a mysterious exhaustion message, which is a diagnosis cost
 * paid later by someone with less context.
 */
export async function createCustomJewelryProject(
  input: CreateCustomJewelryProjectInput
): Promise<CustomJewelryProject> {
  for (let attempt = 0; attempt < MAX_PROJECT_REFERENCE_ATTEMPTS; attempt += 1) {
    const projectReference = `${PROJECT_REFERENCE_PREFIX}${randomProjectReferenceSuffix()}`;
    try {
      return await prisma.customJewelryProject.create({
        data: {
          projectReference,
          customerRef: input.customerRef,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          startingPoint: input.startingPoint,
          promptText: input.promptText,
          jewelryType: input.jewelryType ?? null,
          inspirationLinks: input.inspirationLinks ?? null,
          approximateBudgetMinorUnits: input.approximateBudget?.amountMinorUnits ?? null,
          approximateBudgetCurrency: input.approximateBudget?.currency ?? null,
          desiredCompletionDate: input.desiredCompletionDate ?? null,
          hasNoDeadline: input.hasNoDeadline ?? false,
          followUpPreference: input.followUpPreference,
        },
      });
    } catch (error) {
      const isReferenceCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        // Only a project_reference collision is retryable. Narrowed on the
        // constraint target rather than on P2002 alone, so a future unique
        // index on some other column cannot be silently retried eight times
        // and then reported as reference exhaustion — a mislabelling that
        // sends the next reader to the wrong place entirely.
        String(error.meta?.target ?? "").includes("project_reference");
      if (!isReferenceCollision) throw error;
    }
  }
  throw new CustomJewelryProjectReferenceExhaustedError();
}

/** The customer-safe projection. No internal status history, no staff notes — there are none yet, and this is the shape that must stay safe when there are. */
export interface CustomJewelryProjectConfirmation {
  readonly projectReference: string;
  readonly status: string;
}

export function toCustomJewelryProjectConfirmation(
  project: CustomJewelryProject
): CustomJewelryProjectConfirmation {
  return { projectReference: project.projectReference, status: project.status };
}
