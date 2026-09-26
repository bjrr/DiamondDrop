import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  ActorType,
  RmaConditionDecision,
  RmaEvent,
  RmaReasonCategory,
  RmaRemedy,
  RmaRemedyKind,
  RmaRemedyStatus as PrismaRmaRemedyStatus,
  RmaRequest,
  RmaStatus,
  RmaWindowKind as PrismaRmaWindowKind,
} from "@prisma/client";

import { getRoundingRule, DEFAULT_ROUNDING_RULE_ID, type RoundingRuleId } from "~/domain/money/rounding";
import { requiresClaimWorkflow, type RmaReasonCategory as DomainRmaReasonCategory } from "~/domain/rma/eligibility";
import {
  assertRmaRemedyTransition,
  computeRmaRemedy,
  type RmaRemedyStatus,
  type RmaRemedyKind as DomainRmaRemedyKind,
} from "~/domain/rma/remedy";
import { decideRmaTransition, type RmaAction, type RmaTransitionState } from "~/domain/rma/status";
import {
  calendarDaysSinceDelivery as computeCalendarDaysSinceDelivery,
  classifyReturnWindow,
  computeReceiveByDeadline,
  validateRequestedRemedy,
  type RmaWindowKind,
} from "~/domain/rma/window";

import { prisma } from "../client.server";

/**
 * Buy Now RMA persistence (Slice 4, docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md,
 * docs/specs/SLICE-4-BUY-NOW-RMA.md criteria 180-204).
 *
 * Mirrors `warrantyClaimRepository.server.ts`'s architecture closely — see
 * that module's header for the fuller rationale of the shared patterns
 * (typed pre-write refusals, transitions decided by a pure function before
 * any write, reference-generation-by-retry, append-only event history,
 * customer-safe vs staff-safe reads). THIS MODULE NEVER REIMPLEMENTS the
 * pure domain rules in `~/domain/rma/{window,eligibility,remedy,status}` —
 * every status change goes through `decideRmaTransition`, every remedy
 * amount through `computeRmaRemedy`, every remedy status change through
 * `assertRmaRemedyTransition`, and creation-time eligibility through
 * `classifyReturnWindow`/`requiresClaimWorkflow`/`validateRequestedRemedy`.
 *
 * ============================================================================
 * TWO ELIGIBILITY GATES, AT TWO DIFFERENT TIMES — read this before touching
 * `createRmaRequest` or `approveRmaRequest`.
 * ============================================================================
 * `~/domain/rma/eligibility.ts`'s `evaluateRmaEligibility` composes THREE
 * checks in order: claim-workflow routing, personalization/alteration, then
 * window classification. This module deliberately does NOT call that
 * combined function once at creation, because criterion 183 states the
 * personalization check is "checked before an RMA can be approved" — NOT
 * before it can be created. Calling the combined gate once, at creation,
 * would either (a) block creation on a personalization/alteration fact the
 * policy explicitly defers to the approval decision, or (b) require special-
 * casing that one reasonCode out of the combined function's result, which is
 * more fragile than calling the two creation-time checks directly:
 *
 *   CREATION  (`createRmaRequest`): `requiresClaimWorkflow` (criterion 182 —
 *     refuses before any row exists, "route to the applicable workflow
 *     instead") and `classifyReturnWindow` (criterion 185 — an `"ineligible"`
 *     result, day 31+, is ALSO refused before any row exists; there is no
 *     `denied` row for day-count alone). Personalization is NOT checked here.
 *
 *   APPROVAL (`approveRmaRequest`): personalization/alteration IS checked
 *     here, against the row's own stored `isPersonalizedOrAltered` /
 *     `hasProductSpecificReturnOverride` — refused (nothing written) before
 *     `decideRmaTransition` ever runs, exactly the "checked... not merely
 *     stated in copy" guarantee criterion 183 requires.
 *
 * `hasProductSpecificReturnOverride` is NEVER an input this module accepts
 * from `createRmaRequest` — it is always `false` at creation (the schema
 * default). Recording a product-specific override is a staff/admin act with
 * no route in this task's scope; out of scope here means this module simply
 * has no function that sets it to `true`, so nothing downstream needs to
 * defend against a customer-asserted override.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RmaRequestNotFoundError extends Error {
  constructor(readonly rmaId: string) {
    super(`No rma_request with id ${rmaId}.`);
    this.name = "RmaRequestNotFoundError";
  }
}

/** Refused BEFORE any database write — see this module's header comment. */
export class IllegalRmaTransitionError extends Error {
  constructor(
    readonly rmaId: string,
    readonly fromStatus: RmaStatus,
    readonly action: string,
    readonly reason: string
  ) {
    super(`RMA ${rmaId}: cannot apply "${action}" from "${fromStatus}" — ${reason}`);
    this.name = "IllegalRmaTransitionError";
  }
}

export class RmaActorRequiredError extends Error {
  constructor(readonly action: string) {
    super(`"${action}" requires a non-empty staff actor reference.`);
    this.name = "RmaActorRequiredError";
  }
}

export class RmaReferenceGenerationExhaustedError extends Error {
  constructor(attempts: number) {
    super(`Could not generate a unique RMA reference after ${attempts} attempts.`);
    this.name = "RmaReferenceGenerationExhaustedError";
  }
}

/** Criterion 182 — refused before any row is created; the caller should route the customer to the applicable claim/warranty workflow. */
export class RmaRequiresClaimWorkflowError extends Error {
  constructor(readonly reasonCategory: RmaReasonCategory) {
    super(
      `Reason category "${reasonCategory}" routes to the applicable claim/warranty workflow, not this discretionary RMA workflow.`
    );
    this.name = "RmaRequiresClaimWorkflowError";
  }
}

/** Criterion 185 — refused before any row is created; there is no "denied" row for day-count alone. */
export class RmaPastReturnWindowError extends Error {
  constructor(readonly calendarDaysSinceDelivery: number) {
    super(
      `${calendarDaysSinceDelivery} calendar days since delivery is past the day-30 discretionary return window; no RMA can be created.`
    );
    this.name = "RmaPastReturnWindowError";
  }
}

/** Criterion 188 — mirrors `validateRequestedRemedy`'s refusal as a typed error. */
export class RmaInvalidRequestedRemedyError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid requested remedy: ${reason}`);
    this.name = "RmaInvalidRequestedRemedyError";
  }
}

/** Criterion 183 — refused BEFORE `approve` is even attempted against the transition table. */
export class RmaPersonalizedNotEligibleForApprovalError extends Error {
  constructor(readonly rmaId: string) {
    super(
      `RMA ${rmaId} is for personalized/altered merchandise with no product-specific return override recorded; it cannot be approved.`
    );
    this.name = "RmaPersonalizedNotEligibleForApprovalError";
  }
}

/** Criterion 199 — no return/shipping evidence may be recorded before an RMA reaches `approved`. */
export class RmaNotApprovedForShippingError extends Error {
  constructor(readonly rmaId: string) {
    super(`RMA ${rmaId} is not yet approved; no return shipping evidence may be recorded.`);
    this.name = "RmaNotApprovedForShippingError";
  }
}

/** Criterion 196/204 — refused by the `@@unique([rmaId])` constraint, not a read-then-write check. */
export class RmaRemedyAlreadyExistsError extends Error {
  constructor(readonly rmaId: string) {
    super(`RMA ${rmaId} already has a remedy recorded; remedies are decided at most once per RMA.`);
    this.name = "RmaRemedyAlreadyExistsError";
  }
}

export class RmaRemedyNotFoundError extends Error {
  constructor(readonly rmaId: string) {
    super(`RMA ${rmaId} has no remedy recorded yet.`);
    this.name = "RmaRemedyNotFoundError";
  }
}

/** A remedy may only be computed for an RMA whose item condition was accepted at inspection. */
export class RmaNotEligibleForRemedyError extends Error {
  constructor(readonly rmaId: string) {
    super(`RMA ${rmaId} has not had its condition accepted at inspection; a remedy cannot be computed.`);
    this.name = "RmaNotEligibleForRemedyError";
  }
}

/** Criterion 194/D7 — the fields the database's own CHECK constraints require for each remedy status, checked here first so a refusal is a typed error, not a raw Postgres exception. */
export class InvalidRmaRemedyStatusUpdateError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid RMA remedy status update: ${reason}`);
    this.name = "InvalidRmaRemedyStatusUpdateError";
  }
}

// ---------------------------------------------------------------------------
// Intake (criteria 180-188)
// ---------------------------------------------------------------------------

export interface RmaEventActor {
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly reason?: string | null;
  readonly metadata?: unknown;
}

export interface CreateRmaRequestInput {
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef?: string | null;
  readonly masterVariantId?: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserEmail: string;
  /** Criterion 184 — the authoritative deadline anchor. Date-only (time discarded by `~/domain/rma/window.ts`). */
  readonly carrierConfirmedDeliveryDate: Date;
  /** Defaults to `new Date()`. Exposed as a parameter so a caller (or a test) can pin it. */
  readonly requestedAt?: Date;
  readonly reasonCategory: RmaReasonCategory;
  readonly reasonExplanation: string;
  /** Required if and only if the computed window is `late` — validated via `validateRequestedRemedy`, never trusted as-is. */
  readonly requestedRemedyKind: RmaRemedyKind | null;
  readonly confirmsUnwornBeyondInspection: boolean;
  readonly confirmsUndamaged: boolean;
  readonly confirmsUnalteredAfterDelivery: boolean;
  readonly confirmsOriginalPackagingIncluded: boolean;
  /** Customer's own self-report — see this module's header for why `hasProductSpecificReturnOverride` is NOT a parameter here. */
  readonly isPersonalizedOrAltered: boolean;
  /** Criterion 180. Must already exist as an `Acknowledgment` row; this function does not create it. */
  readonly returnPolicyAcknowledgmentId: string;
  /**
   * Criteria 189-191 — resolved by the caller (the intake route, via
   * `RmaOrderLookupPort`) from Shopify's own line-item data, NEVER supplied
   * by the customer-facing request body as a bare number. This module still
   * treats it as an opaque input rather than fetching it itself, mirroring
   * `createWarrantyClaim`'s "order/line resolution is deliberately out of
   * scope here" boundary — the ORDER LOOKUP is the route's job, PERSISTING
   * the resolved amount immutably is this module's.
   */
  readonly eligibleMerchandiseAmountMinorUnits: bigint;
  readonly eligibleMerchandiseAmountCurrency: string;
  /** Recorded on the request's initial (`fromStatus: null -> "submitted"`) event. Defaults to `{ actorType: "customer", actorRef: null }`. */
  readonly actor?: RmaEventActor;
}

const RMA_REFERENCE_PREFIX = "RMA-";
// Crockford-style alphabet minus I, L, O, U — unambiguous read aloud or typed into a support ticket. Mirrors WarrantyClaim's claimReference strategy.
const RMA_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RMA_REFERENCE_SUFFIX_LENGTH = 8;
const MAX_RMA_REFERENCE_ATTEMPTS = 8;

function randomRmaReferenceSuffix(): string {
  const bytes = randomBytes(RMA_REFERENCE_SUFFIX_LENGTH);
  let out = "";
  for (const byte of bytes) {
    out += RMA_REFERENCE_ALPHABET[byte % RMA_REFERENCE_ALPHABET.length];
  }
  return out;
}

/**
 * Criteria 180-188. Refuses BEFORE any write for: claim-workflow routing
 * (criterion 182), the day-30 window (criterion 185), and an incoherent
 * remedy choice (criterion 188) — see this module's header for why
 * personalization is deliberately NOT checked here.
 *
 * `windowKind`/`calendarDaysSinceDelivery` are computed here, ONCE, and
 * persisted as the immutable snapshot `~/domain/rma/window.ts` and this
 * slice's `rma_request_guard` trigger both expect — never recomputed by any
 * other caller.
 */
export async function createRmaRequest(input: CreateRmaRequestInput): Promise<RmaRequest> {
  const requestedAt = input.requestedAt ?? new Date();
  const calendarDaysSinceDelivery = computeCalendarDaysSinceDelivery(input.carrierConfirmedDeliveryDate, requestedAt);

  // Criterion 182 — checked FIRST and unconditionally, before window even matters.
  if (requiresClaimWorkflow(input.reasonCategory as DomainRmaReasonCategory)) {
    throw new RmaRequiresClaimWorkflowError(input.reasonCategory);
  }

  const windowClassification = classifyReturnWindow(calendarDaysSinceDelivery);
  if (windowClassification === "ineligible") {
    throw new RmaPastReturnWindowError(calendarDaysSinceDelivery);
  }
  const windowKind: RmaWindowKind = windowClassification;

  const remedyValidation = validateRequestedRemedy(windowKind, input.requestedRemedyKind as DomainRmaRemedyKind | null);
  if (!remedyValidation.ok) {
    throw new RmaInvalidRequestedRemedyError(remedyValidation.reason);
  }

  const actor: RmaEventActor = input.actor ?? { actorType: "customer", actorRef: null };

  for (let attempt = 0; attempt < MAX_RMA_REFERENCE_ATTEMPTS; attempt++) {
    const rmaReference = `${RMA_REFERENCE_PREFIX}${randomRmaReferenceSuffix()}`;
    try {
      return await prisma.$transaction(async (tx) => {
        const rma = await tx.rmaRequest.create({
          data: {
            rmaReference,
            orderRef: input.orderRef,
            lineRef: input.lineRef,
            customerRef: input.customerRef ?? null,
            masterVariantId: input.masterVariantId ?? null,
            itemConfigurationDescription: input.itemConfigurationDescription,
            purchaserEmail: input.purchaserEmail,
            carrierConfirmedDeliveryDate: input.carrierConfirmedDeliveryDate,
            requestedAt,
            calendarDaysSinceDelivery,
            reasonCategory: input.reasonCategory,
            reasonExplanation: input.reasonExplanation,
            requestedRemedyKind: input.requestedRemedyKind,
            confirmsUnwornBeyondInspection: input.confirmsUnwornBeyondInspection,
            confirmsUndamaged: input.confirmsUndamaged,
            confirmsUnalteredAfterDelivery: input.confirmsUnalteredAfterDelivery,
            confirmsOriginalPackagingIncluded: input.confirmsOriginalPackagingIncluded,
            isPersonalizedOrAltered: input.isPersonalizedOrAltered,
            hasProductSpecificReturnOverride: false,
            returnPolicyAcknowledgmentId: input.returnPolicyAcknowledgmentId,
            windowKind: windowKind as PrismaRmaWindowKind,
            eligibleMerchandiseAmountMinorUnits: input.eligibleMerchandiseAmountMinorUnits,
            eligibleMerchandiseAmountCurrency: input.eligibleMerchandiseAmountCurrency,
          },
        });

        await tx.rmaEvent.create({
          data: {
            rmaId: rma.id,
            fromStatus: null,
            toStatus: "submitted",
            actorType: actor.actorType,
            actorRef: actor.actorRef,
            reason: actor.reason ?? "RMA requested",
            metadata: actor.metadata as Prisma.InputJsonValue | undefined,
          },
        });

        return rma;
      });
    } catch (error) {
      // The only unique constraint this INSERT can hit is rma_reference — a
      // collision means two DIFFERENT requests coincidentally generated the
      // same reference; the correct response is a fresh candidate and
      // another attempt, never re-reading someone else's request (same
      // reasoning as `createWarrantyClaim`'s own header comment).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        continue;
      }
      throw error;
    }
  }
  throw new RmaReferenceGenerationExhaustedError(MAX_RMA_REFERENCE_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// Status transitions — every status change goes through `decideRmaTransition`
// BEFORE any database write.
// ---------------------------------------------------------------------------

async function loadTransitionState(rmaId: string): Promise<RmaTransitionState & { id: string }> {
  const rma = await prisma.rmaRequest.findUnique({
    where: { id: rmaId },
    select: { id: true, status: true, receivedAt: true },
  });
  if (!rma) throw new RmaRequestNotFoundError(rmaId);
  return rma;
}

/**
 * Validates `action` against the request's CURRENT persisted state via
 * `decideRmaTransition`, throws `IllegalRmaTransitionError` on refusal
 * (nothing written), and otherwise applies the resulting status together
 * with `extraData` and appends the corresponding `RmaEvent` in one
 * transaction — mirrors `warrantyClaimRepository.server.ts`'s
 * `applyTransition` exactly.
 */
async function applyTransition(
  rmaId: string,
  action: RmaAction,
  event: RmaEventActor,
  extraData: Prisma.RmaRequestUpdateInput = {}
): Promise<RmaRequest> {
  const state = await loadTransitionState(rmaId);
  const decision = decideRmaTransition(state, action);
  if (!decision.ok) {
    throw new IllegalRmaTransitionError(rmaId, state.status, action.type, decision.reason);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.rmaRequest.update({
      where: { id: rmaId },
      data: { status: decision.nextStatus, ...extraData },
    });
    await tx.rmaEvent.create({
      data: {
        rmaId,
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

/**
 * Criterion 183 — the personalization/alteration gate, checked against the
 * row's OWN stored facts, before `decideRmaTransition` is ever consulted.
 * Sets `approvedAt`/`receiveByDeadline` in the same write as the transition
 * (criterion 198's deadline formula, computed via `computeReceiveByDeadline`
 * — imported, never re-derived).
 */
export async function approveRmaRequest(
  rmaId: string,
  staffActorRef: string,
  options: { readonly reason?: string; readonly at?: Date } = {}
): Promise<RmaRequest> {
  if (!staffActorRef.trim()) throw new RmaActorRequiredError("approve");

  const rma = await prisma.rmaRequest.findUnique({
    where: { id: rmaId },
    select: {
      isPersonalizedOrAltered: true,
      hasProductSpecificReturnOverride: true,
      windowKind: true,
      carrierConfirmedDeliveryDate: true,
    },
  });
  if (!rma) throw new RmaRequestNotFoundError(rmaId);
  if (rma.isPersonalizedOrAltered && !rma.hasProductSpecificReturnOverride) {
    throw new RmaPersonalizedNotEligibleForApprovalError(rmaId);
  }

  const approvedAt = options.at ?? new Date();
  const receiveByDeadline = computeReceiveByDeadline(rma.windowKind as RmaWindowKind, rma.carrierConfirmedDeliveryDate, approvedAt);

  return applyTransition(
    rmaId,
    { type: "approve" },
    { actorType: "staff", actorRef: staffActorRef, reason: options.reason ?? "RMA approved" },
    { approvedAt, approvedByActorRef: staffActorRef, receiveByDeadline }
  );
}

export async function denyRmaRequest(rmaId: string, staffActorRef: string, reason: string): Promise<RmaRequest> {
  if (!staffActorRef.trim()) throw new RmaActorRequiredError("deny");
  return applyTransition(
    rmaId,
    { type: "deny", reason },
    { actorType: "staff", actorRef: staffActorRef, reason },
    { deniedAt: new Date(), deniedByActorRef: staffActorRef, denialReason: reason }
  );
}

export async function markRmaReturnShipped(
  rmaId: string,
  actor: RmaEventActor,
  options: { readonly at?: Date } = {}
): Promise<RmaRequest> {
  return applyTransition(rmaId, { type: "mark_return_shipped" }, actor, { returnShippedAt: options.at ?? new Date() });
}

export async function expireRmaRequest(rmaId: string, actor: RmaEventActor, options: { readonly at?: Date } = {}): Promise<RmaRequest> {
  return applyTransition(rmaId, { type: "expire" }, actor, { expiredAt: options.at ?? new Date() });
}

export interface RecordRmaReceiptInput {
  readonly receivedAt?: Date;
  readonly packageCondition?: string;
  readonly itemCondition?: string;
  readonly inspectionNotes?: string;
  readonly inspectedByActorRef: string;
}

/** Criterion 202 — the ONLY function that sets `receivedAt`. */
export async function recordRmaReceipt(rmaId: string, input: RecordRmaReceiptInput): Promise<RmaRequest> {
  if (!input.inspectedByActorRef.trim()) throw new RmaActorRequiredError("record_receipt");
  return applyTransition(
    rmaId,
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

export interface DecideRmaConditionInput {
  readonly decision: RmaConditionDecision;
  /** Required (and validated non-empty) when `decision === "rejected"` — criterion 202. */
  readonly reason?: string;
  readonly decidedByActorRef: string;
}

export async function decideRmaCondition(rmaId: string, input: DecideRmaConditionInput): Promise<RmaRequest> {
  if (!input.decidedByActorRef.trim()) throw new RmaActorRequiredError("decide_condition");

  const action: RmaAction =
    input.decision === "accepted"
      ? { type: "decide_condition", decision: "accepted" }
      : { type: "decide_condition", decision: "rejected", reason: input.reason ?? "" };

  return applyTransition(
    rmaId,
    action,
    { actorType: "staff", actorRef: input.decidedByActorRef, reason: input.reason ?? null },
    {
      conditionDecision: input.decision,
      conditionDecisionReason: input.reason ?? null,
      conditionDecidedAt: new Date(),
      conditionDecidedByActorRef: input.decidedByActorRef,
    }
  );
}

export async function beginRmaRemedy(rmaId: string, actor: RmaEventActor): Promise<RmaRequest> {
  return applyTransition(rmaId, { type: "begin_remedy" }, actor);
}

export async function resolveRmaRequest(rmaId: string, actor: RmaEventActor, options: { readonly at?: Date } = {}): Promise<RmaRequest> {
  return applyTransition(rmaId, { type: "resolve" }, actor, { resolvedAt: options.at ?? new Date() });
}

export async function closeRmaRequest(rmaId: string, actor: RmaEventActor, options: { readonly at?: Date } = {}): Promise<RmaRequest> {
  return applyTransition(rmaId, { type: "close" }, actor, { closedAt: options.at ?? new Date() });
}

// ---------------------------------------------------------------------------
// Return shipping evidence (criterion 198) — data only, not a status
// transition. Gated on approval (criterion 199's `mayIssueReturnInstructions`
// spirit), still appended to the same append-only event history.
// ---------------------------------------------------------------------------

export interface RecordRmaReturnShippingEvidenceInput {
  readonly carrier?: string;
  readonly trackingNumber?: string;
  readonly insuranceReference?: string;
  readonly insuredValueMinorUnits?: bigint;
  readonly insuredValueCurrency?: string;
}

/** Criterion 199 — refuses (nothing written) if the RMA has not yet been approved. */
export async function recordRmaReturnShippingEvidence(
  rmaId: string,
  input: RecordRmaReturnShippingEvidenceInput,
  actor: RmaEventActor
): Promise<RmaRequest> {
  const rma = await prisma.rmaRequest.findUnique({ where: { id: rmaId }, select: { approvedAt: true, status: true } });
  if (!rma) throw new RmaRequestNotFoundError(rmaId);
  if (rma.approvedAt === null) throw new RmaNotApprovedForShippingError(rmaId);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.rmaRequest.update({
      where: { id: rmaId },
      data: {
        returnTrackingCarrier: input.carrier ?? undefined,
        returnTrackingNumber: input.trackingNumber ?? undefined,
        returnInsuranceReference: input.insuranceReference ?? undefined,
        returnInsuredValueMinorUnits: input.insuredValueMinorUnits ?? undefined,
        returnInsuredValueCurrency: input.insuredValueCurrency ?? undefined,
      },
    });
    // Not a status transition (fromStatus === toStatus) — exists so the
    // append-only history records WHEN tracking/insurance evidence was
    // supplied and by whom, mirroring
    // `recordWarrantyClaimInboundShippingEvidence`'s own event.
    await tx.rmaEvent.create({
      data: {
        rmaId,
        fromStatus: rma.status,
        toStatus: rma.status,
        actorType: actor.actorType,
        actorRef: actor.actorRef,
        reason: actor.reason ?? "return shipping evidence recorded",
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
// Remedy (criteria 186-197, 204) — computed ONLY from the request's own
// stored, immutable window/remedy-choice/amount snapshot, never recomputed
// from "today's" anything (D7/CLAUDE.md rule 7's generalisation).
// ---------------------------------------------------------------------------

export interface CreateRmaRemedyInput {
  readonly rmaId: string;
  readonly roundingRuleId?: RoundingRuleId;
}

/**
 * Criteria 186-191, 196, 204. Requires the request's item condition to have
 * been ACCEPTED at inspection (a repository-level guard, not merely relying
 * on the CHECK constraints, which say nothing about remedy rows at all —
 * mirrors `createWarrantyClaimRemedy`'s equivalent guard). Computes the
 * remedy via `computeRmaRemedy` — imported, never reimplemented — using
 * ONLY the request's own stored `windowKind`/`requestedRemedyKind`/
 * `eligibleMerchandiseAmountMinorUnits`/currency. Idempotency (criterion
 * 196/204) is the `@@unique([rmaId])` constraint: a second call for the same
 * RMA hits `P2002` and is refused via `RmaRemedyAlreadyExistsError`, never
 * silently returning the existing row — a second DECISION for the same RMA
 * is a genuine duplicate attempt to investigate, not an idempotent retry
 * (contrast `updateRmaRemedyStatus` below, which IS the retry path).
 */
export async function createRmaRemedy(input: CreateRmaRemedyInput): Promise<RmaRemedy> {
  const rma = await prisma.rmaRequest.findUnique({
    where: { id: input.rmaId },
    select: {
      windowKind: true,
      requestedRemedyKind: true,
      eligibleMerchandiseAmountMinorUnits: true,
      eligibleMerchandiseAmountCurrency: true,
      conditionDecision: true,
    },
  });
  if (!rma) throw new RmaRequestNotFoundError(input.rmaId);
  if (rma.conditionDecision !== "accepted") throw new RmaNotEligibleForRemedyError(input.rmaId);

  const roundingRuleId = input.roundingRuleId ?? DEFAULT_ROUNDING_RULE_ID;
  // Confirms the rule id is registered before it ever reaches computeRmaRemedy's Money boundary.
  getRoundingRule(roundingRuleId);

  const computation = computeRmaRemedy({
    windowKind: rma.windowKind as RmaWindowKind,
    requestedRemedyKind: rma.requestedRemedyKind as DomainRmaRemedyKind | null,
    eligibleMerchandiseAmountMinorUnits: rma.eligibleMerchandiseAmountMinorUnits,
    currency: rma.eligibleMerchandiseAmountCurrency,
    roundingRuleId,
  });

  try {
    return await prisma.rmaRemedy.create({
      data: {
        rmaId: input.rmaId,
        kind: computation.remedyKind,
        eligibleMerchandiseAmountMinorUnits: rma.eligibleMerchandiseAmountMinorUnits,
        merchandiseAmountMinorUnits: computation.merchandiseAmountMinorUnits,
        restockingFeeMinorUnits: computation.restockingFeeMinorUnits,
        currency: computation.currency,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new RmaRemedyAlreadyExistsError(input.rmaId);
    }
    throw error;
  }
}

export interface UpdateRmaRemedyStatusInput {
  readonly rmaId: string;
  readonly status: RmaRemedyStatus;
  readonly processorReference?: string;
  readonly failureReason?: string;
  readonly staffReviewReason?: string;
  readonly actualRefundOrCreditMinorUnits?: bigint;
  /** D7 — Shopify's own tax figure for the returned line(s). Never computed by this codebase. */
  readonly shopifyTaxAdjustmentMinorUnits?: bigint;
  readonly completedAt?: Date;
}

/**
 * The RETRY path (contrast `createRmaRemedy` above): always an UPDATE of the
 * single existing remedy row for `rmaId`, never a second INSERT. Validates
 * the requested status change via `assertRmaRemedyTransition` FIRST — the
 * pure transition table this remedy lifecycle is built on
 * (`~/domain/rma/remedy.ts`) — so an illegal transition (e.g. out of the
 * terminal `issued` state) is refused before any write, mirroring
 * `applyTransition`'s discipline for the request's own status machine.
 * Also checks the SAME per-status field requirements this slice's CHECK
 * constraints enforce (`rma_remedy_issued_has_reference`,
 * `rma_remedy_failed_has_reason`, `rma_remedy_staff_review_has_reason`) —
 * defense in depth over the database, not a substitute for it.
 *
 * SAME-STATUS CALLS ARE AN IDEMPOTENT NO-OP, NOT A TRANSITION.
 * `~/domain/rma/remedy.ts`'s `ALLOWED_REMEDY_TRANSITIONS` deliberately has no
 * self-loop on `processing` (or any other status) — it describes legal STATE
 * CHANGES, not "the caller asked for the state it is already in." A caller
 * that retries "mark this remedy processing" after a crash right after the
 * first successful call must not be refused merely because nothing actually
 * needs to change — that would turn an idempotent retry into a hard failure,
 * exactly what CLAUDE.md's "every state-changing event must be idempotent"
 * rule exists to prevent. So `assertRmaRemedyTransition` is only consulted
 * when the requested status genuinely differs from the current one; a
 * same-status call still re-applies any other supplied fields (e.g. a
 * refreshed `processorReference`) but never re-validates a transition that
 * was never being requested.
 */
export async function updateRmaRemedyStatus(input: UpdateRmaRemedyStatusInput): Promise<RmaRemedy> {
  const existing = await prisma.rmaRemedy.findUnique({ where: { rmaId: input.rmaId } });
  if (!existing) throw new RmaRemedyNotFoundError(input.rmaId);

  if (input.status !== existing.status) {
    assertRmaRemedyTransition(existing.status as RmaRemedyStatus, input.status);
  }

  if (input.status === "issued") {
    if (!input.processorReference?.trim()) {
      throw new InvalidRmaRemedyStatusUpdateError("issued requires a non-empty processorReference");
    }
    if (input.actualRefundOrCreditMinorUnits === undefined) {
      throw new InvalidRmaRemedyStatusUpdateError("issued requires actualRefundOrCreditMinorUnits");
    }
  }
  if (input.status === "failed" && !input.failureReason?.trim()) {
    throw new InvalidRmaRemedyStatusUpdateError("failed requires a non-empty failureReason");
  }
  if (input.status === "staff_review_required" && !input.staffReviewReason?.trim()) {
    throw new InvalidRmaRemedyStatusUpdateError("staff_review_required requires a non-empty staffReviewReason");
  }

  return prisma.rmaRemedy.update({
    where: { rmaId: input.rmaId },
    data: {
      status: input.status as PrismaRmaRemedyStatus,
      processorReference: input.processorReference ?? existing.processorReference,
      failureReason: input.status === "failed" ? (input.failureReason ?? existing.failureReason) : null,
      staffReviewReason: input.status === "staff_review_required" ? (input.staffReviewReason ?? existing.staffReviewReason) : null,
      actualRefundOrCreditMinorUnits: input.actualRefundOrCreditMinorUnits ?? existing.actualRefundOrCreditMinorUnits,
      shopifyTaxAdjustmentMinorUnits: input.shopifyTaxAdjustmentMinorUnits ?? existing.shopifyTaxAdjustmentMinorUnits,
      issuedAt: input.status === "issued" ? (input.completedAt ?? new Date()) : existing.issuedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads — TWO NAMED, DELIBERATELY DIFFERENT FUNCTIONS, mirroring
// `warrantyClaimRepository.server.ts`'s own split.
// `getRmaRequestForCustomer[ByReference]` is the ONLY read a customer-facing
// route may use. A CALLER deriving identity from the signed App Proxy
// `logged_in_customer_id` (never a client-supplied field — see
// `apps.carat.warranty-order-lookup.tsx`'s own doc comment for why) is
// responsible for checking the returned row's `customerRef` matches before
// exposing it to that caller; this function does not filter by customer
// itself, matching `getWarrantyClaimForCustomer`'s exact contract.
// `getRmaRequestForStaffReview` is STAFF-ONLY — the complete record
// (criterion 203).
// ---------------------------------------------------------------------------

export interface RmaCustomerRemedyView {
  readonly kind: RmaRemedyKind;
  readonly status: PrismaRmaRemedyStatus;
  readonly merchandiseAmountMinorUnits: bigint;
  readonly restockingFeeMinorUnits: bigint;
  readonly currency: string;
  readonly issuedAt: Date | null;
}

export interface RmaCustomerView {
  readonly id: string;
  readonly rmaReference: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserEmail: string;
  readonly requestedAt: Date;
  readonly status: RmaStatus;
  readonly windowKind: PrismaRmaWindowKind;
  readonly requestedRemedyKind: RmaRemedyKind | null;
  readonly approvedAt: Date | null;
  readonly receiveByDeadline: Date | null;
  readonly deniedAt: Date | null;
  readonly denialReason: string | null;
  readonly returnTrackingCarrier: string | null;
  readonly returnTrackingNumber: string | null;
  readonly returnInsuranceReference: string | null;
  readonly returnInsuredValueMinorUnits: bigint | null;
  readonly returnInsuredValueCurrency: string | null;
  readonly expiredAt: Date | null;
  readonly receivedAt: Date | null;
  readonly conditionDecision: RmaConditionDecision | null;
  readonly conditionDecisionReason: string | null;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly remedy: RmaCustomerRemedyView | null;
}

const CUSTOMER_VIEW_SELECT = {
  id: true,
  rmaReference: true,
  orderRef: true,
  lineRef: true,
  customerRef: true,
  itemConfigurationDescription: true,
  purchaserEmail: true,
  requestedAt: true,
  status: true,
  windowKind: true,
  requestedRemedyKind: true,
  approvedAt: true,
  receiveByDeadline: true,
  deniedAt: true,
  denialReason: true,
  returnTrackingCarrier: true,
  returnTrackingNumber: true,
  returnInsuranceReference: true,
  returnInsuredValueMinorUnits: true,
  returnInsuredValueCurrency: true,
  expiredAt: true,
  receivedAt: true,
  conditionDecision: true,
  conditionDecisionReason: true,
  resolvedAt: true,
  closedAt: true,
  remedy: {
    select: {
      kind: true,
      status: true,
      merchandiseAmountMinorUnits: true,
      restockingFeeMinorUnits: true,
      currency: true,
      issuedAt: true,
    },
  },
} satisfies Prisma.RmaRequestSelect;

/**
 * CUSTOMER-SAFE READ. Explicit `select` allowlist (not `include`) — drops
 * internal staff identity fields (`approvedByActorRef`, `deniedByActorRef`,
 * `inspectedByActorRef`, `conditionDecidedByActorRef`, the remedy's
 * `processorReference`/`eligibleMerchandiseAmountMinorUnits`/
 * `shopifyTaxAdjustmentMinorUnits`/`failureReason`/`staffReviewReason`) and
 * internal notes (`packageCondition`, `itemCondition`, `inspectionNotes`,
 * `manualOverrideReason`/`ByActorRef`) — none of that is a customer's
 * concern (least privilege / PII minimization, CLAUDE.md).
 */
export async function getRmaRequestForCustomer(rmaId: string): Promise<RmaCustomerView | null> {
  return prisma.rmaRequest.findUnique({ where: { id: rmaId }, select: CUSTOMER_VIEW_SELECT });
}

/** Same projection as `getRmaRequestForCustomer`, looked up by the customer/support-facing reference instead of the internal id. */
export async function getRmaRequestForCustomerByReference(rmaReference: string): Promise<RmaCustomerView | null> {
  return prisma.rmaRequest.findUnique({ where: { rmaReference }, select: CUSTOMER_VIEW_SELECT });
}

export interface RmaStaffView extends RmaRequest {
  readonly events: RmaEvent[];
  readonly remedy: RmaRemedy | null;
}

/**
 * STAFF-ONLY. Criterion 203 — the complete RMA record (every column, full
 * event history, and the remedy when one exists) in one query, sufficient to
 * defend a chargeback (policy §11/§12).
 */
export async function getRmaRequestForStaffReview(rmaId: string): Promise<RmaStaffView | null> {
  return prisma.rmaRequest.findUnique({
    where: { id: rmaId },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      remedy: true,
    },
  }) as Promise<RmaStaffView | null>;
}
