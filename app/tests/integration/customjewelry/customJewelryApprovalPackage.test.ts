import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  findApprovalPackageForCustomer,
  findIssuedPackageForCustomer,
  issueApprovalPackage,
  recordCustomerApproval,
} from "~/db/repositories/customJewelryApprovalRepository.server";
import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS } from "~/domain/customjewelry/designDepositAcknowledgmentText";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
} from "~/domain/customjewelry/finalApprovalCopy";
import { Money } from "~/domain/money/money";

/**
 * The Custom Jewelry approval package: issuing, revising, approving.
 *
 * ============================================================================
 * WHAT IS ACTUALLY AT RISK
 * ============================================================================
 * This package is the evidence a final-sale purchase rests on. A Custom
 * Jewelry order cannot be returned for change of mind — the only ways out are
 * a covered defect, a wrong specification, shipping damage, or a material
 * failure to match the approved design. That last one is only decidable
 * against a design that still says what it said when the customer approved it.
 *
 * So the properties worth the most here are: the customer sees only their own
 * project, the package cannot change after approval, a revision is a new
 * version rather than an edit, and a stale version cannot be approved.
 */

const CUSTOMER_A = "gid://shopify/Customer/1111";
const CUSTOMER_B = "gid://shopify/Customer/2222";
const STAFF = "staff:gid://shopify/StaffMember/9";
const NOW = new Date("2026-11-01T12:00:00.000Z");

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

/** A project, optionally with a paid Design Deposit behind it. */
async function project(
  options: { customerRef?: string | null; withPaidDeposit?: boolean } = {}
): Promise<string> {
  const row = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-${uniq()}`,
      customerRef: options.customerRef === undefined ? CUSTOMER_A : options.customerRef,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-cj-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "A solitaire with a hidden halo.",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });

  if (options.withPaidDeposit) {
    // The real chain: acceptance -> invoice -> payment. The credit points at a
    // transaction that actually happened, which is the whole purpose of the FK.
    const policy = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: "custom-jewelry-design-deposit" },
      orderBy: { version: "desc" },
    });
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "deposit ack fixture",
        policyVersionId: policy.id,
        affirmativeActionLabel: "I Authorize & Agree",
        customerRef: options.customerRef === undefined ? CUSTOMER_A : (options.customerRef ?? undefined),
        acknowledgedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    const acceptance = await prisma.customJewelryDepositAcceptance.create({
      data: {
        projectId: row.id,
        acknowledgmentId: ack.id,
        acceptedAt: new Date("2026-10-01T00:00:00.000Z"),
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        customerRef: options.customerRef === undefined ? CUSTOMER_A : (options.customerRef ?? "gid://shopify/Customer/0"),
      },
    });
    const invoice = await prisma.customJewelryDepositInvoice.create({
      data: {
        acceptanceId: acceptance.id,
        draftOrderGid: `gid://shopify/DraftOrder/dep-${uniq()}`,
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        issuedByActorType: "staff",
        issuedByActorRef: STAFF,
        issuedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });
    await prisma.customJewelryDepositPayment.create({
      data: {
        invoiceId: invoice.id,
        orderGid: `gid://shopify/Order/dep-${uniq()}`,
        amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
        currency: "USD",
        paidAt: new Date("2026-10-03T00:00:00.000Z"),
      },
    });
    await prisma.customJewelryProject.update({
      where: { id: row.id },
      data: { status: "deposit_charged" },
    });
  }

  return row.id;
}

const SPEC = {
  metalType: "gold",
  metalColor: "white",
  centerStone: { kind: "lab_diamond", shape: "oval", carat: "1.80", colour: "F", clarity: "VS1" },
  accentStones: [{ kind: "lab_diamond", count: 24, totalCarat: "0.36" }],
  dimensions: "Band 2.0mm; gallery 7.2mm",
  ringSize: "6.5",
  engraving: "ALWAYS",
  constructionNotes: "Hidden halo; cathedral shoulders.",
  agreedCustomizations: [{ change: "Basket lowered 0.4mm", agreedOn: "2026-10-20" }],
  mediaReferences: [
    { kind: "cad", ref: "r2://custom-jewelry/cad-1.stl" },
    { kind: "render", ref: "r2://custom-jewelry/render-1.png" },
  ],
  approvedTimelineText: "Casting begins the week of 18 November, as agreed by email on 2026-10-22.",
} as const;

function issue(projectId: string, overrides: Record<string, unknown> = {}) {
  return issueApprovalPackage({
    projectId,
    spec: SPEC,
    bankPaymentPrice: usd(500_000n),
    regularCardPrice: usd(517_500n),
    issuedByActorRef: STAFF,
    now: NOW,
    ...overrides,
  } as Parameters<typeof issueApprovalPackage>[0]);
}

/** A real acknowledgment row, as the approval route would create. */
async function acknowledgment(customerRef: string): Promise<string> {
  const policy = await prisma.policyVersion.findFirstOrThrow({
    where: {
      slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
      version: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
    },
  });
  const row = await prisma.acknowledgment.create({
    data: {
      exactText: CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
      policyVersionId: policy.id,
      affirmativeActionLabel: CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
      customerRef,
      acknowledgedAt: NOW,
    },
  });
  return row.id;
}

describe("issuing a package", () => {
  it("freezes the spec, both price bases, the deposit credit and the balances", async () => {
    const projectId = await project({ withPaidDeposit: true });
    const result = await issue(projectId);
    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") return;

    const p = result.package;
    expect(p.version).toBe(1);
    expect(p.status).toBe("issued");
    // The spec, exactly as stated.
    expect(p.metalType).toBe("gold");
    expect(p.ringSize).toBe("6.5");
    expect(p.engraving).toBe("ALWAYS");
    expect(JSON.stringify(p.centerStone)).toContain("oval");
    expect(JSON.stringify(p.mediaReferences)).toContain("cad-1.stl");
    // BOTH bases, frozen — the customer approves before choosing a path.
    expect(p.bankPaymentPriceMinorUnits).toBe(500_000n);
    expect(p.regularCardPriceMinorUnits).toBe(517_500n);
    // The deposit, read from the recorded payment rather than typed.
    expect(p.depositPaidMinorUnits).toBe(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(p.depositCreditMinorUnits).toBe(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(p.depositPaymentId).not.toBeNull();
    // The balances, exact on each basis.
    expect(p.bankPaymentBalanceDueMinorUnits).toBe(500_000n - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    expect(p.regularCardBalanceDueMinorUnits).toBe(517_500n - CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS);
    // And the copy versions the customer will be shown.
    expect(p.approvalAcknowledgmentPolicyVersion).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION);
    expect(p.finalSaleCopyVersion).toBeGreaterThan(0);
  });

  it("issues with NO deposit credit when none was paid", async () => {
    const projectId = await project();
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    expect(result.package.depositCreditMinorUnits).toBe(0n);
    expect(result.package.depositPaymentId).toBeNull();
    expect(result.package.bankPaymentBalanceDueMinorUnits).toBe(500_000n);
  });

  it("moves the project to awaiting_approval", async () => {
    const projectId = await project({ withPaidDeposit: true });
    await issue(projectId);
    const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(row.status).toBe("awaiting_approval");
  });

  it("the DATABASE refuses a second issued package for one project", async () => {
    // Two live packages would let the customer approve either, and "which
    // design did they approve" would be decided by whichever link they clicked.
    const projectId = await project();
    await issue(projectId);
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${projectId}::uuid, 99, 'gold', 'white', '[]'::jsonb, 'USD',
                500000, 517500, 0, 0, 500000, 517500, 1, 1, 1, ${STAFF})`
    ).rejects.toThrow(/23505[\s\S]*project_id/);
  });
});

describe("a design change is a NEW version, never an edit", () => {
  it("supersedes the live version and issues the next one", async () => {
    const projectId = await project({ withPaidDeposit: true });
    const first = await issue(projectId);
    if (first.outcome !== "issued") throw new Error("expected an issue");

    const second = await issue(projectId, {
      spec: { ...SPEC, ringSize: "7", engraving: "FOREVER" },
      bankPaymentPrice: usd(520_000n),
      regularCardPrice: usd(538_200n),
      supersedesReason: "customer changed the size and the engraving",
    });
    expect(second.outcome).toBe("issued");
    if (second.outcome !== "issued") return;
    expect(second.package.version).toBe(2);
    expect(second.supersededVersion).toBe(1);

    // VERSION 1 IS UNCHANGED. Its spec and its price still say what they said.
    const v1 = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: first.package.id },
    });
    expect(v1.status).toBe("superseded");
    expect(v1.ringSize).toBe("6.5");
    expect(v1.engraving).toBe("ALWAYS");
    expect(v1.bankPaymentPriceMinorUnits).toBe(500_000n);
    expect(v1.supersededByVersion).toBe(2);
    expect(v1.supersededReason).toMatch(/changed the size/);
  });

  it("the DATABASE refuses editing a package's spec, price or media", async () => {
    const projectId = await project();
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    const id = result.package.id;

    for (const sql of [
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "ring_size" = '13' WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "engraving" = 'SOMETHING ELSE' WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "metal_type" = 'platinum' WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "bank_payment_price_minor_units" = 1 WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "regular_card_price_minor_units" = 1 WHERE "id" = ${id}::uuid`,
      // A REAL change, not a no-op: this package has no deposit, so setting the
      // credit to 0 would leave the row identical and the guard would correctly
      // see no mutation. The first version of this test did exactly that and
      // passed the UPDATE, which is the trigger being right and the test being
      // wrong.
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "deposit_credit_minor_units" = 1 WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "media_references" = '[]'::jsonb WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "center_stone" = '{"shape":"round"}'::jsonb WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "approved_timeline_text" = 'next week' WHERE "id" = ${id}::uuid`,
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "version" = 7 WHERE "id" = ${id}::uuid`,
    ]) {
      await expect(sql).rejects.toThrow(/immutable/i);
    }
  });

  it("LATER PROJECT EDITS cannot alter historical approval evidence", async () => {
    // The owner's named case. The project's own fields are editable — a phone
    // number changes, a prompt gets clarified — and none of that touches what
    // the customer approved.
    const projectId = await project({ withPaidDeposit: true });
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    await recordCustomerApproval({
      packageId: result.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });

    await prisma.customJewelryProject.update({
      where: { id: projectId },
      data: { promptText: "Actually I wanted a pear cut and a plain band.", phone: "+15555559999" },
    });

    const after = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: result.package.id },
    });
    expect(JSON.stringify(after.centerStone)).toContain("oval");
    expect(after.constructionNotes).toContain("Hidden halo");
    expect(after.status).toBe("approved");
  });

  it("the DATABASE refuses deleting a package", async () => {
    const projectId = await project();
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    await expect(
      prisma.$executeRaw`DELETE FROM "custom_jewelry_approval_package" WHERE "id" = ${result.package.id}::uuid`
    ).rejects.toThrow(/append-only/i);
  });
});

describe("the customer sees only their own project", () => {
  it("customer B cannot load customer A's package", async () => {
    const projectId = await project({ customerRef: CUSTOMER_A });
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");

    expect(
      await findApprovalPackageForCustomer({ packageId: result.package.id, customerRef: CUSTOMER_B })
    ).toBeNull();
    expect(await findIssuedPackageForCustomer({ projectId, customerRef: CUSTOMER_B })).toBeNull();
  });

  it("customer A can load their own", async () => {
    const projectId = await project({ customerRef: CUSTOMER_A });
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    const found = await findApprovalPackageForCustomer({
      packageId: result.package.id,
      customerRef: CUSTOMER_A,
    });
    expect(found?.id).toBe(result.package.id);
  });

  it("a package on a project with NO account is invisible to everyone", async () => {
    // A project never linked to a Shopify customer cannot be approved: the
    // owner requires an authenticated customer, and there is nobody to match.
    const projectId = await project({ customerRef: null });
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    for (const customerRef of [CUSTOMER_A, CUSTOMER_B]) {
      expect(await findApprovalPackageForCustomer({ packageId: result.package.id, customerRef })).toBeNull();
    }
  });

  it("gives the same answer for a foreign package and a nonexistent one", async () => {
    // Distinguishing them would turn this into an oracle for discovering other
    // people's project ids.
    const projectId = await project({ customerRef: CUSTOMER_A });
    const result = await issue(projectId);
    if (result.outcome !== "issued") throw new Error("expected an issue");
    const foreign = await findApprovalPackageForCustomer({
      packageId: result.package.id,
      customerRef: CUSTOMER_B,
    });
    const missing = await findApprovalPackageForCustomer({
      packageId: randomUUID(),
      customerRef: CUSTOMER_B,
    });
    expect(foreign).toBe(missing);
  });
});

describe("approval", () => {
  it("records the customer, the moment and the acknowledgment", async () => {
    const projectId = await project({ withPaidDeposit: true });
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);

    const result = await recordCustomerApproval({
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });
    expect(result.outcome).toBe("approved");
    if (result.outcome !== "approved") return;
    expect(result.package.status).toBe("approved");
    expect(result.package.approvedByCustomerRef).toBe(CUSTOMER_A);
    expect(result.package.approvedAt?.toISOString()).toBe(NOW.toISOString());
    expect(result.package.approvalAcknowledgmentId).toBe(ackId);

    const projectRow = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(projectRow.status).toBe("approved");
  });

  it("is IDEMPOTENT — a double-click does not re-stamp the evidence", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    const args = {
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    };

    const first = await recordCustomerApproval(args);
    expect(first.outcome).toBe("approved");
    const second = await recordCustomerApproval({ ...args, now: new Date("2026-12-01T00:00:00.000Z") });
    expect(second.outcome).toBe("already_approved");
    if (second.outcome !== "already_approved") return;
    // The approval timestamp is evidence. A retry must not rewrite it.
    expect(second.package.approvedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("CONCURRENT approvals converge on one", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    const args = {
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    };

    const results = await Promise.all([recordCustomerApproval(args), recordCustomerApproval(args)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_approved", "approved"]);
    expect(
      await prisma.customJewelryApprovalPackage.count({
        where: { projectId, status: "approved" },
      })
    ).toBe(1);
  });

  it("A STALE VERSION CANNOT BE APPROVED", async () => {
    // The owner's named case. A customer can hold the page open while staff
    // issue a revision; approving the version they are looking at would bind
    // them to a design that is no longer the one being made.
    const projectId = await project();
    const first = await issue(projectId);
    if (first.outcome !== "issued") throw new Error("expected an issue");
    await issue(projectId, { spec: { ...SPEC, ringSize: "8" } });

    const ackId = await acknowledgment(CUSTOMER_A);
    const result = await recordCustomerApproval({
      packageId: first.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });
    expect(result.outcome).toBe("superseded");
    if (result.outcome === "superseded") expect(result.currentVersion).toBe(2);

    // Nothing was approved.
    expect(await prisma.customJewelryApprovalPackage.count({ where: { projectId, status: "approved" } })).toBe(0);
  });

  it("the DATABASE refuses reopening an approved package", async () => {
    // Staff must not silently edit a customer-approved package in place.
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    await recordCustomerApproval({
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });

    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "status" = 'issued' WHERE "id" = ${issued.package.id}::uuid`
    ).rejects.toThrow(/approved and final/i);
    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "status" = 'superseded', "superseded_at" = now(), "superseded_by_version" = 2 WHERE "id" = ${issued.package.id}::uuid`
    ).rejects.toThrow(/approved and final/i);
  });

  it("the DATABASE refuses rewriting an approval record", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    await recordCustomerApproval({
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });

    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_approval_package" SET "approved_by_customer_ref" = ${CUSTOMER_B} WHERE "id" = ${issued.package.id}::uuid`
    ).rejects.toThrow(/immutable/i);
  });

  it("REFUSES issuing a new version once one is approved", async () => {
    // One piece, one approved design. A later change is a commercial
    // conversation, not a quiet re-issue.
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const ackId = await acknowledgment(CUSTOMER_A);
    await recordCustomerApproval({
      packageId: issued.package.id,
      customerRef: CUSTOMER_A,
      acknowledgmentId: ackId,
      now: NOW,
    });

    const result = await issue(projectId, { spec: { ...SPEC, ringSize: "9" } });
    expect(result).toMatchObject({ outcome: "already_approved", approvedVersion: 1 });
  });
});

describe("the project state machine is forward-only", () => {
  it.each([
    ["approved", "awaiting_approval"],
    ["purchased", "approved"],
    ["purchased", "submitted"],
  ])("refuses %s -> %s", async (from, to) => {
    const projectId = await project();
    await prisma.customJewelryProject.update({
      where: { id: projectId },
      data: { status: from as "approved" | "purchased" },
    });
    await expect(
      prisma.customJewelryProject.update({
        where: { id: projectId },
        data: { status: to as "awaiting_approval" | "approved" | "submitted" },
      })
    ).rejects.toThrow(/forward only/i);
  });

  it("allows closing from any stage", async () => {
    // A project can be abandoned at any point, and refusing that would leave
    // dead projects in the active queue forever.
    for (const from of ["submitted", "deposit_charged", "awaiting_approval", "approved"] as const) {
      const projectId = await project();
      await prisma.customJewelryProject.update({ where: { id: projectId }, data: { status: from } });
      await prisma.customJewelryProject.update({ where: { id: projectId }, data: { status: "closed" } });
      const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: projectId } });
      expect(row.status).toBe("closed");
    }
  });

  it("refuses reopening a closed project", async () => {
    const projectId = await project();
    await prisma.customJewelryProject.update({ where: { id: projectId }, data: { status: "closed" } });
    await expect(
      prisma.customJewelryProject.update({ where: { id: projectId }, data: { status: "approved" } })
    ).rejects.toThrow(/forward only/i);
  });
});

describe("the deposit cannot be credited twice", () => {
  it("the DATABASE refuses two packages crediting one payment", async () => {
    // The owner's requirement. Two projects, one deposit payment — which is
    // only reachable by a bug, and is exactly what the index is for.
    const projectId = await project({ withPaidDeposit: true });
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const depositPaymentId = issued.package.depositPaymentId!;

    const otherProjectId = await project();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units","deposit_payment_id",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${otherProjectId}::uuid, 1, 'gold', 'white', '[]'::jsonb, 'USD',
                500000, 517500, 4900, 4900, ${depositPaymentId}::uuid, 495100, 512600, 1, 1, 1, ${STAFF})`
    ).rejects.toThrow(/23505[\s\S]*deposit_payment_id/);
  });

  it("the DATABASE refuses a credit with no payment behind it", async () => {
    const projectId = await project();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${projectId}::uuid, 1, 'gold', 'white', '[]'::jsonb, 'USD',
                500000, 517500, 4900, 4900, 495100, 512600, 1, 1, 1, ${STAFF})`
    ).rejects.toThrow(/credit_has_payment/i);
  });

  it("the DATABASE refuses a credit larger than the price", async () => {
    const projectId = await project();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${projectId}::uuid, 1, 'gold', 'white', '[]'::jsonb, 'USD',
                1000, 1100, 4900, 4900, 0, 0, 1, 1, 1, ${STAFF})`
      // EITHER money constraint is a correct refusal, and which one Postgres
      // reports first is not a property worth pinning: a credit of $49 against
      // a $10 price breaks both "the credit fits" and "the balance is exact",
      // because there is no balance that makes it coherent.
    ).rejects.toThrow(/deposit_credit_fits|balances_exact/i);
  });

  it("the DATABASE refuses a balance that disagrees with price minus credit", async () => {
    const projectId = await project();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${projectId}::uuid, 1, 'gold', 'white', '[]'::jsonb, 'USD',
                500000, 517500, 0, 0, 1, 1, 1, 1, 1, ${STAFF})`
    ).rejects.toThrow(/balances_exact/i);
  });

  it("the DATABASE refuses a card price below the bank price", async () => {
    const projectId = await project();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_approval_package"
          ("id","project_id","version","metal_type","metal_color","media_references","currency",
           "bank_payment_price_minor_units","regular_card_price_minor_units",
           "deposit_paid_minor_units","deposit_credit_minor_units",
           "bank_payment_balance_due_minor_units","regular_card_balance_due_minor_units",
           "final_sale_copy_version","warranty_copy_version","approval_acknowledgment_policy_version",
           "issued_by_actor_ref")
        VALUES (gen_random_uuid(), ${projectId}::uuid, 1, 'gold', 'white', '[]'::jsonb, 'USD',
                500000, 400000, 0, 0, 500000, 400000, 1, 1, 1, ${STAFF})`
    ).rejects.toThrow(/prices_sane/i);
  });
});
