import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  ActorType,
  WarrantyClaim,
  WarrantyClaimEvent,
  WarrantyClaimLocalJewellerAuthorization,
  WarrantyClaimRemedy,
  WarrantyClaimRemedyStatus,
  WarrantyClaimStatus,
  WarrantyClaimUpload,
  WarrantyClaimUploadKind,
  WarrantyCoverageDecision,
  WarrantyRemedyKind,
} from "@prisma/client";

import {
  decideWarrantyClaimTransition,
  type WarrantyClaimAction,
  type WarrantyClaimTransitionState,
} from "~/domain/warranty/claimStatus";
import { validateWarrantyRemedyMoney } from "~/domain/warranty/remedy";

import { prisma } from "../client.server";
import { validateWarrantyUploadMetadata } from "../../jobs/warranty/uploadValidation";

/**
 * Warranty claim persistence (Slice 5 task 5-2, docs/WARRANTY-CLAIMS.md,
 * docs/specs/SLICE-5-WARRANTY-CLAIMS.md criteria 153-170).
 *
 * Task 5-1 built the schema, the append-only guard trigger, and the PURE
 * domain rules in `~/domain/warranty/claimStatus` and `~/domain/warranty/
 * remedy`. This module NEVER reimplements those rules — every status change
 * goes through `decideWarrantyClaimTransition` and every remedy write goes
 * through `validateWarrantyRemedyMoney` FIRST, so a refusal is a typed error
 * thrown before any write is attempted. The database's `warranty_claim_guard`
 * trigger and CHECK constraints remain a genuine backstop against a caller
 * that bypasses this module entirely (raw SQL, a future script, a bug) — not
 * this module's normal control flow. See those two domain modules' header
 * comments for the full reasoning this module deliberately does not repeat.
 *
 * CLAIM REFERENCE STRATEGY. `claimReference` is generated here, not by a
 * database sequence/default (5-1 left it to the application layer on
 * purpose — see `WarrantyClaim.claimReference`'s doc comment in
 * schema.prisma). A "read the current max, add one" scheme is the obvious
 * alternative and is explicitly wrong under concurrency: two claims
 * submitted in the same instant can both read the same max and both compute
 * the same "next" reference, and nothing stops both INSERTs from succeeding
 * with duplicate values unless the read and the write happen inside a
 * serialized lock — which a public, unauthenticated intake form (task 5-3)
 * is the worst possible place to rely on. Instead, `createWarrantyClaim`
 * generates a random, high-entropy candidate (40 bits from a 32-symbol
 * alphabet — astronomically unlikely to collide at any volume this business
 * will see) and lets the database's own `claim_reference` UNIQUE constraint
 * be the actual arbiter: on a `P2002` collision it regenerates a NEW
 * candidate and retries the insert, exactly like
 * `luxuryStealRepository.server.ts`'s `recordLuxuryStealOrderCheck` catches
 * `P2002` — except that idiom re-reads and returns the EXISTING row because
 * a duplicate delivery there means "the same intent, already recorded";
 * here a collision means two DIFFERENT claims coincidentally generated the
 * same reference, so the correct response is a fresh candidate and another
 * attempt, never returning someone else's claim. Collision-safety comes
 * from the constraint plus retry, not from the randomness alone — the same
 * reason nothing here trusts probability by itself.
 */

const CLAIM_REFERENCE_PREFIX = "WC-";
// Crockford-style alphabet minus I, L, O, U — unambiguous when read aloud or
// typed into a support ticket by a customer.
const CLAIM_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CLAIM_REFERENCE_SUFFIX_LENGTH = 8;
const MAX_CLAIM_REFERENCE_ATTEMPTS = 8;

function randomClaimReferenceSuffix(): string {
  const bytes = randomBytes(CLAIM_REFERENCE_SUFFIX_LENGTH);
  let out = "";
  for (const byte of bytes) {
    out += CLAIM_REFERENCE_ALPHABET[byte % CLAIM_REFERENCE_ALPHABET.length];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WarrantyClaimNotFoundError extends Error {
  constructor(readonly claimId: string) {
    super(`No warranty_claim with id ${claimId}.`);
    this.name = "WarrantyClaimNotFoundError";
  }
}

/** Refused BEFORE any database write — see this module's header comment. */
export class IllegalWarrantyClaimTransitionError extends Error {
  constructor(
    readonly claimId: string,
    readonly fromStatus: WarrantyClaimStatus,
    readonly action: string,
    readonly reason: string
  ) {
    super(`Warranty claim ${claimId}: cannot apply "${action}" from "${fromStatus}" — ${reason}`);
    this.name = "IllegalWarrantyClaimTransitionError";
  }
}

/** Criterion 157/159/160 — an authenticated staff identity is required and never inferred. */
export class WarrantyClaimActorRequiredError extends Error {
  constructor(readonly action: string) {
    super(`"${action}" requires a non-empty staff actor reference.`);
    this.name = "WarrantyClaimActorRequiredError";
  }
}

/** Criterion 156 — inbound shipping evidence cannot be recorded before authorization. */
export class WarrantyClaimNotAuthorizedForShippingError extends Error {
  constructor(readonly claimId: string) {
    super(`Warranty claim ${claimId} is not yet authorized for inspection; no shipping evidence may be recorded.`);
    this.name = "WarrantyClaimNotAuthorizedForShippingError";
  }
}

export class WarrantyClaimReferenceGenerationExhaustedError extends Error {
  constructor(attempts: number) {
    super(`Could not generate a unique warranty claim reference after ${attempts} attempts.`);
    this.name = "WarrantyClaimReferenceGenerationExhaustedError";
  }
}

/** Criterion 162/6 — a remedy may only be decided for a claim CaratForUs has approved as covered. */
export class WarrantyClaimNotCoveredError extends Error {
  constructor(readonly claimId: string) {
    super(`Warranty claim ${claimId} is not in an approved-covered state; a remedy cannot be decided.`);
    this.name = "WarrantyClaimNotCoveredError";
  }
}

/** Criterion 163 — refused by the `@@unique([claimId])` constraint, not a read-then-write check. */
export class WarrantyClaimRemedyAlreadyExistsError extends Error {
  constructor(readonly claimId: string) {
    super(`Warranty claim ${claimId} already has a remedy recorded; remedies are decided at most once per claim.`);
    this.name = "WarrantyClaimRemedyAlreadyExistsError";
  }
}

export class WarrantyClaimRemedyNotFoundError extends Error {
  constructor(readonly claimId: string) {
    super(`Warranty claim ${claimId} has no remedy recorded yet.`);
    this.name = "WarrantyClaimRemedyNotFoundError";
  }
}

/** Criterion 164 — mirrors `validateWarrantyRemedyMoney`'s refusal as a typed error. */
export class InvalidWarrantyRemedyMoneyError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid warranty claim remedy money: ${reason}`);
    this.name = "InvalidWarrantyRemedyMoneyError";
  }
}

/** Criterion 165 — at most one jeweller authorization per remedy. */
export class WarrantyClaimLocalJewellerAuthorizationAlreadyExistsError extends Error {
  constructor(readonly remedyId: string) {
    super(`Warranty claim remedy ${remedyId} already has a local-jeweller authorization recorded.`);
    this.name = "WarrantyClaimLocalJewellerAuthorizationAlreadyExistsError";
  }
}

/** Spec §5 — refused before a row is written; mirrors `InvalidWarrantyUploadMetadataError` in `~/jobs/warranty/ports`. */
export class InvalidWarrantyClaimUploadError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid warranty claim upload: ${reason}`);
    this.name = "InvalidWarrantyClaimUploadError";
  }
}

// ---------------------------------------------------------------------------
// Intake (M13 create)
// ---------------------------------------------------------------------------

export interface WarrantyClaimEventActor {
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly reason?: string | null;
  readonly metadata?: unknown;
}

export interface CreateWarrantyClaimInput {
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef?: string | null;
  readonly masterVariantId?: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserName: string;
  readonly purchaserEmail: string;
  readonly purchaseDate?: Date | null;
  readonly deliveryDate?: Date | null;
  readonly issueFirstNoticedDate?: Date | null;
  readonly problemDescription: string;
  readonly hadImpactOrDamageEvent: boolean;
  readonly impactOrDamageDetails?: string | null;
  readonly wasAlteredAfterDelivery: boolean;
  readonly alterationDetails?: string | null;
  readonly certificateOrSerialIdentifier?: string | null;
  /** Criterion 154 — both REQUIRED. Must already exist as `Acknowledgment` rows (slice 0 model); this function does not create them. */
  readonly accuracyCertificationAcknowledgmentId: string;
  readonly coverageNotEstablishedAcknowledgmentId: string;
  /** Recorded on the claim's initial (`fromStatus: null -> "submitted"`) event. Defaults to `{ actorType: "customer", actorRef: null }`. */
  readonly actor?: WarrantyClaimEventActor;
}

/**
 * Criterion 155's ORDER/LINE RESOLUTION IS DELIBERATELY OUT OF SCOPE HERE —
 * `~/domain/warranty/claimStatus`'s module header and this slice's schema
 * comment both name that task 5-3's job (the intake route resolves
 * `orderRef`/`lineRef` against Shopify/`MasterVariant` before ever calling
 * this function). This function stores exactly what it is given.
 */
export async function createWarrantyClaim(input: CreateWarrantyClaimInput): Promise<WarrantyClaim> {
  const actor: WarrantyClaimEventActor = input.actor ?? { actorType: "customer", actorRef: null };

  for (let attempt = 0; attempt < MAX_CLAIM_REFERENCE_ATTEMPTS; attempt++) {
    const claimReference = `${CLAIM_REFERENCE_PREFIX}${randomClaimReferenceSuffix()}`;
    try {
      return await prisma.$transaction(async (tx) => {
        const claim = await tx.warrantyClaim.create({
          data: {
            claimReference,
            orderRef: input.orderRef,
            lineRef: input.lineRef,
            customerRef: input.customerRef ?? null,
            masterVariantId: input.masterVariantId ?? null,
            itemConfigurationDescription: input.itemConfigurationDescription,
            purchaserName: input.purchaserName,
            purchaserEmail: input.purchaserEmail,
            purchaseDate: input.purchaseDate ?? null,
            deliveryDate: input.deliveryDate ?? null,
            issueFirstNoticedDate: input.issueFirstNoticedDate ?? null,
            problemDescription: input.problemDescription,
            hadImpactOrDamageEvent: input.hadImpactOrDamageEvent,
            impactOrDamageDetails: input.impactOrDamageDetails ?? null,
            wasAlteredAfterDelivery: input.wasAlteredAfterDelivery,
            alterationDetails: input.alterationDetails ?? null,
            certificateOrSerialIdentifier: input.certificateOrSerialIdentifier ?? null,
            accuracyCertificationAcknowledgmentId: input.accuracyCertificationAcknowledgmentId,
            coverageNotEstablishedAcknowledgmentId: input.coverageNotEstablishedAcknowledgmentId,
          },
        });

        await tx.warrantyClaimEvent.create({
          data: {
            claimId: claim.id,
            fromStatus: null,
            toStatus: "submitted",
            actorType: actor.actorType,
            actorRef: actor.actorRef,
            reason: actor.reason ?? "claim submitted",
            metadata: actor.metadata as Prisma.InputJsonValue | undefined,
          },
        });

        return claim;
      });
    } catch (error) {
      // The ONLY unique constraint this INSERT can hit is claim_reference
      // (id is a random uuid() default, and every acknowledgment/master
      // variant reference is a foreign key, not a unique constraint on this
      // table) — so any P2002 here means a claim_reference collision, and
      // the right response is a fresh candidate, never a re-read (see this
      // module's header comment for why that differs from
      // `recordLuxuryStealOrderCheck`'s idempotent-retry idiom).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        continue;
      }
      throw error;
    }
  }
  throw new WarrantyClaimReferenceGenerationExhaustedError(MAX_CLAIM_REFERENCE_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// Status transitions (M13/M14) — every status change goes through
// `decideWarrantyClaimTransition` BEFORE any database write.
// ---------------------------------------------------------------------------

async function loadTransitionState(claimId: string): Promise<WarrantyClaimTransitionState & { id: string }> {
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id: claimId },
    select: { id: true, status: true, pausedFromStatus: true, receivedAt: true },
  });
  if (!claim) throw new WarrantyClaimNotFoundError(claimId);
  return claim;
}

/**
 * Validates the requested `action` against the claim's CURRENT persisted
 * state via the pure domain function, throws `IllegalWarrantyClaimTransitionError`
 * on refusal (nothing is written), and otherwise applies the resulting
 * status/pausedFromStatus together with `extraData` and appends the
 * corresponding `WarrantyClaimEvent` in one transaction (criterion 169: who,
 * when, from, to, why — `fromStatus`/`toStatus` come from the SAME decision
 * that drove the update, never re-derived).
 */
async function applyTransition(
  claimId: string,
  action: WarrantyClaimAction,
  event: WarrantyClaimEventActor,
  extraData: Prisma.WarrantyClaimUpdateInput = {}
): Promise<WarrantyClaim> {
  const state = await loadTransitionState(claimId);
  const decision = decideWarrantyClaimTransition(state, action);
  if (!decision.ok) {
    throw new IllegalWarrantyClaimTransitionError(claimId, state.status, action.type, decision.reason);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.warrantyClaim.update({
      where: { id: claimId },
      data: {
        status: decision.nextStatus,
        pausedFromStatus: decision.nextPausedFromStatus,
        ...extraData,
      },
    });
    await tx.warrantyClaimEvent.create({
      data: {
        claimId,
        fromStatus: state.status,
        toStatus: decision.nextStatus,
        actorType: event.actorType,
        actorRef: event.actorRef,
        reason: event.reason ?? null,
        metadata: event.metadata as Prisma.InputJsonValue | undefined,
      },
    });
    return updated;
  });
}

export async function startWarrantyClaimReview(claimId: string, actor: WarrantyClaimEventActor): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "start_review" }, actor);
}

export async function requestMoreInformation(
  claimId: string,
  actor: WarrantyClaimEventActor,
  reason: string
): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "request_more_information" }, { ...actor, reason });
}

export async function resumeWarrantyClaimAfterMoreInformation(
  claimId: string,
  actor: WarrantyClaimEventActor
): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "resume_after_more_information" }, actor);
}

/**
 * Criterion 156/157 — the explicit authenticated-staff act that is the ONLY
 * thing criterion 156's shipping-instruction gate
 * (`mayIssueInboundShippingInstructions`) can ever key on. `staffActorRef`
 * is required and validated non-empty here — never optional, never
 * inferred from a status read.
 */
export async function authorizeWarrantyClaimForInspection(
  claimId: string,
  staffActorRef: string,
  options: { readonly reason?: string; readonly at?: Date } = {}
): Promise<WarrantyClaim> {
  if (!staffActorRef.trim()) throw new WarrantyClaimActorRequiredError("authorize_for_inspection");
  return applyTransition(
    claimId,
    { type: "authorize_for_inspection" },
    { actorType: "staff", actorRef: staffActorRef, reason: options.reason ?? "authorized for inspection" },
    { authorizedAt: options.at ?? new Date(), authorizedByActorRef: staffActorRef }
  );
}

export async function markWarrantyClaimInTransit(claimId: string, actor: WarrantyClaimEventActor): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "mark_in_transit" }, actor);
}

export interface RecordWarrantyClaimReceiptInput {
  readonly receivedAt?: Date;
  readonly packageCondition?: string;
  readonly itemCondition?: string;
  readonly inspectionNotes?: string;
  /** Criterion 5 "reviewer identity" — the staff member recording receipt/inspection. Required, non-empty. */
  readonly inspectedByActorRef: string;
}

/** Criterion 159 — the ONLY function that sets `receivedAt`. */
export async function recordWarrantyClaimReceipt(
  claimId: string,
  input: RecordWarrantyClaimReceiptInput
): Promise<WarrantyClaim> {
  if (!input.inspectedByActorRef.trim()) throw new WarrantyClaimActorRequiredError("record_receipt");
  return applyTransition(
    claimId,
    { type: "record_receipt" },
    { actorType: "staff", actorRef: input.inspectedByActorRef, reason: "item received" },
    {
      receivedAt: input.receivedAt ?? new Date(),
      packageCondition: input.packageCondition ?? null,
      itemCondition: input.itemCondition ?? null,
      inspectionNotes: input.inspectionNotes ?? null,
      inspectedByActorRef: input.inspectedByActorRef,
    }
  );
}

export interface DecideWarrantyCoverageInput {
  readonly decision: WarrantyCoverageDecision;
  /** Required (and validated non-empty) when `decision === "not_covered"` — criterion 160. Optional for "covered". */
  readonly reason?: string;
  readonly decidedByActorRef: string;
}

/** Criterion 160/161 — a Luxury Steal line is decided through this exact same function; there is no separate path. */
export async function decideWarrantyClaimCoverage(claimId: string, input: DecideWarrantyCoverageInput): Promise<WarrantyClaim> {
  if (!input.decidedByActorRef.trim()) throw new WarrantyClaimActorRequiredError("decide_coverage");

  const action: WarrantyClaimAction =
    input.decision === "covered"
      ? { type: "decide_coverage", decision: "covered", reason: input.reason }
      : { type: "decide_coverage", decision: "not_covered", reason: input.reason ?? "" };

  return applyTransition(
    claimId,
    action,
    { actorType: "staff", actorRef: input.decidedByActorRef, reason: input.reason ?? null },
    {
      coverageDecision: input.decision,
      coverageDecisionReason: input.reason ?? null,
      coverageDecidedAt: new Date(),
      coverageDecidedByActorRef: input.decidedByActorRef,
    }
  );
}

export async function beginWarrantyClaimRemedy(claimId: string, actor: WarrantyClaimEventActor): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "begin_remedy" }, actor);
}

export async function resolveWarrantyClaim(claimId: string, actor: WarrantyClaimEventActor): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "resolve" }, actor);
}

export async function closeWarrantyClaim(claimId: string, actor: WarrantyClaimEventActor): Promise<WarrantyClaim> {
  return applyTransition(claimId, { type: "close" }, actor);
}

// ---------------------------------------------------------------------------
// Inbound shipping evidence (§4, criterion 158) — data only, not a status
// transition. Still gated on authorization (criterion 156's spirit: nothing
// shipping-related is meaningful before authorization exists) and still
// appended to the same append-only event history for audit continuity.
// ---------------------------------------------------------------------------

export interface RecordWarrantyClaimInboundShippingInput {
  readonly carrier?: string;
  readonly trackingNumber?: string;
  readonly insuranceReference?: string;
  readonly insuredValueMinorUnits?: bigint;
  readonly insuredValueCurrency?: string;
}

export async function recordWarrantyClaimInboundShippingEvidence(
  claimId: string,
  input: RecordWarrantyClaimInboundShippingInput,
  actor: WarrantyClaimEventActor
): Promise<WarrantyClaim> {
  const claim = await prisma.warrantyClaim.findUnique({ where: { id: claimId }, select: { authorizedAt: true, status: true } });
  if (!claim) throw new WarrantyClaimNotFoundError(claimId);
  if (claim.authorizedAt === null) throw new WarrantyClaimNotAuthorizedForShippingError(claimId);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.warrantyClaim.update({
      where: { id: claimId },
      data: {
        inboundTrackingCarrier: input.carrier ?? undefined,
        inboundTrackingNumber: input.trackingNumber ?? undefined,
        inboundInsuranceReference: input.insuranceReference ?? undefined,
        inboundInsuredValueMinorUnits: input.insuredValueMinorUnits ?? undefined,
        inboundInsuredValueCurrency: input.insuredValueCurrency ?? undefined,
      },
    });
    // Not a status transition (fromStatus === toStatus === the claim's
    // current status) — this event exists purely so the append-only history
    // records WHEN tracking/insurance evidence was supplied and by whom,
    // alongside every other fact about the claim's timeline.
    await tx.warrantyClaimEvent.create({
      data: {
        claimId,
        fromStatus: claim.status,
        toStatus: claim.status,
        actorType: actor.actorType,
        actorRef: actor.actorRef,
        reason: actor.reason ?? "inbound shipping evidence recorded",
        metadata: {
          carrier: input.carrier ?? null,
          trackingNumber: input.trackingNumber ?? null,
          insuranceReference: input.insuranceReference ?? null,
          insuredValueMinorUnits: input.insuredValueMinorUnits?.toString() ?? null,
          insuredValueCurrency: input.insuredValueCurrency ?? null,
        },
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Remedy (M16) — never a customer input. Criterion 162's enforcement is
// what this section does NOT accept: no parameter anywhere below reads a
// customer-supplied remedy choice.
// ---------------------------------------------------------------------------

export interface CreateWarrantyClaimRemedyInput {
  readonly claimId: string;
  readonly kind: WarrantyRemedyKind;
  readonly refundAmountMinorUnits?: bigint;
  readonly currency?: string;
  readonly decidedByActorRef: string;
  readonly decidedAt?: Date;
}

/**
 * Criterion 162/163/164. Requires the claim to be `approved_covered`
 * (§6 — CaratForUs determines the remedy only for a VALID COVERED claim;
 * this is a repository-level guard, not merely relying on the CHECK
 * constraint that couples `coverage_decision` to `status`, because that
 * constraint says nothing about remedy rows at all). Money is validated via
 * `validateWarrantyRemedyMoney` BEFORE the insert is attempted. Idempotency
 * (criterion 163) is the `@@unique([claimId])` constraint — a second
 * `create` for the same claim hits `P2002` and is refused via
 * `WarrantyClaimRemedyAlreadyExistsError`, never silently returning the
 * existing row: a second DECISION for the same claim is a genuine duplicate
 * attempt to be investigated, not an idempotent retry with identical
 * intent (contrast `updateWarrantyClaimRemedyStatus` below, which IS the
 * retry path — see its own comment).
 */
export async function createWarrantyClaimRemedy(input: CreateWarrantyClaimRemedyInput): Promise<WarrantyClaimRemedy> {
  if (!input.decidedByActorRef.trim()) throw new WarrantyClaimActorRequiredError("create_remedy");

  const moneyCheck = validateWarrantyRemedyMoney({
    kind: input.kind,
    refundAmountMinorUnits: input.refundAmountMinorUnits ?? null,
    currency: input.currency ?? null,
  });
  if (!moneyCheck.ok) throw new InvalidWarrantyRemedyMoneyError(moneyCheck.reason);

  const claim = await prisma.warrantyClaim.findUnique({ where: { id: input.claimId }, select: { coverageDecision: true } });
  if (!claim) throw new WarrantyClaimNotFoundError(input.claimId);
  if (claim.coverageDecision !== "covered") throw new WarrantyClaimNotCoveredError(input.claimId);

  try {
    return await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: input.claimId,
        kind: input.kind,
        refundAmountMinorUnits: input.refundAmountMinorUnits ?? null,
        currency: input.currency ?? null,
        decidedByActorRef: input.decidedByActorRef,
        decidedAt: input.decidedAt ?? new Date(),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new WarrantyClaimRemedyAlreadyExistsError(input.claimId);
    }
    throw error;
  }
}

export interface UpdateWarrantyClaimRemedyStatusInput {
  readonly claimId: string;
  readonly status: WarrantyClaimRemedyStatus;
  readonly processorReference?: string;
  readonly failureReason?: string;
  readonly completedAt?: Date;
}

/**
 * The RETRY path (contrast `createWarrantyClaimRemedy` above): always an
 * UPDATE of the single existing remedy row for `claimId`, never a second
 * INSERT. A retried "process this remedy" call (e.g. a refund processor
 * webhook redelivering, or a manual admin retry after a transient failure)
 * lands on the same row every time, so it cannot create duplicate customer
 * value no matter how many times it runs — the schema comment on
 * `WarrantyClaimRemedy` calls this out explicitly as mirroring
 * `GroupBuyRefund`'s single-row-per-line design.
 */
export async function updateWarrantyClaimRemedyStatus(input: UpdateWarrantyClaimRemedyStatusInput): Promise<WarrantyClaimRemedy> {
  const existing = await prisma.warrantyClaimRemedy.findUnique({ where: { claimId: input.claimId } });
  if (!existing) throw new WarrantyClaimRemedyNotFoundError(input.claimId);

  return prisma.warrantyClaimRemedy.update({
    where: { claimId: input.claimId },
    data: {
      status: input.status,
      processorReference: input.processorReference ?? existing.processorReference,
      failureReason: input.status === "failed" ? (input.failureReason ?? existing.failureReason) : null,
      completedAt: input.status === "completed" ? (input.completedAt ?? new Date()) : existing.completedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Local-jeweller authorization (INTERNAL ONLY — criteria 165-167). Every
// function in this section is a STAFF/ADMIN write path; nothing here reads
// from a customer-facing request. See the READ section below for the
// boundary that matters most: no read a customer-facing caller could
// plausibly reach for returns this table's data.
// ---------------------------------------------------------------------------

export interface RecordLocalJewellerAuthorizationInput {
  readonly remedyId: string;
  readonly jewellerName: string;
  readonly jewellerContact?: string;
  readonly authorizedScope: string;
  readonly authorizedCostMinorUnits: bigint;
  readonly authorizedCostCurrency: string;
  readonly authorizedByActorRef: string;
  readonly authorizedAt?: Date;
}

/** INTERNAL ONLY (§7, criteria 165-166). Staff-authorized selection of a local jeweller for one remedy — at most one per remedy. */
export async function staffRecordLocalJewellerAuthorization(
  input: RecordLocalJewellerAuthorizationInput
): Promise<WarrantyClaimLocalJewellerAuthorization> {
  if (!input.authorizedByActorRef.trim()) throw new WarrantyClaimActorRequiredError("record_local_jeweller_authorization");
  try {
    return await prisma.warrantyClaimLocalJewellerAuthorization.create({
      data: {
        remedyId: input.remedyId,
        jewellerName: input.jewellerName,
        jewellerContact: input.jewellerContact ?? null,
        authorizedScope: input.authorizedScope,
        authorizedCostMinorUnits: input.authorizedCostMinorUnits,
        authorizedCostCurrency: input.authorizedCostCurrency,
        authorizedByActorRef: input.authorizedByActorRef,
        authorizedAt: input.authorizedAt ?? new Date(),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new WarrantyClaimLocalJewellerAuthorizationAlreadyExistsError(input.remedyId);
    }
    throw error;
  }
}

export interface UpdateLocalJewellerAuthorizationCompletionInput {
  readonly remedyId: string;
  readonly communicationsLog?: string;
  readonly invoiceReference?: string;
  readonly invoiceAmountMinorUnits?: bigint;
  readonly invoiceAmountCurrency?: string;
  readonly paymentReference?: string;
  /** Criterion 167 — reimbursement is NEVER automatic. Only ever set here, by an explicit staff call with an explicit value. */
  readonly reimbursementReference?: string;
  readonly completionEvidence?: string;
  readonly completedAt?: Date;
}

/** INTERNAL ONLY (§7, criteria 166-167). Updates the SAME authorization row — never a second row (unique on `remedyId`). */
export async function staffUpdateLocalJewellerAuthorizationCompletion(
  input: UpdateLocalJewellerAuthorizationCompletionInput
): Promise<WarrantyClaimLocalJewellerAuthorization> {
  return prisma.warrantyClaimLocalJewellerAuthorization.update({
    where: { remedyId: input.remedyId },
    data: {
      communicationsLog: input.communicationsLog ?? undefined,
      invoiceReference: input.invoiceReference ?? undefined,
      invoiceAmountMinorUnits: input.invoiceAmountMinorUnits ?? undefined,
      invoiceAmountCurrency: input.invoiceAmountCurrency ?? undefined,
      paymentReference: input.paymentReference ?? undefined,
      reimbursementReference: input.reimbursementReference ?? undefined,
      completionEvidence: input.completionEvidence ?? undefined,
      completedAt: input.completedAt ?? undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Uploads (M15) — metadata only. Bytes never reach Postgres (spec §5).
// ---------------------------------------------------------------------------

export interface RecordWarrantyClaimUploadInput {
  readonly claimId: string;
  readonly kind: WarrantyClaimUploadKind;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: bigint;
  readonly checksum: string;
  readonly uploadedByActorType: ActorType;
  readonly uploadedByActorRef?: string | null;
}

/**
 * Validates content type / size / checksum via `validateWarrantyUploadMetadata`
 * (the SAME check `~/jobs/warranty/ports`'s `createUploadDestination` already
 * applied before offering a destination — re-applied here rather than
 * trusted, because this is the actual write of attacker-reachable metadata
 * into Postgres). Never touches upload bytes — `storageKey` is a reference
 * into wherever the upload port put the object, not a path this function
 * reads from.
 */
export async function recordWarrantyClaimUpload(input: RecordWarrantyClaimUploadInput): Promise<WarrantyClaimUpload> {
  const validation = validateWarrantyUploadMetadata({
    kind: input.kind,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
  });
  if (!validation.ok) throw new InvalidWarrantyClaimUploadError(validation.reason);

  return prisma.warrantyClaimUpload.create({
    data: {
      claimId: input.claimId,
      kind: input.kind,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      uploadedByActorType: input.uploadedByActorType,
      uploadedByActorRef: input.uploadedByActorRef ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads — criterion 165's boundary and criterion 170's single-query read.
//
// TWO NAMED, DELIBERATELY DIFFERENT FUNCTIONS. `getWarrantyClaimForCustomer`
// is the ONLY one task 5-3 (customer intake/status routes) may ever import.
// `getWarrantyClaimForStaffReview` is the ONLY function in this entire
// module that reads `warrantyClaimLocalJewellerAuthorization` — reaching
// jeweller data from anywhere else requires a deliberate new join, exactly
// as `WarrantyClaimLocalJewellerAuthorization`'s schema comment intends.
// ---------------------------------------------------------------------------

export interface WarrantyClaimCustomerUpload {
  readonly id: string;
  readonly kind: WarrantyClaimUploadKind;
  readonly contentType: string;
  readonly uploadedAt: Date;
}

export interface WarrantyClaimCustomerRemedy {
  readonly kind: WarrantyRemedyKind;
  readonly status: WarrantyClaimRemedyStatus;
  readonly refundAmountMinorUnits: bigint | null;
  readonly currency: string | null;
  readonly completedAt: Date | null;
}

export interface WarrantyClaimCustomerView {
  readonly id: string;
  readonly claimReference: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserName: string;
  readonly purchaserEmail: string;
  readonly submittedAt: Date;
  readonly status: WarrantyClaimStatus;
  /** Criterion 156's gate — pass straight to `mayIssueInboundShippingInstructions`. */
  readonly authorizedAt: Date | null;
  readonly inboundTrackingCarrier: string | null;
  readonly inboundTrackingNumber: string | null;
  readonly inboundInsuranceReference: string | null;
  readonly inboundInsuredValueMinorUnits: bigint | null;
  readonly inboundInsuredValueCurrency: string | null;
  readonly receivedAt: Date | null;
  readonly coverageDecision: WarrantyCoverageDecision | null;
  readonly coverageDecisionReason: string | null;
  readonly coverageDecidedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly remedy: WarrantyClaimCustomerRemedy | null;
  readonly uploads: readonly WarrantyClaimCustomerUpload[];
}

/**
 * CUSTOMER-SAFE READ. Built with an explicit `select` allowlist (not
 * `include`, which would default to every scalar column) so the set of
 * exposed fields is visible in one place and grep-able — and, critically,
 * so that leaking `warrantyClaimLocalJewellerAuthorization` here would
 * require someone to deliberately type
 * `remedy: { select: { localJewellerAuthorization: ... } } }`, not merely
 * forget to exclude it. Also drops internal staff identity fields
 * (`authorizedByActorRef`, `inspectedByActorRef`, `coverageDecidedByActorRef`,
 * the remedy's `decidedByActorRef`/`processorReference`) and upload
 * internals (`storageKey`, `checksum`) — none of that is a customer's
 * concern and some of it is an internal implementation detail (least
 * privilege / PII minimization, CLAUDE.md).
 */
export async function getWarrantyClaimForCustomer(claimId: string): Promise<WarrantyClaimCustomerView | null> {
  return prisma.warrantyClaim.findUnique({ where: { id: claimId }, select: CUSTOMER_VIEW_SELECT });
}

/** Same projection as `getWarrantyClaimForCustomer`, looked up by the customer/support-facing reference instead of the internal id. */
export async function getWarrantyClaimForCustomerByReference(claimReference: string): Promise<WarrantyClaimCustomerView | null> {
  return prisma.warrantyClaim.findUnique({ where: { claimReference }, select: CUSTOMER_VIEW_SELECT });
}

const CUSTOMER_VIEW_SELECT = {
  id: true,
  claimReference: true,
  orderRef: true,
  lineRef: true,
  customerRef: true,
  itemConfigurationDescription: true,
  purchaserName: true,
  purchaserEmail: true,
  submittedAt: true,
  status: true,
  authorizedAt: true,
  inboundTrackingCarrier: true,
  inboundTrackingNumber: true,
  inboundInsuranceReference: true,
  inboundInsuredValueMinorUnits: true,
  inboundInsuredValueCurrency: true,
  receivedAt: true,
  coverageDecision: true,
  coverageDecisionReason: true,
  coverageDecidedAt: true,
  resolvedAt: true,
  closedAt: true,
  remedy: {
    select: {
      kind: true,
      status: true,
      refundAmountMinorUnits: true,
      currency: true,
      completedAt: true,
    },
  },
  uploads: {
    select: { id: true, kind: true, contentType: true, uploadedAt: true },
    orderBy: { uploadedAt: "asc" },
  },
} satisfies Prisma.WarrantyClaimSelect;

export interface WarrantyClaimStaffView extends WarrantyClaim {
  readonly events: WarrantyClaimEvent[];
  readonly uploads: WarrantyClaimUpload[];
  readonly remedy: (WarrantyClaimRemedy & { localJewellerAuthorization: WarrantyClaimLocalJewellerAuthorization | null }) | null;
}

/**
 * STAFF-ONLY. Criterion 170 — the complete claim record (every column, full
 * event history, every upload, the remedy AND its jeweller authorization
 * when one exists) in one query. This is the one function in this module
 * that ever reads `warrantyClaimLocalJewellerAuthorization` — see the
 * section header above. Do not call this from any customer-facing route;
 * use `getWarrantyClaimForCustomer[ByReference]` there instead.
 */
export async function getWarrantyClaimForStaffReview(claimId: string): Promise<WarrantyClaimStaffView | null> {
  return prisma.warrantyClaim.findUnique({
    where: { id: claimId },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      uploads: { orderBy: { uploadedAt: "asc" } },
      remedy: { include: { localJewellerAuthorization: true } },
    },
  }) as Promise<WarrantyClaimStaffView | null>;
}
