import { describe, expect, it } from "vitest";

import type { Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";

/**
 * Slice 4 — rma_request / rma_event / rma_remedy (docs/specs/SLICE-4-BUY-NOW-RMA.md)
 * against a real database. No repository layer exists yet (a later task), so
 * these tests use `prisma.rmaRequest.*` etc. directly for fixtures, and raw
 * SQL where the point is to prove a constraint holds even against a caller
 * that bypasses application code entirely — same convention as
 * `warrantyClaimSchema.test.ts`.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

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

async function createRma(overrides: Partial<Prisma.RmaRequestUncheckedCreateInput> = {}) {
  const acknowledgment = await createAcknowledgment("rma-return-policy");

  return prisma.rmaRequest.create({
    data: {
      rmaReference: `RMA-${uniq()}`,
      orderRef: `gid://shopify/Order/${uniq()}`,
      lineRef: `gid://shopify/LineItem/${uniq()}`,
      itemConfigurationDescription: "14k gold solitaire ring, size 7",
      purchaserEmail: "purchaser@example.com",
      carrierConfirmedDeliveryDate: new Date("2026-01-01"),
      calendarDaysSinceDelivery: 3,
      reasonCategory: "buyer_remorse",
      reasonExplanation: "Changed my mind about the style.",
      confirmsUnwornBeyondInspection: true,
      confirmsUndamaged: true,
      confirmsUnalteredAfterDelivery: true,
      confirmsOriginalPackagingIncluded: true,
      isPersonalizedOrAltered: false,
      returnPolicyAcknowledgmentId: acknowledgment.id,
      windowKind: "standard",
      eligibleMerchandiseAmountMinorUnits: 250_00n,
      eligibleMerchandiseAmountCurrency: "USD",
      ...overrides,
    },
  });
}

/** Advances a fixture RMA through submitted -> approved, returning the updated row. */
async function approve(rmaId: string, overrides: Partial<Prisma.RmaRequestUncheckedUpdateInput> = {}) {
  return prisma.rmaRequest.update({
    where: { id: rmaId },
    data: {
      status: "approved",
      approvedAt: new Date(),
      approvedByActorRef: "staff:alice",
      receiveByDeadline: new Date("2026-01-15"),
      ...overrides,
    },
  });
}

/**
 * Walks a fresh fixture RMA all the way through submitted -> approved ->
 * received_inspection_pending -> inspection_passed (condition_decision =
 * 'accepted'). Every fixture that creates an `rma_remedy` row must build its
 * parent this way now that `rma_remedy_requires_accepted_inspection`
 * (migration 20260928040000) refuses the INSERT otherwise — mirrors this
 * file's own `receivedRma()` helper, promoted to top level because remedy
 * fixtures across multiple `describe` blocks need it, not just the
 * condition-decision block that originally defined the shorter version.
 */
async function acceptedRma(overrides: Partial<Prisma.RmaRequestUncheckedCreateInput> = {}) {
  const rma = await createRma(overrides);
  await approve(rma.id);
  await prisma.rmaRequest.update({
    where: { id: rma.id },
    data: { status: "received_inspection_pending", receivedAt: new Date() },
  });
  return prisma.rmaRequest.update({
    where: { id: rma.id },
    data: {
      status: "inspection_passed",
      conditionDecision: "accepted",
      conditionDecidedAt: new Date(),
      conditionDecidedByActorRef: "staff:alice",
    },
  });
}

describe("rma_request — required evidence and defaults", () => {
  it("defaults to status submitted with no approval/denial recorded", async () => {
    const rma = await createRma();
    expect(rma.status).toBe("submitted");
    expect(rma.approvedAt).toBeNull();
    expect(rma.deniedAt).toBeNull();
    expect(rma.receivedAt).toBeNull();
  });

  it("cannot be created without the return-policy acknowledgment", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_request" (
           id, rma_reference, order_ref, line_ref, item_configuration_description,
           purchaser_email, carrier_confirmed_delivery_date, calendar_days_since_delivery,
           reason_category, reason_explanation,
           confirms_unworn_beyond_inspection, confirms_undamaged, confirms_unaltered_after_delivery,
           confirms_original_packaging_included, is_personalized_or_altered,
           return_policy_acknowledgment_id, window_kind,
           eligible_merchandise_amount_minor_units, eligible_merchandise_amount_currency,
           updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'desc', 'a@example.com', '2026-01-01', 3,
           'buyer_remorse', 'reason',
           true, true, true, true, false,
           NULL, 'standard', 25000, 'USD', CURRENT_TIMESTAMP
         )`,
        `RMA-${uniq()}`,
        `gid://shopify/Order/${uniq()}`,
        `gid://shopify/LineItem/${uniq()}`
      )
    ).rejects.toThrow();
  });
});

describe("rma_request_requested_remedy_coherent — criterion 188", () => {
  it("standard window with no requested remedy is accepted", async () => {
    const rma = await createRma({ windowKind: "standard", requestedRemedyKind: null });
    expect(rma.requestedRemedyKind).toBeNull();
  });

  it("refuses a standard-window request that carries a remedy choice", async () => {
    await expect(createRma({ windowKind: "standard", requestedRemedyKind: "merchandise_credit" })).rejects.toThrow();
  });

  it("refuses a late-window request with no remedy choice", async () => {
    await expect(createRma({ windowKind: "late", requestedRemedyKind: null })).rejects.toThrow();
  });

  it("accepts a late-window request with a remedy choice", async () => {
    const rma = await createRma({ windowKind: "late", requestedRemedyKind: "refund_original_payment" });
    expect(rma.requestedRemedyKind).toBe("refund_original_payment");
  });
});

describe("rma_request_deadline_requires_approval", () => {
  it("a submitted request cannot carry an approval timestamp or deadline", async () => {
    await expect(
      createRma({ approvedAt: new Date(), receiveByDeadline: new Date("2026-01-15") })
    ).rejects.toThrow();
  });

  it("approval requires both approvedAt and receiveByDeadline together", async () => {
    const rma = await createRma();
    await expect(
      prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "approved", approvedAt: new Date() } })
    ).rejects.toThrow();
  });

  it("a well-formed approval succeeds", async () => {
    const rma = await createRma();
    const approved = await approve(rma.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.receiveByDeadline).not.toBeNull();
  });
});

describe("rma_request_denial_requires_reason", () => {
  it("refuses denied with no reason, even via raw SQL", async () => {
    const rma = await createRma();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET status = 'denied', denial_reason = NULL WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("refuses a whitespace-only reason", async () => {
    const rma = await createRma();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET status = 'denied', denial_reason = '   ' WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("accepts denied with a real reason", async () => {
    const rma = await createRma();
    const denied = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "denied", deniedAt: new Date(), deniedByActorRef: "staff:alice", denialReason: "personalized item" },
    });
    expect(denied.status).toBe("denied");
  });
});

describe("rma_request_guard — the status transition table, at the database level", () => {
  it("allows submitted -> approved -> return_shipped -> received_inspection_pending -> inspection_passed -> remedy_in_progress -> resolved -> closed", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "return_shipped", returnShippedAt: new Date() } });
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "inspection_passed", conditionDecision: "accepted", conditionDecidedAt: new Date(), conditionDecidedByActorRef: "staff:alice" },
    });
    await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "remedy_in_progress" } });
    await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "resolved", resolvedAt: new Date() } });
    const closed = await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "closed", closedAt: new Date() } });
    expect(closed.status).toBe("closed");
  });

  it("refuses submitted -> approved -> inspection_passed directly, skipping receipt entirely", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await expect(
      prisma.rmaRequest.update({
        where: { id: rma.id },
        data: { status: "inspection_passed", conditionDecision: "accepted" },
      })
    ).rejects.toThrow();
  });

  it("refuses resolved -> received_inspection_pending (no reopening a settled RMA)", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "inspection_failed", conditionDecision: "rejected", conditionDecisionReason: "worn beyond inspection" },
    });
    const resolved = await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "resolved" } });
    expect(resolved.status).toBe("resolved");

    await expect(
      prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "received_inspection_pending" } })
    ).rejects.toThrow();
  });

  it("window_kind cannot change once set", async () => {
    const rma = await createRma({ windowKind: "standard" });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "rma_request" SET window_kind = 'late' WHERE id = $1::uuid`, rma.id)
    ).rejects.toThrow();
  });

  it("calendar_days_since_delivery cannot change once set", async () => {
    const rma = await createRma({ calendarDaysSinceDelivery: 3 });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET calendar_days_since_delivery = 9 WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("the eligible merchandise amount snapshot cannot change once set", async () => {
    const rma = await createRma({ eligibleMerchandiseAmountMinorUnits: 100_00n });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET eligible_merchandise_amount_minor_units = 999900 WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("received_at cannot change once recorded", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date("2026-01-05T00:00:00Z") },
    });
    await expect(
      prisma.rmaRequest.update({ where: { id: rma.id }, data: { receivedAt: new Date("2026-01-06T00:00:00Z") } })
    ).rejects.toThrow();
  });

  it("allows submitted -> approved -> expired when the deadline passes with nothing received", async () => {
    const rma = await createRma();
    await approve(rma.id);
    const expired = await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "expired", expiredAt: new Date() } });
    expect(expired.status).toBe("expired");
  });
});

describe("rma_request_condition_decision_status_coherent / decision_requires_receipt / rejection_requires_reason — criterion 202", () => {
  async function receivedRma() {
    const rma = await createRma();
    await approve(rma.id);
    return prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
  }

  it("refuses a condition decision with no recorded receipt, even via raw SQL", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET status = 'inspection_passed', condition_decision = 'accepted' WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("refuses a rejected decision with no reason", async () => {
    const rma = await receivedRma();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET status = 'inspection_failed', condition_decision = 'rejected', condition_decision_reason = NULL WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("accepts a well-formed accepted decision", async () => {
    const rma = await receivedRma();
    const decided = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "inspection_passed", conditionDecision: "accepted", conditionDecidedAt: new Date(), conditionDecidedByActorRef: "staff:alice" },
    });
    expect(decided.conditionDecision).toBe("accepted");
  });

  it("accepts a well-formed rejected decision with a reason", async () => {
    const rma = await receivedRma();
    const decided = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: {
        status: "inspection_failed",
        conditionDecision: "rejected",
        conditionDecisionReason: "signs of wear beyond try-on",
        conditionDecidedAt: new Date(),
        conditionDecidedByActorRef: "staff:alice",
      },
    });
    expect(decided.conditionDecision).toBe("rejected");
  });
});

describe("rma_request_guard — condition_decision is immutable once recorded (OWNER DECISION, RMA dispute-evidence integrity, migration 20260928050000)", () => {
  /** Walks a fresh RMA to `resolved` via the ACCEPTED path: submitted -> approved -> received_inspection_pending -> inspection_passed (accepted) -> remedy_in_progress -> resolved. */
  async function resolvedViaAccepted() {
    const rma = await acceptedRma();
    await prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "remedy_in_progress" } });
    return prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "resolved", resolvedAt: new Date() } });
  }

  /** Walks a fresh RMA to `resolved` via the REJECTED path: submitted -> approved -> received_inspection_pending -> inspection_failed (rejected) -> resolved. */
  async function resolvedViaRejected() {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: {
        status: "inspection_failed",
        conditionDecision: "rejected",
        conditionDecisionReason: "worn beyond inspection",
        conditionDecidedAt: new Date(),
        conditionDecidedByActorRef: "staff:alice",
      },
    });
    return prisma.rmaRequest.update({ where: { id: rma.id }, data: { status: "resolved", resolvedAt: new Date() } });
  }

  it("refuses accepted -> rejected, even at a status ('resolved') the CHECK constraint alone would permit for either decision", async () => {
    const rma = await resolvedViaAccepted();
    expect(rma.conditionDecision).toBe("accepted");

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET condition_decision = 'rejected', condition_decision_reason = 'rewritten after the fact' WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow(/historical fact|inspection outcome/i);

    const unchanged = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(unchanged.conditionDecision).toBe("accepted");
  });

  it("refuses rejected -> accepted, symmetrically", async () => {
    const rma = await resolvedViaRejected();
    expect(rma.conditionDecision).toBe("rejected");

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "rma_request" SET condition_decision = 'accepted' WHERE id = $1::uuid`, rma.id)
    ).rejects.toThrow(/historical fact|inspection outcome/i);

    const unchanged = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(unchanged.conditionDecision).toBe("rejected");
  });

  it("refuses clearing a recorded decision back to NULL", async () => {
    const rma = await acceptedRma();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "rma_request" SET condition_decision = NULL WHERE id = $1::uuid`, rma.id)
    ).rejects.toThrow(/historical fact|inspection outcome/i);

    const unchanged = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: rma.id } });
    expect(unchanged.conditionDecision).toBe("accepted");
  });

  it("still permits setting the decision from NULL exactly once (the normal decide_condition transition)", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });

    const decided = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: {
        status: "inspection_passed",
        conditionDecision: "accepted",
        conditionDecidedAt: new Date(),
        conditionDecidedByActorRef: "staff:alice",
      },
    });
    expect(decided.conditionDecision).toBe("accepted");
  });
});

describe("rma_request_return_insured_value_coherent", () => {
  it("refuses an insured value with no currency", async () => {
    const rma = await createRma();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_request" SET return_insured_value_minor_units = 5000, return_insured_value_currency = NULL WHERE id = $1::uuid`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("accepts both present together", async () => {
    const rma = await createRma();
    const updated = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { returnInsuredValueMinorUnits: 5000n, returnInsuredValueCurrency: "USD", returnTrackingCarrier: "UPS", returnTrackingNumber: "1Z999" },
    });
    expect(updated.returnInsuredValueCurrency).toBe("USD");
  });
});

describe("rma_event — append-only", () => {
  it("rejects UPDATE and DELETE at the database level", async () => {
    const rma = await createRma();
    const event = await prisma.rmaEvent.create({
      data: { rmaId: rma.id, fromStatus: null, toStatus: "submitted", actorType: "customer" },
    });
    await expect(prisma.rmaEvent.update({ where: { id: event.id }, data: { reason: "edited" } })).rejects.toThrow();
    await expect(prisma.rmaEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });

  it("rejects TRUNCATE at the database level", async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "rma_event"`)).rejects.toThrow();
  });
});

/**
 * OWNER DECISION (late-window RMA approval gating, 2026-09-27) — walks a
 * fixture remedy row through `approved` (with a reviewer/timestamp already
 * recorded, satisfying `rma_remedy_requires_approval_once_left_pending`) and
 * into `processing`, using raw `prisma.rmaRemedy.update` calls the same way
 * the rest of this schema-level test file builds fixtures — never via the
 * repository, so these tests keep proving the DATABASE's own guarantees.
 */
async function approveAndBeginProcessing(remedyId: string) {
  await prisma.rmaRemedy.update({
    where: { id: remedyId },
    data: { status: "approved", approvedAt: new Date(), approvedByActorRef: "staff:alice" },
  });
  return prisma.rmaRemedy.update({ where: { id: remedyId }, data: { status: "processing" } });
}

describe("rma_remedy — money coherence, idempotency, and the issued-is-terminal guarantee", () => {
  it("rma_remedy_amount_matches_inputs refuses a mismatched sum, even via raw insert", async () => {
    const rma = await acceptedRma();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_remedy" (
           id, rma_id, kind, eligible_merchandise_amount_minor_units,
           merchandise_amount_minor_units, restocking_fee_minor_units, currency, updated_at
         ) VALUES (gen_random_uuid(), $1::uuid, 'refund_original_payment', 25000, 20000, 1000, 'USD', CURRENT_TIMESTAMP)`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("rma_remedy_restocking_fee_only_for_refund_kind refuses a fee on a merchandise_credit remedy", async () => {
    const rma = await acceptedRma();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_remedy" (
           id, rma_id, kind, eligible_merchandise_amount_minor_units,
           merchandise_amount_minor_units, restocking_fee_minor_units, currency, updated_at
         ) VALUES (gen_random_uuid(), $1::uuid, 'merchandise_credit', 25000, 20000, 5000, 'USD', CURRENT_TIMESTAMP)`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("accepts a well-formed pending remedy", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "refund_original_payment",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 125_00n,
        restockingFeeMinorUnits: 125_00n,
        currency: "USD",
      },
    });
    expect(remedy.status).toBe("pending");
  });

  it("criterion 196/204 — a duplicated remedy insert for the same RMA is refused by the unique constraint, not a read-then-write check", async () => {
    const rma = await acceptedRma();
    await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });

    await expect(
      prisma.rmaRemedy.create({
        data: {
          rmaId: rma.id,
          kind: "merchandise_credit",
          eligibleMerchandiseAmountMinorUnits: 250_00n,
          merchandiseAmountMinorUnits: 250_00n,
          restockingFeeMinorUnits: 0n,
          currency: "USD",
        },
      })
    ).rejects.toThrow();

    const rowCount = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(rowCount).toBe(1);
  });

  it("rma_remedy_issued_has_reference refuses issued with no processor reference", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await approveAndBeginProcessing(remedy.id);
    await expect(
      prisma.rmaRemedy.update({ where: { id: remedy.id }, data: { status: "issued" } })
    ).rejects.toThrow();
  });

  it("rma_remedy_failed_has_reason refuses failed with no reason", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await approveAndBeginProcessing(remedy.id);
    await expect(prisma.rmaRemedy.update({ where: { id: remedy.id }, data: { status: "failed" } })).rejects.toThrow();
  });

  it("rma_remedy_staff_review_has_reason refuses staff_review_required with no reason (D7's fail-closed instruction)", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await approveAndBeginProcessing(remedy.id);

    await expect(
      prisma.rmaRemedy.update({ where: { id: remedy.id }, data: { status: "staff_review_required" } })
    ).rejects.toThrow();

    const withReason = await prisma.rmaRemedy.update({
      where: { id: remedy.id },
      data: { status: "staff_review_required", staffReviewReason: "Shopify cannot represent a partial store-credit + tax adjustment here" },
    });
    expect(withReason.status).toBe("staff_review_required");
  });

  it("issued is terminal — cannot be moved to any other status once issued, even a settled one", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await approveAndBeginProcessing(remedy.id);
    const issued = await prisma.rmaRemedy.update({
      where: { id: remedy.id },
      data: {
        status: "issued",
        processorReference: "shopify-store-credit-txn-123",
        actualRefundOrCreditMinorUnits: 250_00n,
        issuedAt: new Date(),
      },
    });
    expect(issued.status).toBe("issued");

    await expect(
      prisma.rmaRemedy.update({ where: { id: remedy.id }, data: { status: "processing" } })
    ).rejects.toThrow();

    // Even the amount/reference cannot move once settled — belt and braces
    // over the domain's own terminal-state check.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_remedy" SET actual_refund_or_credit_minor_units = 999900 WHERE id = $1::uuid`,
        remedy.id
      )
    ).rejects.toThrow();
  });
});

describe("OWNER DECISION: late-window RMA approval gating — structural enforcement (money-critical)", () => {
  it("rma_remedy_requires_approval_once_left_pending refuses a raw INSERT that starts anywhere past pending with no approval recorded", async () => {
    const rma = await acceptedRma();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_remedy" (
           id, rma_id, kind, status, eligible_merchandise_amount_minor_units,
           merchandise_amount_minor_units, restocking_fee_minor_units, currency, updated_at
         ) VALUES (gen_random_uuid(), $1::uuid, 'merchandise_credit', 'approved', 25000, 25000, 0, 'USD', CURRENT_TIMESTAMP)`,
        rma.id
      )
    ).rejects.toThrow();
  });

  it("rma_remedy_requires_approval_once_left_pending refuses an UPDATE into approved with no reviewer recorded, even via raw SQL", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "rma_remedy" SET status = 'approved' WHERE id = $1::uuid`, remedy.id)
    ).rejects.toThrow();
  });

  it("rma_remedy_guard refuses pending -> processing directly, even via raw SQL that also supplies approved_at (skipping the approved state itself is still illegal)", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_remedy" SET status = 'processing', approved_at = CURRENT_TIMESTAMP, approved_by_actor_ref = 'staff:alice' WHERE id = $1::uuid`,
        remedy.id
      )
    ).rejects.toThrow();
  });

  it("rma_remedy_guard refuses pending -> issued directly, even with every issued-fields CHECK satisfied", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await expect(
      prisma.rmaRemedy.update({
        where: { id: remedy.id },
        data: {
          status: "issued",
          approvedAt: new Date(),
          approvedByActorRef: "staff:alice",
          processorReference: "shopify-refund-txn-skip-approval",
          actualRefundOrCreditMinorUnits: 250_00n,
          issuedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });

  it("pending -> approved -> processing succeeds once a reviewer and timestamp are recorded", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    const approved = await prisma.rmaRemedy.update({
      where: { id: remedy.id },
      data: { status: "approved", approvedAt: new Date(), approvedByActorRef: "staff:alice" },
    });
    expect(approved.status).toBe("approved");

    const processing = await prisma.rmaRemedy.update({ where: { id: remedy.id }, data: { status: "processing" } });
    expect(processing.status).toBe("processing");
  });

  it("approved_at and approved_by_actor_ref are set once and cannot change once recorded", async () => {
    const rma = await acceptedRma();
    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    await prisma.rmaRemedy.update({
      where: { id: remedy.id },
      data: { status: "approved", approvedAt: new Date("2026-01-05T00:00:00.000Z"), approvedByActorRef: "staff:alice" },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_remedy" SET approved_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
        remedy.id
      )
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "rma_remedy" SET approved_by_actor_ref = 'staff:someone-else' WHERE id = $1::uuid`,
        remedy.id
      )
    ).rejects.toThrow();
  });
});

describe("rma_remedy_requires_accepted_inspection — the missing link between inspection and remedy, at the database (money-critical)", () => {
  it("refuses a raw INSERT for an RMA that has never been inspected (condition_decision NULL)", async () => {
    const rma = await createRma();
    expect(rma.conditionDecision).toBeNull();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_remedy" (
           id, rma_id, kind, eligible_merchandise_amount_minor_units,
           merchandise_amount_minor_units, restocking_fee_minor_units, currency, updated_at
         ) VALUES (gen_random_uuid(), $1::uuid, 'merchandise_credit', 25000, 25000, 0, 'USD', CURRENT_TIMESTAMP)`,
        rma.id
      )
    ).rejects.toThrow(/accepted/i);

    const rowCount = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(rowCount).toBe(0);
  });

  it("refuses a raw INSERT for an RMA whose inspection was REJECTED", async () => {
    const rma = await createRma();
    await approve(rma.id);
    await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    const rejected = await prisma.rmaRequest.update({
      where: { id: rma.id },
      data: {
        status: "inspection_failed",
        conditionDecision: "rejected",
        conditionDecisionReason: "worn beyond inspection",
        conditionDecidedAt: new Date(),
        conditionDecidedByActorRef: "staff:alice",
      },
    });
    expect(rejected.conditionDecision).toBe("rejected");

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "rma_remedy" (
           id, rma_id, kind, eligible_merchandise_amount_minor_units,
           merchandise_amount_minor_units, restocking_fee_minor_units, currency, updated_at
         ) VALUES (gen_random_uuid(), $1::uuid, 'merchandise_credit', 25000, 25000, 0, 'USD', CURRENT_TIMESTAMP)`,
        rma.id
      )
    ).rejects.toThrow(/accepted/i);

    const rowCount = await prisma.rmaRemedy.count({ where: { rmaId: rma.id } });
    expect(rowCount).toBe(0);
  });

  it("allows a raw INSERT for an RMA whose inspection was ACCEPTED", async () => {
    const rma = await acceptedRma();

    const remedy = await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });
    expect(remedy.status).toBe("pending");
  });
});

describe("criterion 203 — the complete RMA record is retrievable in one query", () => {
  it("fetches the request + every event + its remedy together", async () => {
    const rma = await acceptedRma();
    await prisma.rmaEvent.create({ data: { rmaId: rma.id, fromStatus: null, toStatus: "submitted", actorType: "customer" } });
    await prisma.rmaEvent.create({ data: { rmaId: rma.id, fromStatus: "submitted", toStatus: "approved", actorType: "staff", actorRef: "staff:alice" } });
    await prisma.rmaRemedy.create({
      data: {
        rmaId: rma.id,
        kind: "refund_original_payment",
        eligibleMerchandiseAmountMinorUnits: 250_00n,
        merchandiseAmountMinorUnits: 250_00n,
        restockingFeeMinorUnits: 0n,
        currency: "USD",
      },
    });

    const full = await prisma.rmaRequest.findUniqueOrThrow({
      where: { id: rma.id },
      include: { events: true, remedy: true },
    });
    expect(full.events).toHaveLength(2);
    expect(full.remedy?.kind).toBe("refund_original_payment");
  });
});
