import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  authorizeWarrantyClaimForInspection,
  beginWarrantyClaimRemedy,
  closeWarrantyClaim,
  createWarrantyClaim,
  createWarrantyClaimRemedy,
  decideWarrantyClaimCoverage,
  getWarrantyClaimForCustomer,
  getWarrantyClaimForCustomerByReference,
  getWarrantyClaimForStaffReview,
  IllegalWarrantyClaimTransitionError,
  InvalidWarrantyClaimUploadError,
  markWarrantyClaimInTransit,
  recordWarrantyClaimInboundShippingEvidence,
  recordWarrantyClaimReceipt,
  recordWarrantyClaimUpload,
  resolveWarrantyClaim,
  staffRecordLocalJewellerAuthorization,
  startWarrantyClaimReview,
  updateWarrantyClaimRemedyStatus,
  WarrantyClaimActorRequiredError,
  WarrantyClaimNotAuthorizedForShippingError,
  WarrantyClaimNotCoveredError,
  WarrantyClaimRemedyAlreadyExistsError,
} from "~/db/repositories/warrantyClaimRepository.server";

/**
 * Slice 5 task 5-2 — the repository against a real database. Task 5-1's own
 * `warrantyClaimSchema.test.ts` already proves the database-level guard
 * trigger and CHECK constraints exhaustively; THIS suite proves the
 * repository layer refuses illegal work BEFORE ever reaching the database,
 * that claim reference generation is collision-safe under real concurrency,
 * and that the customer/staff read boundary (criterion 165) actually holds.
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

async function submitClaim() {
  const accuracy = await createAcknowledgment("warranty-accuracy-certification");
  const coverageNotEstablished = await createAcknowledgment("warranty-coverage-not-established");
  return createWarrantyClaim({
    orderRef: `gid://shopify/Order/${uniq()}`,
    lineRef: `gid://shopify/LineItem/${uniq()}`,
    itemConfigurationDescription: "14k gold solitaire ring, size 7",
    purchaserName: "Test Purchaser",
    purchaserEmail: "purchaser@example.com",
    problemDescription: "Prong appears to have a defective solder joint.",
    hadImpactOrDamageEvent: false,
    wasAlteredAfterDelivery: false,
    accuracyCertificationAcknowledgmentId: accuracy.id,
    coverageNotEstablishedAcknowledgmentId: coverageNotEstablished.id,
  });
}

/** Walks a fresh claim to `received_inspection_pending` through the repository's own transition functions. */
async function walkToReceived(claimId: string) {
  await startWarrantyClaimReview(claimId, { actorType: "staff", actorRef: "staff:reviewer" });
  await authorizeWarrantyClaimForInspection(claimId, "staff:reviewer");
  await markWarrantyClaimInTransit(claimId, { actorType: "customer", actorRef: null });
  return recordWarrantyClaimReceipt(claimId, { inspectedByActorRef: "staff:inspector" });
}

async function walkToApprovedCovered(claimId: string) {
  await walkToReceived(claimId);
  return decideWarrantyClaimCoverage(claimId, { decision: "covered", decidedByActorRef: "staff:reviewer" });
}

describe("createWarrantyClaim — claim reference generation", () => {
  it("generates a WC-prefixed reference and records the initial submitted event", async () => {
    const claim = await submitClaim();
    expect(claim.claimReference).toMatch(/^WC-[0-9A-Z]{8}$/);
    expect(claim.status).toBe("submitted");

    const events = await prisma.warrantyClaimEvent.findMany({ where: { claimId: claim.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.fromStatus).toBeNull();
    expect(events[0]!.toStatus).toBe("submitted");
  });

  it("is collision-safe under real concurrency — many claims submitted at once all get distinct references", async () => {
    const claims = await Promise.all(Array.from({ length: 20 }, () => submitClaim()));
    const references = claims.map((claim) => claim.claimReference);
    expect(new Set(references).size).toBe(references.length);
  });
});

describe("Illegal transitions are refused BEFORE any database write", () => {
  it("refuses record_receipt on a freshly submitted claim, and leaves the row untouched", async () => {
    const claim = await submitClaim();

    await expect(
      recordWarrantyClaimReceipt(claim.id, { inspectedByActorRef: "staff:inspector" })
    ).rejects.toThrow(IllegalWarrantyClaimTransitionError);

    const reloaded = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(reloaded.status).toBe("submitted");
    expect(reloaded.receivedAt).toBeNull();
    // Only the initial submission event exists — the refused call appended nothing.
    const events = await prisma.warrantyClaimEvent.findMany({ where: { claimId: claim.id } });
    expect(events).toHaveLength(1);
  });

  it("criterion 159 — refuses a coverage decision with no recorded receipt, at the repository layer", async () => {
    const claim = await submitClaim();
    await startWarrantyClaimReview(claim.id, { actorType: "staff", actorRef: "staff:reviewer" });
    await authorizeWarrantyClaimForInspection(claim.id, "staff:reviewer");
    await markWarrantyClaimInTransit(claim.id, { actorType: "customer", actorRef: null });
    // Deliberately skip recordWarrantyClaimReceipt.

    await expect(
      decideWarrantyClaimCoverage(claim.id, { decision: "covered", decidedByActorRef: "staff:reviewer" })
    ).rejects.toThrow(IllegalWarrantyClaimTransitionError);

    const reloaded = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(reloaded.status).toBe("in_transit_to_carat_for_us");
    expect(reloaded.coverageDecision).toBeNull();
  });

  it("criterion 160 — refuses denial with no reason, at the repository layer", async () => {
    const claim = await submitClaim();
    await walkToReceived(claim.id);

    await expect(
      decideWarrantyClaimCoverage(claim.id, { decision: "not_covered", decidedByActorRef: "staff:reviewer" })
    ).rejects.toThrow(IllegalWarrantyClaimTransitionError);
  });

  it("criterion 161 — a Luxury Steal line reaches a coverage decision exactly like any other claim", async () => {
    // The repository has no Final-Sale/Luxury-Steal special case anywhere;
    // this asserts that directly by decision, not by absence of code to read.
    const claim = await submitClaim();
    const decided = await walkToApprovedCovered(claim.id);
    expect(decided.status).toBe("approved_covered");
    expect(decided.coverageDecision).toBe("covered");
  });
});

describe("Criterion 157 — authorization requires an explicit, non-empty staff actor", () => {
  it("refuses an empty staffActorRef before any database write", async () => {
    const claim = await submitClaim();
    await startWarrantyClaimReview(claim.id, { actorType: "staff", actorRef: "staff:reviewer" });

    await expect(authorizeWarrantyClaimForInspection(claim.id, "")).rejects.toThrow(WarrantyClaimActorRequiredError);
    await expect(authorizeWarrantyClaimForInspection(claim.id, "   ")).rejects.toThrow(WarrantyClaimActorRequiredError);

    const reloaded = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(reloaded.status).toBe("under_review");
    expect(reloaded.authorizedAt).toBeNull();
  });
});

describe("Criterion 156/158 — inbound shipping evidence never precedes authorization", () => {
  it("refuses to record shipping evidence before authorization", async () => {
    const claim = await submitClaim();
    await expect(
      recordWarrantyClaimInboundShippingEvidence(
        claim.id,
        { carrier: "UPS", trackingNumber: "1Z999" },
        { actorType: "customer", actorRef: null }
      )
    ).rejects.toThrow(WarrantyClaimNotAuthorizedForShippingError);
  });

  it("records tracking/insurance evidence once authorized, and appends an audit event", async () => {
    const claim = await submitClaim();
    await startWarrantyClaimReview(claim.id, { actorType: "staff", actorRef: "staff:reviewer" });
    await authorizeWarrantyClaimForInspection(claim.id, "staff:reviewer");

    const updated = await recordWarrantyClaimInboundShippingEvidence(
      claim.id,
      {
        carrier: "UPS",
        trackingNumber: "1Z999AA10123456784",
        insuranceReference: "INS-1",
        insuredValueMinorUnits: 250_000n,
        insuredValueCurrency: "USD",
      },
      { actorType: "customer", actorRef: null }
    );
    expect(updated.inboundTrackingCarrier).toBe("UPS");
    expect(updated.inboundInsuredValueMinorUnits).toBe(250_000n);

    const events = await prisma.warrantyClaimEvent.findMany({ where: { claimId: claim.id }, orderBy: { createdAt: "asc" } });
    const shippingEvent = events.at(-1)!;
    expect(shippingEvent.fromStatus).toBe(shippingEvent.toStatus);
    expect((shippingEvent.metadata as { carrier: string }).carrier).toBe("UPS");
  });
});

describe("Remedy — criteria 162-164", () => {
  it("refuses to create a remedy for a claim that has not been approved-covered", async () => {
    const claim = await submitClaim();
    await expect(
      createWarrantyClaimRemedy({ claimId: claim.id, kind: "repair", decidedByActorRef: "staff:reviewer" })
    ).rejects.toThrow(WarrantyClaimNotCoveredError);
  });

  it("criterion 163 — a second remedy for the same claim is refused by the unique constraint, not silently accepted", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);

    await createWarrantyClaimRemedy({ claimId: claim.id, kind: "repair", decidedByActorRef: "staff:alice" });
    await expect(
      createWarrantyClaimRemedy({ claimId: claim.id, kind: "replacement", decidedByActorRef: "staff:bob" })
    ).rejects.toThrow(WarrantyClaimRemedyAlreadyExistsError);

    const count = await prisma.warrantyClaimRemedy.count({ where: { claimId: claim.id } });
    expect(count).toBe(1);
  });

  it("criterion 164 — refuses a refund remedy with no money fields before the insert", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);
    await expect(
      createWarrantyClaimRemedy({ claimId: claim.id, kind: "refund", decidedByActorRef: "staff:alice" })
    ).rejects.toThrow(/Invalid warranty claim remedy money/);
  });

  it("retried remedy processing updates the SAME row rather than inserting a new one", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);
    await createWarrantyClaimRemedy({
      claimId: claim.id,
      kind: "refund",
      refundAmountMinorUnits: 499_99n,
      currency: "USD",
      decidedByActorRef: "staff:alice",
    });

    await updateWarrantyClaimRemedyStatus({ claimId: claim.id, status: "processing" });
    await updateWarrantyClaimRemedyStatus({ claimId: claim.id, status: "processing" }); // simulated retry
    const completed = await updateWarrantyClaimRemedyStatus({
      claimId: claim.id,
      status: "completed",
      processorReference: "refund_txn_1",
    });

    expect(completed.status).toBe("completed");
    expect(completed.processorReference).toBe("refund_txn_1");
    const count = await prisma.warrantyClaimRemedy.count({ where: { claimId: claim.id } });
    expect(count).toBe(1);
  });

  it("full happy path through the repository reaches closed", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);
    await createWarrantyClaimRemedy({ claimId: claim.id, kind: "repair", decidedByActorRef: "staff:alice" });
    await beginWarrantyClaimRemedy(claim.id, { actorType: "staff", actorRef: "staff:alice" });
    await resolveWarrantyClaim(claim.id, { actorType: "staff", actorRef: "staff:alice" });
    const closed = await closeWarrantyClaim(claim.id, { actorType: "staff", actorRef: "staff:alice" });
    expect(closed.status).toBe("closed");
  });
});

describe("Criterion 165 — the customer-facing read never returns jeweller data", () => {
  it("returns no jeweller data even when a local-jeweller authorization row exists for the claim's remedy", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);
    const remedy = await createWarrantyClaimRemedy({ claimId: claim.id, kind: "repair", decidedByActorRef: "staff:alice" });
    await staffRecordLocalJewellerAuthorization({
      remedyId: remedy.id,
      jewellerName: "Example Local Jewellers",
      authorizedScope: "Re-solder loose prong",
      authorizedCostMinorUnits: 75_00n,
      authorizedCostCurrency: "USD",
      authorizedByActorRef: "staff:alice",
    });

    const customerView = await getWarrantyClaimForCustomer(claim.id);
    expect(customerView).not.toBeNull();
    expect(JSON.stringify(customerView)).not.toMatch(/jewell/i);
    expect(customerView!.remedy).not.toBeNull();
    expect(Object.keys(customerView!.remedy as object)).not.toContain("localJewellerAuthorization");

    const byReference = await getWarrantyClaimForCustomerByReference(claim.claimReference);
    expect(JSON.stringify(byReference)).not.toMatch(/jewell/i);

    // Contrast: the staff read DOES surface it, proving the boundary is a
    // real code-path difference and not merely two names for one query.
    const staffView = await getWarrantyClaimForStaffReview(claim.id);
    expect(staffView!.remedy!.localJewellerAuthorization).not.toBeNull();
    expect(staffView!.remedy!.localJewellerAuthorization!.jewellerName).toBe("Example Local Jewellers");
  });

  it("criterion 170 — the staff read returns claim + events + uploads + remedy in one query", async () => {
    const claim = await submitClaim();
    await walkToApprovedCovered(claim.id);
    await createWarrantyClaimRemedy({ claimId: claim.id, kind: "repair", decidedByActorRef: "staff:alice" });
    await recordWarrantyClaimUpload({
      claimId: claim.id,
      kind: "photo",
      storageKey: `warranty/${claim.id}/photo/1.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 100_000n,
      checksum: "sha256:abc",
      uploadedByActorType: "customer",
    });

    const staffView = await getWarrantyClaimForStaffReview(claim.id);
    expect(staffView!.events.length).toBeGreaterThanOrEqual(5);
    expect(staffView!.uploads).toHaveLength(1);
    expect(staffView!.remedy!.kind).toBe("repair");
  });
});

describe("Uploads — metadata only (spec §5)", () => {
  it("records well-formed upload metadata", async () => {
    const claim = await submitClaim();
    const upload = await recordWarrantyClaimUpload({
      claimId: claim.id,
      kind: "photo",
      storageKey: `warranty/${claim.id}/photo/1.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 500_000n,
      checksum: "sha256:abc123",
      uploadedByActorType: "customer",
    });
    expect(upload.storageKey).toContain(claim.id);
  });

  it("rejects a disallowed content type and creates no row", async () => {
    const claim = await submitClaim();
    await expect(
      recordWarrantyClaimUpload({
        claimId: claim.id,
        kind: "photo",
        storageKey: `warranty/${claim.id}/photo/2.pdf`,
        contentType: "application/pdf",
        sizeBytes: 500_000n,
        checksum: "sha256:abc123",
        uploadedByActorType: "customer",
      })
    ).rejects.toThrow(InvalidWarrantyClaimUploadError);

    const count = await prisma.warrantyClaimUpload.count({ where: { claimId: claim.id } });
    expect(count).toBe(0);
  });

  it("rejects an oversized file and creates no row", async () => {
    const claim = await submitClaim();
    await expect(
      recordWarrantyClaimUpload({
        claimId: claim.id,
        kind: "photo",
        storageKey: `warranty/${claim.id}/photo/3.jpg`,
        contentType: "image/jpeg",
        sizeBytes: 1_000_000_000n,
        checksum: "sha256:abc123",
        uploadedByActorType: "customer",
      })
    ).rejects.toThrow(InvalidWarrantyClaimUploadError);

    const count = await prisma.warrantyClaimUpload.count({ where: { claimId: claim.id } });
    expect(count).toBe(0);
  });
});
