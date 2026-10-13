import { describe, expect, it } from "vitest";

import type { Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";

/**
 * Slice 5 task 5-1 — M13-M16 (+ the internal-only local-jeweller satellite
 * table) against a real database. No repository layer exists yet (task
 * 5-2), so these tests use `prisma.warrantyClaim.*` directly for fixtures —
 * same convention `luxuryStealRepository.test.ts` uses for its own
 * fixtures — and raw SQL where the point is to prove a constraint holds even
 * against a caller that bypasses application code entirely.
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

async function createClaim(overrides: Partial<Prisma.WarrantyClaimUncheckedCreateInput> = {}) {
  const accuracy = await createAcknowledgment("warranty-accuracy-certification");
  const coverageNotEstablished = await createAcknowledgment("warranty-coverage-not-established");

  return prisma.warrantyClaim.create({
    data: {
      claimReference: `WC-${uniq()}`,
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
      ...overrides,
    },
  });
}

describe("M13 — warranty_claim: required evidence and defaults", () => {
  it("defaults to status submitted with no coverage decision", async () => {
    const claim = await createClaim();
    expect(claim.status).toBe("submitted");
    expect(claim.coverageDecision).toBeNull();
    expect(claim.receivedAt).toBeNull();
  });

  it("criterion 154 — cannot be created without both required acknowledgments", async () => {
    const accuracy = await createAcknowledgment("warranty-accuracy-certification");
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "warranty_claim" (
           id, claim_reference, order_ref, line_ref, item_configuration_description,
           purchaser_name, purchaser_email, problem_description,
           had_impact_or_damage_event, was_altered_after_delivery,
           accuracy_certification_acknowledgment_id, coverage_not_established_acknowledgment_id,
           updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'desc', 'name', 'email@example.com', 'problem',
           false, false, $4::uuid, NULL, CURRENT_TIMESTAMP
         )`,
        `WC-${uniq()}`,
        `gid://shopify/Order/${uniq()}`,
        `gid://shopify/LineItem/${uniq()}`,
        accuracy.id
      )
    ).rejects.toThrow();
  });
});

describe("M13 — warranty_claim_guard: the status transition table, at the database level", () => {
  it("allows submitted -> under_review", async () => {
    const claim = await createClaim();
    const updated = await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    expect(updated.status).toBe("under_review");
  });

  it("refuses submitted -> approved_covered directly (skips the entire workflow)", async () => {
    const claim = await createClaim();
    await expect(
      prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "approved_covered" } })
    ).rejects.toThrow();
  });

  it("refuses resolved -> under_review (no reopening a settled claim)", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "denied_not_covered", coverageDecision: "not_covered", coverageDecisionReason: "not covered" },
    });
    const resolved = await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "resolved" } });
    expect(resolved.status).toBe("resolved");

    await expect(
      prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } })
    ).rejects.toThrow();
  });

  it("criterion 159 at the database level — refuses a coverage decision with no recorded receipt, even via raw SQL bypassing Prisma's own state tracking", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });

    // Attempt to jump straight from in_transit to approved_covered, skipping
    // received_inspection_pending and receivedAt entirely.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "warranty_claim" SET status = 'approved_covered', coverage_decision = 'covered' WHERE id = $1::uuid`,
        claim.id
      )
    ).rejects.toThrow();
  });

  it("more_information_requested resumes to exactly where it paused from — under_review, not received_inspection_pending", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    const paused = await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "more_information_requested", pausedFromStatus: "under_review" },
    });
    expect(paused.pausedFromStatus).toBe("under_review");

    // The shortcut: try to resume straight into received_inspection_pending
    // without ever having gone through record_receipt.
    await expect(
      prisma.warrantyClaim.update({
        where: { id: claim.id },
        data: { status: "received_inspection_pending" },
      })
    ).rejects.toThrow();

    const resumed = await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "under_review", pausedFromStatus: null },
    });
    expect(resumed.status).toBe("under_review");
    expect(resumed.pausedFromStatus).toBeNull();
  });

  it("more_information_requested requires paused_from_status to be set", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await expect(
      prisma.warrantyClaim.update({
        where: { id: claim.id },
        data: { status: "more_information_requested", pausedFromStatus: null },
      })
    ).rejects.toThrow();
  });

  it("received_at cannot change once recorded", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date("2026-09-01T00:00:00Z") },
    });

    await expect(
      prisma.warrantyClaim.update({
        where: { id: claim.id },
        data: { receivedAt: new Date("2026-09-05T00:00:00Z") },
      })
    ).rejects.toThrow();
  });

  it("the full happy path reaches closed: submitted -> ... -> approved_covered -> remedy_in_progress -> resolved -> closed", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "approved_covered", coverageDecision: "covered" },
    });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "remedy_in_progress" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "resolved" } });
    const closed = await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "closed" } });
    expect(closed.status).toBe("closed");
  });
});

describe("warranty_claim_denial_requires_reason — criterion 160", () => {
  it("refuses denied_not_covered with no reason, even via raw SQL", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "warranty_claim" SET status = 'denied_not_covered', coverage_decision = 'not_covered', coverage_decision_reason = NULL WHERE id = $1::uuid`,
        claim.id
      )
    ).rejects.toThrow();
  });

  it("refuses a whitespace-only reason too", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "warranty_claim" SET status = 'denied_not_covered', coverage_decision = 'not_covered', coverage_decision_reason = '   ' WHERE id = $1::uuid`,
        claim.id
      )
    ).rejects.toThrow();
  });

  it("accepts denied_not_covered with a real reason", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "under_review" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "authorized_for_inspection" } });
    await prisma.warrantyClaim.update({ where: { id: claim.id }, data: { status: "in_transit_to_carat_for_us" } });
    await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: { status: "received_inspection_pending", receivedAt: new Date() },
    });
    const denied = await prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: {
        status: "denied_not_covered",
        coverageDecision: "not_covered",
        coverageDecisionReason: "damage from impact, not a manufacturing defect",
      },
    });
    expect(denied.status).toBe("denied_not_covered");
  });
});

describe("M14 — warranty_claim_event: append-only", () => {
  it("rejects UPDATE and DELETE at the database level", async () => {
    const claim = await createClaim();
    const event = await prisma.warrantyClaimEvent.create({
      data: {
        claimId: claim.id,
        fromStatus: null,
        toStatus: "submitted",
        actorType: "customer",
        reason: "claim submitted",
      },
    });

    await expect(
      prisma.warrantyClaimEvent.update({ where: { id: event.id }, data: { reason: "edited" } })
    ).rejects.toThrow();
    await expect(prisma.warrantyClaimEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });

  it("rejects TRUNCATE at the database level", async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "warranty_claim_event"`)).rejects.toThrow();
  });
});

describe("M15 — warranty_claim_upload: references only, append-only", () => {
  it("stores key/type/size/checksum and rejects UPDATE/DELETE", async () => {
    const claim = await createClaim();
    const upload = await prisma.warrantyClaimUpload.create({
      data: {
        claimId: claim.id,
        kind: "photo",
        storageKey: `warranty/${claim.id}/photo-1.jpg`,
        contentType: "image/jpeg",
        sizeBytes: 245_000n,
        checksum: "sha256:deadbeef",
        uploadedByActorType: "customer",
      },
    });
    expect(upload.storageKey).toContain(claim.id);

    await expect(
      prisma.warrantyClaimUpload.update({ where: { id: upload.id }, data: { checksum: "sha256:tampered" } })
    ).rejects.toThrow();
    await expect(prisma.warrantyClaimUpload.delete({ where: { id: upload.id } })).rejects.toThrow();
  });

  it("rejects TRUNCATE at the database level", async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "warranty_claim_upload"`)).rejects.toThrow();
  });
});

describe("M16 — warranty_claim_remedy: idempotency (criterion 163) and money coherence (criterion 164)", () => {
  it("criterion 163 — a duplicated remedy insert for the same claim is refused by the unique constraint, not a read-then-write check", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "repair",
        decidedByActorRef: "staff:alice",
        decidedAt: new Date(),
      },
    });

    await expect(
      prisma.warrantyClaimRemedy.create({
        data: {
          claimId: claim.id,
          kind: "replacement",
          decidedByActorRef: "staff:bob",
          decidedAt: new Date(),
        },
      })
    ).rejects.toThrow();

    const rowCount = await prisma.warrantyClaimRemedy.count({ where: { claimId: claim.id } });
    expect(rowCount).toBe(1);
  });

  it("criterion 162 — nothing about the remedy row identifies a customer as the decider; decidedByActorRef is a staff reference", async () => {
    const claim = await createClaim();
    const remedy = await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "refund",
        refundAmountMinorUnits: 250_00n,
        currency: "USD",
        decidedByActorRef: "staff:carol",
        decidedAt: new Date(),
      },
    });
    expect(remedy.decidedByActorRef).toBe("staff:carol");
  });

  it("refuses a refund remedy with no money fields", async () => {
    const claim = await createClaim();
    await expect(
      prisma.warrantyClaimRemedy.create({
        data: {
          claimId: claim.id,
          kind: "refund",
          decidedByActorRef: "staff:alice",
          decidedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });

  it("refuses a non-refund remedy that carries refund money fields", async () => {
    const claim = await createClaim();
    await expect(
      prisma.warrantyClaimRemedy.create({
        data: {
          claimId: claim.id,
          kind: "repair",
          refundAmountMinorUnits: 100n,
          currency: "USD",
          decidedByActorRef: "staff:alice",
          decidedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });

  it("accepts a well-formed refund remedy", async () => {
    const claim = await createClaim();
    const remedy = await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "refund",
        refundAmountMinorUnits: 499_99n,
        currency: "USD",
        decidedByActorRef: "staff:alice",
        decidedAt: new Date(),
      },
    });
    expect(remedy.refundAmountMinorUnits).toBe(499_99n);
    expect(remedy.currency).toBe("USD");
  });
});

describe("The local-jeweller table is internal-only and separate from the claim/remedy (criteria 165-166)", () => {
  it("is retrievable only via its own table, joined by remedyId — never a column on warranty_claim or warranty_claim_remedy", async () => {
    const claim = await createClaim();
    const remedy = await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "repair",
        decidedByActorRef: "staff:alice",
        decidedAt: new Date(),
      },
    });

    const authorization = await prisma.warrantyClaimLocalJewellerAuthorization.create({
      data: {
        remedyId: remedy.id,
        jewellerName: "Example Local Jewellers",
        authorizedScope: "Re-solder loose prong",
        authorizedCostMinorUnits: 75_00n,
        authorizedCostCurrency: "USD",
        authorizedByActorRef: "staff:alice",
        authorizedAt: new Date(),
      },
    });
    expect(authorization.remedyId).toBe(remedy.id);

    // Selecting the claim, or the remedy, the way a customer-facing
    // serialiser naturally would, carries none of this data — it requires
    // the separate, unambiguously-named table.
    const fetchedClaim = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(Object.keys(fetchedClaim).join(",")).not.toMatch(/jeweller/i);
    const fetchedRemedy = await prisma.warrantyClaimRemedy.findUniqueOrThrow({ where: { id: remedy.id } });
    expect(Object.keys(fetchedRemedy).join(",")).not.toMatch(/jeweller/i);
  });

  it("criterion 167 — reimbursementReference is never populated automatically; it is null unless a staff member explicitly records one", async () => {
    const claim = await createClaim();
    const remedy = await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "repair",
        decidedByActorRef: "staff:alice",
        decidedAt: new Date(),
      },
    });
    const authorization = await prisma.warrantyClaimLocalJewellerAuthorization.create({
      data: {
        remedyId: remedy.id,
        jewellerName: "Example Local Jewellers",
        authorizedScope: "Re-solder loose prong",
        authorizedCostMinorUnits: 75_00n,
        authorizedCostCurrency: "USD",
        authorizedByActorRef: "staff:alice",
        authorizedAt: new Date(),
      },
    });
    expect(authorization.reimbursementReference).toBeNull();
  });

  it("at most one authorization per remedy (unique constraint)", async () => {
    const claim = await createClaim();
    const remedy = await prisma.warrantyClaimRemedy.create({
      data: {
        claimId: claim.id,
        kind: "repair",
        decidedByActorRef: "staff:alice",
        decidedAt: new Date(),
      },
    });
    await prisma.warrantyClaimLocalJewellerAuthorization.create({
      data: {
        remedyId: remedy.id,
        jewellerName: "First Jeweller",
        authorizedScope: "scope",
        authorizedCostMinorUnits: 10_00n,
        authorizedCostCurrency: "USD",
        authorizedByActorRef: "staff:alice",
        authorizedAt: new Date(),
      },
    });

    await expect(
      prisma.warrantyClaimLocalJewellerAuthorization.create({
        data: {
          remedyId: remedy.id,
          jewellerName: "Second Jeweller",
          authorizedScope: "scope",
          authorizedCostMinorUnits: 20_00n,
          authorizedCostCurrency: "USD",
          authorizedByActorRef: "staff:alice",
          authorizedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });
});

describe("criterion 170 — the complete claim record is retrievable in one query", () => {
  it("fetches claim + events + uploads + remedy together", async () => {
    const claim = await createClaim();
    await prisma.warrantyClaimEvent.create({
      data: { claimId: claim.id, fromStatus: null, toStatus: "submitted", actorType: "customer" },
    });
    await prisma.warrantyClaimUpload.create({
      data: {
        claimId: claim.id,
        kind: "photo",
        storageKey: `warranty/${claim.id}/photo-1.jpg`,
        contentType: "image/jpeg",
        sizeBytes: 100n,
        checksum: "sha256:abc",
        uploadedByActorType: "customer",
      },
    });
    await prisma.warrantyClaimRemedy.create({
      data: { claimId: claim.id, kind: "repair", decidedByActorRef: "staff:alice", decidedAt: new Date() },
    });

    const full = await prisma.warrantyClaim.findUniqueOrThrow({
      where: { id: claim.id },
      include: { events: true, uploads: true, remedy: true },
    });
    expect(full.events).toHaveLength(1);
    expect(full.uploads).toHaveLength(1);
    expect(full.remedy?.kind).toBe("repair");
  });
});
