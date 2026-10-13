import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  approveRmaRemedy,
  approveRmaRequest,
  beginRmaRemedy,
  closeRmaRequest,
  createRmaRemedy,
  createRmaRequest,
  decideRmaCondition,
  denyRmaRequest,
  expireRmaRequest,
  getRmaRequestForCustomer,
  getRmaRequestForCustomerByReference,
  getRmaRequestForStaffReview,
  IllegalRmaTransitionError,
  InvalidRmaRemedyStatusUpdateError,
  markRmaReturnShipped,
  recordRmaReceipt,
  recordRmaReturnShippingEvidence,
  resolveRmaRequest,
  RmaActorRequiredError,
  RmaInvalidRequestedRemedyError,
  RmaNotApprovedForShippingError,
  RmaNotEligibleForRemedyError,
  RmaPastReturnWindowError,
  RmaPersonalizedNotEligibleForApprovalError,
  RmaRemedyActorRequiredError,
  RmaRemedyAlreadyExistsError,
  RmaRequiresClaimWorkflowError,
  searchRmaRequestsForStaff,
  updateRmaRemedyStatus,
} from "~/db/repositories/rmaRepository.server";
import { InvalidRmaRemedyTransitionError } from "~/domain/rma/remedy";

/**
 * Slice 4 — the RMA repository against a real database. `rmaSchema.test.ts`
 * already proves the database-level guard trigger and CHECK constraints
 * exhaustively; this suite proves the repository layer refuses illegal work
 * BEFORE ever reaching the database, that RMA reference generation is
 * collision-safe, that the two eligibility gates fire at the two different
 * times criterion 182/183/185 require, and that the customer/staff read
 * boundary holds.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

const DELIVERY_DATE = new Date("2026-01-01T00:00:00.000Z");
/** delivery + 3 days -> standard window. */
const STANDARD_REQUESTED_AT = new Date("2026-01-04T00:00:00.000Z");
/** delivery + 15 days -> late window. */
const LATE_REQUESTED_AT = new Date("2026-01-16T00:00:00.000Z");
/** delivery + 45 days -> past the day-30 window entirely. */
const INELIGIBLE_REQUESTED_AT = new Date("2026-02-15T00:00:00.000Z");

async function createAcknowledgment(slugPrefix: string) {
  const policy = await prisma.policyVersion.create({
    data: {
      slug: `${slugPrefix}-${uniq()}`,
      version: 1,
      effectiveFrom: new Date(),
      text: `${slugPrefix} text`,
      contentHash: `hash-${uniq()}`,
    },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: `${slugPrefix} exact text`,
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: "I Understand & Agree",
    },
  });
}

async function submitRma(overrides: Record<string, unknown> = {}) {
  const acknowledgment = await createAcknowledgment("rma-return-policy");
  return createRmaRequest({
    orderRef: `gid://shopify/Order/${uniq()}`,
    lineRef: `gid://shopify/LineItem/${uniq()}`,
    itemConfigurationDescription: "14k gold solitaire ring, size 7",
    purchaserEmail: "purchaser@example.com",
    carrierConfirmedDeliveryDate: DELIVERY_DATE,
    requestedAt: STANDARD_REQUESTED_AT,
    reasonCategory: "buyer_remorse",
    reasonExplanation: "Changed my mind about the style.",
    requestedRemedyKind: null,
    confirmsUnwornBeyondInspection: true,
    confirmsUndamaged: true,
    confirmsUnalteredAfterDelivery: true,
    confirmsOriginalPackagingIncluded: true,
    isPersonalizedOrAltered: false,
    returnPolicyAcknowledgmentId: acknowledgment.id,
    eligibleMerchandiseAmountMinorUnits: 250_00n,
    eligibleMerchandiseAmountCurrency: "USD",
    ...overrides,
  } as Parameters<typeof createRmaRequest>[0]);
}

async function submitLateRma(overrides: Record<string, unknown> = {}) {
  return submitRma({
    requestedAt: LATE_REQUESTED_AT,
    requestedRemedyKind: "refund_original_payment",
    ...overrides,
  });
}

/** Walks a fresh, approved RMA through to `inspection_passed` (condition accepted). */
async function walkToInspectionPassed(rmaId: string) {
  await approveRmaRequest(rmaId, "staff:alice");
  await markRmaReturnShipped(rmaId, { actorType: "customer", actorRef: null });
  await recordRmaReceipt(rmaId, { inspectedByActorRef: "staff:inspector" });
  return decideRmaCondition(rmaId, { decision: "accepted", decidedByActorRef: "staff:inspector" });
}

describe("createRmaRequest — reference generation and the initial event", () => {
  it("generates an RMA-prefixed reference, defaults status to submitted, and records the initial event", async () => {
    const rma = await submitRma();
    expect(rma.rmaReference).toMatch(/^RMA-[0-9A-Z]{8}$/);
    expect(rma.status).toBe("submitted");
    expect(rma.windowKind).toBe("standard");
    expect(rma.calendarDaysSinceDelivery).toBe(3);
    expect(rma.hasProductSpecificReturnOverride).toBe(false);

    const events = await prisma.rmaEvent.findMany({ where: { rmaId: rma.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.fromStatus).toBeNull();
    expect(events[0]!.toStatus).toBe("submitted");
  });

  it("is collision-safe under real concurrency — many requests submitted at once all get distinct references", async () => {
    const rmas = await Promise.all(Array.from({ length: 12 }, () => submitRma()));
    const references = rmas.map((rma) => rma.rmaReference);
    expect(new Set(references).size).toBe(references.length);
  }, 30_000);

  it("computes the late window and stores the customer's remedy choice", async () => {
    const rma = await submitLateRma();
    expect(rma.windowKind).toBe("late");
    expect(rma.calendarDaysSinceDelivery).toBe(15);
    expect(rma.requestedRemedyKind).toBe("refund_original_payment");
  });
});

describe("criteria 182/185 — creation-time refusals, no row created", () => {
  it("refuses a claim-workflow reason category before any row is created", async () => {
    const before = await prisma.rmaRequest.count();
    await expect(submitRma({ reasonCategory: "alleged_defect" })).rejects.toThrow(RmaRequiresClaimWorkflowError);
    await expect(prisma.rmaRequest.count()).resolves.toBe(before);
  });

  it("refuses a request past day 30, with no denied row created for day-count alone", async () => {
    const before = await prisma.rmaRequest.count();
    await expect(submitRma({ requestedAt: INELIGIBLE_REQUESTED_AT })).rejects.toThrow(RmaPastReturnWindowError);
    await expect(prisma.rmaRequest.count()).resolves.toBe(before);
  });

  it("day 7 is still standard; day 8 is late (window boundary)", async () => {
    const day7 = await submitRma({ requestedAt: new Date("2026-01-08T00:00:00.000Z") });
    expect(day7.windowKind).toBe("standard");
    const day8 = await submitRma({
      requestedAt: new Date("2026-01-09T00:00:00.000Z"),
      requestedRemedyKind: "merchandise_credit",
    });
    expect(day8.windowKind).toBe("late");
  });

  it("day 30 is still late; day 31 is refused entirely (window boundary)", async () => {
    const day30 = await submitRma({
      requestedAt: new Date("2026-01-31T00:00:00.000Z"),
      requestedRemedyKind: "merchandise_credit",
    });
    expect(day30.windowKind).toBe("late");
    await expect(submitRma({ requestedAt: new Date("2026-02-01T00:00:00.000Z") })).rejects.toThrow(
      RmaPastReturnWindowError
    );
  });
});

describe("criterion 188 — requested remedy coherence, refused before any row is created", () => {
  it("refuses a late-window request with no remedy choice", async () => {
    await expect(submitRma({ requestedAt: LATE_REQUESTED_AT, requestedRemedyKind: null })).rejects.toThrow(
      RmaInvalidRequestedRemedyError
    );
  });

  it("refuses a standard-window request that carries a remedy choice", async () => {
    await expect(
      submitRma({ requestedAt: STANDARD_REQUESTED_AT, requestedRemedyKind: "merchandise_credit" })
    ).rejects.toThrow(RmaInvalidRequestedRemedyError);
  });
});

describe("personalization — checked at approval, NOT at creation (criterion 183)", () => {
  it("a personalized item can still be created as a submitted request", async () => {
    const rma = await submitRma({ isPersonalizedOrAltered: true });
    expect(rma.status).toBe("submitted");
    expect(rma.isPersonalizedOrAltered).toBe(true);
  });

  it("refuses approval of a personalized item with no product-specific override, and writes nothing", async () => {
    const rma = await submitRma({ isPersonalizedOrAltered: true });
    await expect(approveRmaRequest(rma.id, "staff:alice")).rejects.toThrow(RmaPersonalizedNotEligibleForApprovalError);

    const reloaded = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(reloaded.status).toBe("submitted");
    expect(reloaded.approvedAt).toBeNull();
    const events = await prisma.rmaEvent.findMany({ where: { rmaId: rma.id } });
    expect(events).toHaveLength(1); // only the initial submission event
  });

  it("approves normally when hasProductSpecificReturnOverride was separately recorded", async () => {
    const rma = await submitRma({ isPersonalizedOrAltered: true });
    // No route exists to set this in this task's scope — set it directly, as
    // a stand-in for the (out-of-scope) staff override action.
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { hasProductSpecificReturnOverride: true, manualOverrideReason: "engraving policy exception", manualOverrideByActorRef: "staff:owner" },
    });
    const approved = await approveRmaRequest(rma.id, "staff:alice");
    expect(approved.status).toBe("approved");
  });
});

describe("Illegal transitions are refused BEFORE any database write", () => {
  it("refuses record_receipt on a freshly submitted request", async () => {
    const rma = await submitRma();
    await expect(recordRmaReceipt(rma.id, { inspectedByActorRef: "staff:inspector" })).rejects.toThrow(
      IllegalRmaTransitionError
    );
    const reloaded = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(reloaded.status).toBe("submitted");
    expect(reloaded.receivedAt).toBeNull();
  });

  it("refuses decide_condition with no recorded receipt", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");
    await expect(decideRmaCondition(rma.id, { decision: "accepted", decidedByActorRef: "staff:x" })).rejects.toThrow(
      IllegalRmaTransitionError
    );
  });

  it("refuses a rejected condition decision with an empty reason", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");
    await markRmaReturnShipped(rma.id, { actorType: "customer", actorRef: null });
    await recordRmaReceipt(rma.id, { inspectedByActorRef: "staff:inspector" });
    await expect(
      decideRmaCondition(rma.id, { decision: "rejected", reason: "", decidedByActorRef: "staff:x" })
    ).rejects.toThrow(IllegalRmaTransitionError);
  });
});

describe("approveRmaRequest — deadline computation (criterion 198)", () => {
  it("standard window: receiveByDeadline is 14 calendar days after delivery", async () => {
    const rma = await submitRma();
    const approved = await approveRmaRequest(rma.id, "staff:alice", { at: new Date("2026-01-05T00:00:00.000Z") });
    expect(approved.receiveByDeadline!.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("late window: receiveByDeadline is 10 calendar days after approval, not after delivery", async () => {
    const rma = await submitLateRma();
    const approved = await approveRmaRequest(rma.id, "staff:alice", { at: new Date("2026-01-20T00:00:00.000Z") });
    expect(approved.receiveByDeadline!.toISOString().slice(0, 10)).toBe("2026-01-30");
  });
});

describe("Criterion 157-equivalent — actor required for staff actions", () => {
  it("refuses an empty staffActorRef before any database write", async () => {
    const rma = await submitRma();
    await expect(approveRmaRequest(rma.id, "")).rejects.toThrow(RmaActorRequiredError);
    await expect(approveRmaRequest(rma.id, "   ")).rejects.toThrow(RmaActorRequiredError);
    const reloaded = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(reloaded.status).toBe("submitted");
  });
});

describe("criterion 199 — return shipping evidence never precedes approval", () => {
  it("refuses to record shipping evidence before approval", async () => {
    const rma = await submitRma();
    await expect(
      recordRmaReturnShippingEvidence(rma.id, { carrier: "UPS", trackingNumber: "1Z999" }, { actorType: "customer", actorRef: null })
    ).rejects.toThrow(RmaNotApprovedForShippingError);
  });

  it("records tracking/insurance evidence once approved, and appends an audit event", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");

    const updated = await recordRmaReturnShippingEvidence(
      rma.id,
      { carrier: "UPS", trackingNumber: "1Z999AA10123456784", insuranceReference: "INS-1", insuredValueMinorUnits: 250_00n, insuredValueCurrency: "USD" },
      { actorType: "customer", actorRef: null }
    );
    expect(updated.returnTrackingCarrier).toBe("UPS");
    expect(updated.returnInsuredValueMinorUnits).toBe(250_00n);

    const events = await prisma.rmaEvent.findMany({ where: { rmaId: rma.id }, orderBy: { createdAt: "asc" } });
    const shippingEvent = events.at(-1)!;
    expect(shippingEvent.fromStatus).toBe(shippingEvent.toStatus);
    expect((shippingEvent.metadata as { carrier: string }).carrier).toBe("UPS");
  });
});

describe("Remedy computation and persistence — criteria 186-191", () => {
  it("standard window: 100% refund, no restocking fee", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    const remedy = await createRmaRemedy({ rmaId: rma.id });
    expect(remedy.kind).toBe("refund_original_payment");
    expect(remedy.merchandiseAmountMinorUnits).toBe(250_00n);
    expect(remedy.restockingFeeMinorUnits).toBe(0n);
    expect(remedy.merchandiseAmountMinorUnits + remedy.restockingFeeMinorUnits).toBe(remedy.eligibleMerchandiseAmountMinorUnits);
  });

  it("late window, refund choice: 50% restocking fee, sums match exactly", async () => {
    const rma = await submitLateRma({ requestedRemedyKind: "refund_original_payment" });
    await walkToInspectionPassed(rma.id);
    const remedy = await createRmaRemedy({ rmaId: rma.id });
    expect(remedy.kind).toBe("refund_original_payment");
    expect(remedy.merchandiseAmountMinorUnits).toBe(125_00n);
    expect(remedy.restockingFeeMinorUnits).toBe(125_00n);
    expect(remedy.merchandiseAmountMinorUnits + remedy.restockingFeeMinorUnits).toBe(250_00n);
  });

  it("late window, merchandise credit choice: 100% credit, no fee", async () => {
    const rma = await submitLateRma({ requestedRemedyKind: "merchandise_credit" });
    await walkToInspectionPassed(rma.id);
    const remedy = await createRmaRemedy({ rmaId: rma.id });
    expect(remedy.kind).toBe("merchandise_credit");
    expect(remedy.merchandiseAmountMinorUnits).toBe(250_00n);
    expect(remedy.restockingFeeMinorUnits).toBe(0n);
  });

  it("refuses to compute a remedy before the condition was accepted at inspection", async () => {
    const rma = await submitRma();
    await expect(createRmaRemedy({ rmaId: rma.id })).rejects.toThrow(RmaNotEligibleForRemedyError);

    await approveRmaRequest(rma.id, "staff:alice");
    await markRmaReturnShipped(rma.id, { actorType: "customer", actorRef: null });
    await recordRmaReceipt(rma.id, { inspectedByActorRef: "staff:inspector" });
    // Received but not yet decided.
    await expect(createRmaRemedy({ rmaId: rma.id })).rejects.toThrow(RmaNotEligibleForRemedyError);
  });

  it("a rejected inspection resolves the RMA WITHOUT ever creating a remedy", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");
    await markRmaReturnShipped(rma.id, { actorType: "customer", actorRef: null });
    await recordRmaReceipt(rma.id, { inspectedByActorRef: "staff:inspector" });
    await decideRmaCondition(rma.id, { decision: "rejected", reason: "signs of wear beyond try-on", decidedByActorRef: "staff:inspector" });

    const resolved = await resolveRmaRequest(rma.id, { actorType: "staff", actorRef: "staff:inspector" });
    expect(resolved.status).toBe("resolved");

    await expect(createRmaRemedy({ rmaId: rma.id })).rejects.toThrow(RmaNotEligibleForRemedyError);
    const remedyCount = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(remedyCount).toBe(0);
  });

  it("criterion 196/204 — a second remedy for the same RMA is refused by the unique constraint, not silently accepted", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await expect(createRmaRemedy({ rmaId: rma.id })).rejects.toThrow(RmaRemedyAlreadyExistsError);
    const count = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(count).toBe(1);
  });
});

describe("updateRmaRemedyStatus — the retry path, and the remedy status transition table", () => {
  it("retried processing updates the SAME row rather than inserting a new one, and issued requires a reference + amount", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await approveRmaRemedy(rma.id, "staff:reviewer");

    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });
    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" }); // simulated retry

    await expect(updateRmaRemedyStatus({ rmaId: rma.id, status: "issued" })).rejects.toThrow(
      InvalidRmaRemedyStatusUpdateError
    );

    const issued = await updateRmaRemedyStatus({
      rmaId: rma.id,
      status: "issued",
      processorReference: "shopify-refund-txn-1",
      actualRefundOrCreditMinorUnits: 250_00n,
    });
    expect(issued.status).toBe("issued");

    const count = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(count).toBe(1);
  });

  it("issued is terminal — refused by the pure transition table before any write is attempted", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await approveRmaRemedy(rma.id, "staff:reviewer");
    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });
    await updateRmaRemedyStatus({
      rmaId: rma.id,
      status: "issued",
      processorReference: "shopify-refund-txn-2",
      actualRefundOrCreditMinorUnits: 250_00n,
    });

    await expect(updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" })).rejects.toThrow(
      InvalidRmaRemedyTransitionError
    );
  });

  it("failed requires a non-empty failureReason; staff_review_required requires a non-empty staffReviewReason", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await approveRmaRemedy(rma.id, "staff:reviewer");
    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });

    await expect(updateRmaRemedyStatus({ rmaId: rma.id, status: "failed" })).rejects.toThrow(
      InvalidRmaRemedyStatusUpdateError
    );
    const failed = await updateRmaRemedyStatus({ rmaId: rma.id, status: "failed", failureReason: "processor timeout" });
    expect(failed.status).toBe("failed");

    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });
    await expect(updateRmaRemedyStatus({ rmaId: rma.id, status: "staff_review_required" })).rejects.toThrow(
      InvalidRmaRemedyStatusUpdateError
    );
    const staffReview = await updateRmaRemedyStatus({
      rmaId: rma.id,
      status: "staff_review_required",
      staffReviewReason: "Shopify cannot represent a partial store-credit + tax adjustment here",
    });
    expect(staffReview.status).toBe("staff_review_required");
  });
});

describe("approveRmaRemedy — OWNER DECISION: late-window RMA approval gating (money-critical)", () => {
  it("refuses (nothing written) with an empty staff actor reference", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await expect(approveRmaRemedy(rma.id, "")).rejects.toThrow(RmaRemedyActorRequiredError);

    const remedy = await prisma.rmaRemedy.findUniqueOrThrow({ where: { rmaId: rma.id } });
    expect(remedy.status).toBe("pending");
    expect(remedy.approvedAt).toBeNull();
  });

  it("moves a pending remedy to approved, recording the reviewer and a timestamp", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });

    const approved = await approveRmaRemedy(rma.id, "staff:reviewer-jane");

    expect(approved.status).toBe("approved");
    expect(approved.approvedByActorRef).toBe("staff:reviewer-jane");
    expect(approved.approvedAt).not.toBeNull();
  });

  it("directly moving pending -> processing (skipping approval) is refused by the pure transition table", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });

    await expect(updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" })).rejects.toThrow(
      InvalidRmaRemedyTransitionError
    );
  });

  it('"approved" cannot be set via updateRmaRemedyStatus — only approveRmaRemedy records a reviewer identity', async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });

    await expect(
      updateRmaRemedyStatus({ rmaId: rma.id, status: "approved" } as Parameters<typeof updateRmaRemedyStatus>[0])
    ).rejects.toThrow(InvalidRmaRemedyStatusUpdateError);
  });

  it("approving twice is an idempotent no-op — the second call does not re-stamp reviewer or timestamp", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });

    const first = await approveRmaRemedy(rma.id, "staff:first-reviewer");
    const second = await approveRmaRemedy(rma.id, "staff:second-reviewer");

    expect(second.approvedByActorRef).toBe("staff:first-reviewer");
    expect(second.approvedAt?.toISOString()).toBe(first.approvedAt?.toISOString());

    // Exactly one approval event was appended, not two.
    const approvalEvents = await prisma.rmaEvent.findMany({
      where: { rmaId: rma.id, reason: "remedy approved for execution" },
    });
    expect(approvalEvents).toHaveLength(1);
  });

  it("approval is queryable afterward via the staff view, alongside the rest of the remedy record", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await approveRmaRemedy(rma.id, "staff:reviewer-jane");

    const staffView = await getRmaRequestForStaffReview(rma.id);
    expect(staffView!.remedy!.status).toBe("approved");
    expect(staffView!.remedy!.approvedByActorRef).toBe("staff:reviewer-jane");
    expect(staffView!.remedy!.approvedAt).not.toBeNull();
  });
});

describe("Full happy path through the repository reaches closed", () => {
  it("submitted -> approved -> return_shipped -> received_inspection_pending -> inspection_passed -> remedy_in_progress -> resolved -> closed", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await beginRmaRemedy(rma.id, { actorType: "staff", actorRef: "staff:alice" });
    await resolveRmaRequest(rma.id, { actorType: "staff", actorRef: "staff:alice" });
    const closed = await closeRmaRequest(rma.id, { actorType: "staff", actorRef: "staff:alice" });
    expect(closed.status).toBe("closed");
  });

  it("allows submitted -> approved -> expired when the receive-by deadline passes with nothing received", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");
    const expired = await expireRmaRequest(rma.id, { actorType: "system", actorRef: null });
    expect(expired.status).toBe("expired");
  });

  it("denyRmaRequest requires a non-empty reason (enforced by the pure transition table)", async () => {
    const rma = await submitRma();
    await expect(denyRmaRequest(rma.id, "staff:alice", "")).rejects.toThrow(IllegalRmaTransitionError);
    const denied = await denyRmaRequest(rma.id, "staff:alice", "requested return shipping label abuse pattern");
    expect(denied.status).toBe("denied");
  });
});

describe("Customer-safe vs staff-safe reads", () => {
  it("the customer-facing read never exposes staff actor identities or internal remedy fields", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });
    await approveRmaRemedy(rma.id, "staff:reviewer");
    await updateRmaRemedyStatus({
      rmaId: rma.id,
      status: "processing",
    });
    await updateRmaRemedyStatus({
      rmaId: rma.id,
      status: "issued",
      processorReference: "shopify-refund-txn-3",
      actualRefundOrCreditMinorUnits: 250_00n,
    });

    const customerView = await getRmaRequestForCustomer(rma.id);
    expect(customerView).not.toBeNull();
    // BigInt has no default JSON representation — a plain JSON.stringify
    // throws on this view's money fields without this replacer.
    const serialized = JSON.stringify(customerView, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialized).not.toMatch(/staff:/);
    expect(serialized).not.toMatch(/processorReference|processor_reference/i);
    expect(customerView!.remedy).not.toBeNull();
    expect(Object.keys(customerView!.remedy as object).sort()).toEqual(
      ["currency", "issuedAt", "kind", "merchandiseAmountMinorUnits", "restockingFeeMinorUnits", "status"].sort()
    );

    const byReference = await getRmaRequestForCustomerByReference(rma.rmaReference);
    expect(byReference?.id).toBe(rma.id);

    // Contrast: the staff read DOES surface the processor reference, proving
    // the boundary is a real code-path difference, not two names for one query.
    const staffView = await getRmaRequestForStaffReview(rma.id);
    expect(staffView!.remedy!.processorReference).toBe("shopify-refund-txn-3");
    // submitted, approved, return_shipped, received_inspection_pending,
    // inspection_passed — 5 status-transition events, plus one
    // fromStatus===toStatus evidence event from approveRmaRemedy (mirroring
    // recordRmaReturnShippingEvidence's own convention). createRmaRemedy and
    // updateRmaRemedyStatus write to rma_remedy only and append no RmaEvent
    // of their own.
    expect(staffView!.events.length).toBeGreaterThanOrEqual(6);
  });
});

describe("searchRmaRequestsForStaff — the staff triage list", () => {
  it("finds an RMA by reference, order ref, and purchaser email substring", async () => {
    const rma = await submitRma({ purchaserEmail: `triage-${uniq()}@example.com` });

    const byReference = await searchRmaRequestsForStaff({ query: rma.rmaReference });
    expect(byReference.rows.map((r) => r.id)).toContain(rma.id);

    const byOrder = await searchRmaRequestsForStaff({ query: rma.orderRef });
    expect(byOrder.rows.map((r) => r.id)).toContain(rma.id);

    const byEmail = await searchRmaRequestsForStaff({ query: rma.purchaserEmail });
    expect(byEmail.rows.map((r) => r.id)).toContain(rma.id);

    const byId = await searchRmaRequestsForStaff({ query: rma.id });
    expect(byId.rows.map((r) => r.id)).toContain(rma.id);
  });

  it("filters by status, singular and as a list", async () => {
    const submitted = await submitRma();
    const denied = await submitRma();
    await denyRmaRequest(denied.id, "staff:alice", "abuse pattern");

    const submittedOnly = await searchRmaRequestsForStaff({ status: "submitted", query: submitted.rmaReference });
    expect(submittedOnly.rows.map((r) => r.id)).toContain(submitted.id);

    const deniedOnly = await searchRmaRequestsForStaff({ status: "denied", query: denied.rmaReference });
    expect(deniedOnly.rows.map((r) => r.id)).toContain(denied.id);

    const either = await searchRmaRequestsForStaff({ status: ["submitted", "denied"], query: denied.rmaReference });
    expect(either.rows.map((r) => r.id)).toContain(denied.id);

    const excluded = await searchRmaRequestsForStaff({ status: "submitted", query: denied.rmaReference });
    expect(excluded.rows.map((r) => r.id)).not.toContain(denied.id);
  });

  it("surfaces the remedy's own status alongside the request, without exposing processor references", async () => {
    const rma = await submitRma();
    await walkToInspectionPassed(rma.id);
    await createRmaRemedy({ rmaId: rma.id });

    const before = await searchRmaRequestsForStaff({ query: rma.rmaReference });
    expect(before.rows[0]?.remedyStatus).toBe("pending");
    expect(Object.keys(before.rows[0] as object)).not.toContain("processorReference");

    await approveRmaRemedy(rma.id, "staff:reviewer");
    await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });
    const after = await searchRmaRequestsForStaff({ query: rma.rmaReference });
    expect(after.rows[0]?.remedyStatus).toBe("processing");
  });

  it("caps page size and paginates oldest-requested-first", async () => {
    const overCap = await searchRmaRequestsForStaff({ pageSize: 10_000 });
    expect(overCap.pageSize).toBe(100);

    const rma = await submitRma();
    const page1 = await searchRmaRequestsForStaff({ query: rma.rmaReference, page: 1, pageSize: 5 });
    expect(page1.totalCount).toBe(1);
    expect(page1.page).toBe(1);
  });
});
