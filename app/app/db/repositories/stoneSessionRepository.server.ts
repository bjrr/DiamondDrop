/**
 * Set Your Own Stone — session persistence.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §10.
 *
 * This is the server-authoritative record the spec demands instead of query
 * parameters and localStorage. It exists BEFORE any custom jewelry project,
 * because the customer describes their stone before deciding between a ready
 * setting and a custom one, and may never reach Custom Jewelry at all.
 *
 * Reference generation, the alphabet, and the narrowed collision retry are
 * lifted deliberately from `customJewelryProjectRepository.server.ts`. Two
 * customer-facing references in one product should be generated the same way
 * and fail the same way.
 */
import { randomBytes } from "node:crypto";

import { Prisma, type StoneSession } from "@prisma/client";

import { prisma } from "~/db/client.server";
import type {
  CompatibilityRule,
  CompatibilityStatus,
  Micrometres,
  StoneShape,
} from "~/domain/setyourownstone/matching";

const SESSION_REFERENCE_PREFIX = "SYS-";
/** No I, L, O or U: a reference gets read down a phone line. */
const SESSION_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SESSION_REFERENCE_SUFFIX_LENGTH = 8;
const MAX_SESSION_REFERENCE_ATTEMPTS = 8;

function randomSessionReferenceSuffix(): string {
  const bytes = randomBytes(SESSION_REFERENCE_SUFFIX_LENGTH);
  let out = "";
  for (const byte of bytes) {
    out += SESSION_REFERENCE_ALPHABET[byte % SESSION_REFERENCE_ALPHABET.length];
  }
  return out;
}

export class StoneSessionReferenceExhaustedError extends Error {
  constructor() {
    super(
      `Could not generate an unused stone session reference in ${MAX_SESSION_REFERENCE_ATTEMPTS} attempts.`
    );
    this.name = "StoneSessionReferenceExhaustedError";
  }
}

/** The customer-supplied stone types, narrowed from the pricing engine's
 *  wider `StoneType` to the three docs/SET-YOUR-OWN-STONE.md §4 offers. The
 *  enum is shared on purpose; the narrowing is presentation. */
export type CustomerStoneType = "natural_diamond" | "lab_diamond" | "colored_gemstone";

export interface CreateStoneSessionInput {
  /** From the App Proxy's SIGNED `logged_in_customer_id` only. Never a body
   *  field — the same rule custom jewelry intake follows. */
  readonly customerRef: string | null;
  readonly stoneType: CustomerStoneType;
  readonly shape: StoneShape;
  /** A decimal string, e.g. "2.34". Display and staff review only; never an
   *  input to compatibility (§4, §15.5). */
  readonly caratWeight: string;
  readonly lengthUm: Micrometres;
  readonly widthUm: Micrometres;
  readonly depthUm?: Micrometres | null;
  readonly certLab?: string | null;
  readonly certNumber?: string | null;
  readonly isCurrentlyMounted: boolean;
  readonly notes?: string | null;
}

export async function createStoneSession(
  input: CreateStoneSessionInput
): Promise<StoneSession> {
  for (let attempt = 0; attempt < MAX_SESSION_REFERENCE_ATTEMPTS; attempt += 1) {
    const sessionReference = `${SESSION_REFERENCE_PREFIX}${randomSessionReferenceSuffix()}`;
    try {
      return await prisma.stoneSession.create({
        data: {
          sessionReference,
          customerRef: input.customerRef,
          stoneType: input.stoneType,
          shape: input.shape,
          caratWeight: new Prisma.Decimal(input.caratWeight),
          lengthUm: input.lengthUm,
          widthUm: input.widthUm,
          depthUm: input.depthUm ?? null,
          certLab: input.certLab ?? null,
          certNumber: input.certNumber ?? null,
          isCurrentlyMounted: input.isCurrentlyMounted,
          notes: input.notes ?? null,
        },
      });
    } catch (error) {
      // Narrowed on the constraint target, not on P2002 alone: a future
      // unique index elsewhere must not be retried eight times and then
      // reported as reference exhaustion, which would send the next reader
      // to entirely the wrong place.
      const isReferenceCollision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        String(error.meta?.target ?? "").includes("session_reference");
      if (!isReferenceCollision) throw error;
    }
  }
  throw new StoneSessionReferenceExhaustedError();
}

/**
 * Resume by reference.
 *
 * AUTHORISATION IS THE CALLER'S JOB and it is not optional: a reference is a
 * bearer token with eight characters of entropy, which is fine for resuming
 * your own anonymous session and not fine as the only thing standing between
 * one customer and another's certificate. Routes compare `customerRef`
 * against the signed proxy value before returning anything.
 */
export async function findStoneSessionByReference(
  sessionReference: string
): Promise<StoneSession | null> {
  return prisma.stoneSession.findUnique({ where: { sessionReference } });
}

export interface RecordSettingSelectionInput {
  readonly sessionReference: string;
  readonly selectedProductGid: string;
  readonly selectedVariantGid: string;
  readonly selectedOptions?: Record<string, string> | null;
  /** The verdict the customer was SHOWN, computed server-side. Never taken
   *  from the request body. */
  readonly compatibilityStatus: CompatibilityStatus;
  readonly compatibilityRule: CompatibilityRule;
  /** The mounting side of the comparison, as it stood at decision time.
   *  Write-once; the database refuses a later change. */
  readonly matchedSnapshot?: unknown;
}

/**
 * Record which ready setting the customer chose, and the verdict they saw
 * (§8, §10).
 *
 * The status and rule are SNAPSHOTTED rather than recomputed later, because
 * `ready_setting_compatibility` is mutable configuration: if staff correct a
 * nominal size next week, the question "what did we tell this customer" must
 * still have the original answer.
 */
export async function recordSettingSelection(
  input: RecordSettingSelectionInput
): Promise<StoneSession> {
  return prisma.stoneSession.update({
    where: { sessionReference: input.sessionReference },
    data: {
      selectedProductGid: input.selectedProductGid,
      selectedVariantGid: input.selectedVariantGid,
      selectedOptions: (input.selectedOptions ?? undefined) as Prisma.InputJsonValue | undefined,
      compatibilityStatus: input.compatibilityStatus,
      compatibilityRule: input.compatibilityRule,
      // WRITE-ONCE HISTORICAL EVIDENCE. A database trigger refuses any update
      // that would change a populated matched_snapshot, so this write only
      // succeeds the first time -- which is the intent. The status and rule
      // above say WHAT was decided; this says why, from the mounting figures
      // actually used, and must survive every later Shopify edit.
      matchedSnapshot: (input.matchedSnapshot ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      status: "setting_submitted",
    },
  });
}

/** Mark a session as handed into Custom Jewelry. The session stays the source
 *  of truth for the stone; the project merely links to it (§9.2). */
export async function markHandedToCustom(sessionReference: string): Promise<StoneSession> {
  return prisma.stoneSession.update({
    where: { sessionReference },
    data: { status: "handed_to_custom" },
  });
}

/**
 * The customer-safe projection.
 *
 * Carat is a STRING here, formatted once, so no caller is tempted to do
 * arithmetic on it — it is a label, not a quantity (§4, §15.5). Dimensions
 * stay in micrometres and are formatted for display at the edge.
 */
export interface StoneSessionView {
  readonly sessionReference: string;
  readonly stoneType: string;
  readonly shape: string;
  readonly caratWeight: string;
  readonly lengthUm: number;
  readonly widthUm: number;
  readonly depthUm: number | null;
  readonly isCurrentlyMounted: boolean;
  readonly certLab: string | null;
  readonly certNumber: string | null;
  readonly notes: string | null;
  readonly status: string;
}

export function toStoneSessionView(session: StoneSession): StoneSessionView {
  return {
    sessionReference: session.sessionReference,
    stoneType: session.stoneType,
    shape: session.shape,
    caratWeight: session.caratWeight.toString(),
    lengthUm: session.lengthUm,
    widthUm: session.widthUm,
    depthUm: session.depthUm,
    isCurrentlyMounted: session.isCurrentlyMounted,
    certLab: session.certLab,
    certNumber: session.certNumber,
    notes: session.notes,
    status: session.status,
  };
}
