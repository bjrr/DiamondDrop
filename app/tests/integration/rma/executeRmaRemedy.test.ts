import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import {
  approveRmaRemedy,
  approveRmaRequest,
  beginRmaRemedy,
  createRmaRemedy,
  createRmaRequest,
  decideRmaCondition,
  getRmaRequestForStaffReview,
  markRmaReturnShipped,
  recordRmaReceipt,
  updateRmaRemedyStatus,
} from "~/db/repositories/rmaRepository.server";
import { executeRmaRemedy, RmaRemedyIllegalStateError } from "~/jobs/rma/executeRmaRemedy.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import { RecordingRmaRemedyExecutionPort } from "~/shopify/admin/rmaRemedyExecutionAdapter.server";

/**
 * `executeRmaRemedy` against a real database (D5/D7/D10, docs/specs/
 * SLICE-4-BUY-NOW-RMA.md criteria 192-197, 204). Uses the REAL
 * `idempotencyKeyRepository` (Postgres-backed) and REAL RMA repository
 * functions, with a `RecordingRmaRemedyExecutionPort` fake standing in for
 * Shopify itself — the same "real DB, faked external API" shape as
 * `rmaOrderLookupAdapter.server.ts`'s own recording fake, and the shape this
 * job's own header calls for: the refusals and retries are the point.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

const DELIVERY_DATE = new Date("2026-01-01T00:00:00.000Z");
const STANDARD_REQUESTED_AT = new Date("2026-01-04T00:00:00.000Z"); // day 3 -> standard window
const LATE_REQUESTED_AT = new Date("2026-01-16T00:00:00.000Z"); // day 15 -> late window

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

/**
 * Walks a fresh RMA all the way through to `remedy_in_progress` with a
 * computed, but NOT YET APPROVED, remedy row (status `pending`). Callers
 * that need to reach an executable remedy must call `approveRmaRemedy`
 * themselves — OWNER DECISION (late-window RMA approval gating) makes
 * `pending -> processing` illegal, so this helper deliberately stops one
 * step short of what `walkToApprovedRemedy` below does.
 */
async function walkToRemedyInProgress(rmaId: string) {
  await approveRmaRequest(rmaId, "staff:alice");
  await markRmaReturnShipped(rmaId, { actorType: "customer", actorRef: null });
  await recordRmaReceipt(rmaId, { inspectedByActorRef: "staff:inspector" });
  await decideRmaCondition(rmaId, { decision: "accepted", decidedByActorRef: "staff:inspector" });
  await createRmaRemedy({ rmaId });
  return beginRmaRemedy(rmaId, { actorType: "staff", actorRef: "staff:alice" });
}

/** `walkToRemedyInProgress` plus the OWNER-DECISION-required explicit staff approval, reaching an executable (`approved`) remedy. */
async function walkToApprovedRemedy(rmaId: string, staffActorRef = "staff:reviewer") {
  await walkToRemedyInProgress(rmaId);
  return approveRmaRemedy(rmaId, staffActorRef);
}

const SUGGESTED_FULL_REFUND = { merchandiseAmountMinorUnits: 250_00n, taxAmountMinorUnits: 18_75n, currency: "USD" };

describe("executeRmaRemedy — standard-window 100% refund", () => {
  it("issues via Shopify's own suggested refund, summing merchandise + tax exactly (never rederiving one from the other)", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("issued");
    expect(remedy.actualRefundOrCreditMinorUnits).toBe(268_75n);
    expect(remedy.shopifyTaxAdjustmentMinorUnits).toBe(18_75n);
    expect(remedy.processorReference).toBe(port.refundResult.reference);
    expect(port.refundCalls).toHaveLength(1);
    expect(port.refundCalls[0]).toMatchObject({ orderGid: rma.orderRef, lineItemGid: rma.lineRef, totalAmountMinorUnits: 268_75n });
    expect(port.storeCreditCalls).toHaveLength(0);
  });

  it("routes to staff_review_required — never guessing — when Shopify's suggested subtotal disagrees with the recorded remedy", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = { merchandiseAmountMinorUnits: 999_00n, taxAmountMinorUnits: 18_75n, currency: "USD" };

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("staff_review_required");
    expect(remedy.staffReviewReason).toMatch(/does not match/i);
    expect(port.refundCalls).toHaveLength(0);
  });

  it("routes to staff_review_required when Shopify cannot represent the line at all (null suggested refund)", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = null;

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("staff_review_required");
    expect(port.refundCalls).toHaveLength(0);
  });
});

describe("executeRmaRemedy — late-window merchandise credit (D5)", () => {
  it("issues native Shopify Store Credit for merchandise + Shopify's own tax figure", async () => {
    const rma = await submitRma({
      requestedAt: LATE_REQUESTED_AT,
      requestedRemedyKind: "merchandise_credit",
      customerRef: "gid://shopify/Customer/42",
    });
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("issued");
    expect(remedy.actualRefundOrCreditMinorUnits).toBe(268_75n);
    expect(port.storeCreditCalls).toHaveLength(1);
    expect(port.storeCreditCalls[0]).toMatchObject({ customerGid: "gid://shopify/Customer/42", amountMinorUnits: 268_75n });
    expect(port.refundCalls).toHaveLength(0);
  });

  it("routes to staff_review_required with NO Shopify call when the RMA carries no customer on file", async () => {
    const rma = await submitRma({
      requestedAt: LATE_REQUESTED_AT,
      requestedRemedyKind: "merchandise_credit",
      customerRef: null,
    });
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("staff_review_required");
    expect(remedy.staffReviewReason).toMatch(/no shopify customer/i);
    expect(port.storeCreditCalls).toHaveLength(0);
  });

  it("routes to staff_review_required (never a gift card) when Shopify has no store-credit account for the customer", async () => {
    const rma = await submitRma({
      requestedAt: LATE_REQUESTED_AT,
      requestedRemedyKind: "merchandise_credit",
      customerRef: "gid://shopify/Customer/42",
    });
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    port.storeCreditResult = null;

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("staff_review_required");
    expect(remedy.staffReviewReason).toMatch(/store credit account/i);
  });
});

describe("executeRmaRemedy — the 50% restocking-fee refund always routes to staff review (D7)", () => {
  it("never calls Shopify at all — the tax-on-a-partial-value case this codebase refuses to invent", async () => {
    const rma = await submitRma({ requestedAt: LATE_REQUESTED_AT, requestedRemedyKind: "refund_original_payment" });
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("staff_review_required");
    expect(remedy.staffReviewReason).toMatch(/restocking-fee/i);
    expect(port.suggestedRefundCalls).toHaveLength(0);
    expect(port.refundCalls).toHaveLength(0);
    expect(port.storeCreditCalls).toHaveLength(0);
  });
});

describe("executeRmaRemedy — preconditions refused before any Shopify call", () => {
  it("refuses when the RMA has not yet reached remedy_in_progress", async () => {
    const rma = await submitRma();
    await approveRmaRequest(rma.id, "staff:alice");
    await markRmaReturnShipped(rma.id, { actorType: "customer", actorRef: null });
    await recordRmaReceipt(rma.id, { inspectedByActorRef: "staff:inspector" });
    await decideRmaCondition(rma.id, { decision: "accepted", decidedByActorRef: "staff:inspector" });
    await createRmaRemedy({ rmaId: rma.id }); // remedy exists, but begin_remedy was never called
    const port = new RecordingRmaRemedyExecutionPort();

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(RmaRemedyIllegalStateError);
    expect(port.suggestedRefundCalls).toHaveLength(0);
  });

  it("an already-issued remedy is a read-only no-op, not a re-execution", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    await executeRmaRemedy(rma.id, { port });
    expect(port.refundCalls).toHaveLength(1);

    const second = await executeRmaRemedy(rma.id, { port });
    expect(second.status).toBe("issued");
    expect(port.refundCalls).toHaveLength(1); // no second call
  });
});

describe("executeRmaRemedy — OWNER DECISION: late-window RMA approval gating (money-critical)", () => {
  it("refuses to execute a computed-but-not-yet-approved remedy — no Shopify call is ever attempted", async () => {
    const rma = await submitRma();
    await walkToRemedyInProgress(rma.id); // stops at 'pending' — deliberately NOT approved
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(RmaRemedyIllegalStateError);
    expect(port.suggestedRefundCalls).toHaveLength(0);
    expect(port.refundCalls).toHaveLength(0);
    expect(port.storeCreditCalls).toHaveLength(0);

    const afterRefusal = await getRmaRequestForStaffReview(rma.id);
    expect(afterRefusal!.remedy!.status).toBe("pending");
  });

  it("refuses to execute a merchandise-credit remedy before approval either — the gate applies to BOTH remedy kinds", async () => {
    const rma = await submitRma({
      requestedAt: LATE_REQUESTED_AT,
      requestedRemedyKind: "merchandise_credit",
      customerRef: "gid://shopify/Customer/42",
    });
    await walkToRemedyInProgress(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(RmaRemedyIllegalStateError);
    expect(port.storeCreditCalls).toHaveLength(0);
  });

  it("refuses to execute the 50% restocking-fee remedy before approval — even though it never calls Shopify once running", async () => {
    const rma = await submitRma({ requestedAt: LATE_REQUESTED_AT, requestedRemedyKind: "refund_original_payment" });
    await walkToRemedyInProgress(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(RmaRemedyIllegalStateError);
  });

  it("records the approving reviewer and timestamp, queryable afterward", async () => {
    const rma = await submitRma();
    await walkToRemedyInProgress(rma.id);
    const before = new Date();

    const approved = await approveRmaRemedy(rma.id, "staff:reviewer-jane");

    expect(approved.status).toBe("approved");
    expect(approved.approvedByActorRef).toBe("staff:reviewer-jane");
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.approvedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const staffView = await getRmaRequestForStaffReview(rma.id);
    expect(staffView!.remedy!.approvedByActorRef).toBe("staff:reviewer-jane");
    expect(staffView!.remedy!.approvedAt).not.toBeNull();
  });

  it("approving twice issues at most once — the second approval is a no-op that does not re-stamp reviewer/timestamp", async () => {
    const rma = await submitRma();
    await walkToRemedyInProgress(rma.id);

    const firstApproval = await approveRmaRemedy(rma.id, "staff:first-reviewer");
    const secondApproval = await approveRmaRemedy(rma.id, "staff:second-reviewer");

    // The second call is an idempotent no-op: it does not overwrite who
    // approved it or when, and does not attempt a second transition.
    expect(secondApproval.approvedByActorRef).toBe("staff:first-reviewer");
    expect(secondApproval.approvedAt?.toISOString()).toBe(firstApproval.approvedAt?.toISOString());

    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    await executeRmaRemedy(rma.id, { port });
    await executeRmaRemedy(rma.id, { port }); // already issued — read-only no-op

    expect(port.refundCalls).toHaveLength(1); // issued exactly once
  });

  it("approving a remedy that is already past pending (e.g. issued) is a no-op, not an error", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id, "staff:original-reviewer");
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    await executeRmaRemedy(rma.id, { port });

    const reapproved = await approveRmaRemedy(rma.id, "staff:someone-else");
    expect(reapproved.status).toBe("issued");
    expect(reapproved.approvedByActorRef).toBe("staff:original-reviewer");
  });
});

describe("executeRmaRemedy — idempotent retry never calls Shopify twice", () => {
  it("a crash-recovery retry (remedy still 'processing') reuses the cached result with ZERO further Shopify calls", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);

    // Simulate a PRIOR attempt that got as far as "processing" and reached
    // Shopify (recorded a succeeded idempotency key) but crashed before
    // writing the remedy row to "issued".
    const processing = await updateRmaRemedyStatus({ rmaId: rma.id, status: "processing" });
    const key = `rma_remedy_issue:${processing.id}:${processing.updatedAt.toISOString()}`;
    const cachedOutcome = {
      outcome: "issued" as const,
      processorReference: "shopify-refund-from-prior-attempt",
      actualRefundOrCreditMinorUnits: "268875",
      shopifyTaxAdjustmentMinorUnits: "18875",
    };
    const created = await idempotencyKeyRepository.tryCreatePending(key, "rma_remedy_issue", { rmaId: rma.id });
    expect(created).toBe(true);
    await idempotencyKeyRepository.recordSuccess(key, cachedOutcome);

    const port = new RecordingRmaRemedyExecutionPort(); // would fail this test if called — no results seeded

    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("issued");
    expect(remedy.processorReference).toBe("shopify-refund-from-prior-attempt");
    expect(remedy.actualRefundOrCreditMinorUnits).toBe(268875n);
    expect(port.suggestedRefundCalls).toHaveLength(0);
    expect(port.refundCalls).toHaveLength(0);
    expect(port.storeCreditCalls).toHaveLength(0);
  });

  it("a genuine Shopify rejection marks the remedy failed, and a later retry mints a FRESH key that calls Shopify again", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    port.refundError = new AdminApiError("refundCreate", ["insufficient funds on gateway"]);

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(AdminApiError);
    const afterFailure = await getRmaRequestForStaffReview(rma.id);
    expect(afterFailure!.remedy!.status).toBe("failed");
    expect(afterFailure!.remedy!.failureReason).toMatch(/insufficient funds/i);
    expect(port.refundCalls).toHaveLength(1);

    port.refundError = null; // staff fixed the underlying problem
    const remedy = await executeRmaRemedy(rma.id, { port });

    expect(remedy.status).toBe("issued");
    expect(port.refundCalls).toHaveLength(2); // a genuinely NEW attempt, not a blocked replay
  });

  it("an ambiguous (non-AdminApiError) failure leaves the remedy at 'processing', never 'failed' — it might have already succeeded", async () => {
    const rma = await submitRma();
    await walkToApprovedRemedy(rma.id);
    const port = new RecordingRmaRemedyExecutionPort();
    port.suggestedRefundResult = SUGGESTED_FULL_REFUND;
    port.refundError = new Error("socket hang up"); // NOT an AdminApiError — classified in_doubt

    await expect(executeRmaRemedy(rma.id, { port })).rejects.toThrow(/socket hang up/);

    const afterFailure = await getRmaRequestForStaffReview(rma.id);
    expect(afterFailure!.remedy!.status).toBe("processing");
    expect(afterFailure!.remedy!.failureReason).toBeNull();
  });
});
