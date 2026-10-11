import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  issueApprovalPackage,
  recordCustomerApproval,
} from "~/db/repositories/customJewelryApprovalRepository.server";
import {
  listCustomJewelryPaymentAnomalies,
  listProjectsBlockedOnCustomer,
  loadProjectApprovalHistory,
} from "~/db/repositories/customJewelryStaffRepository.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
} from "~/domain/customjewelry/finalApprovalCopy";
import { Money } from "~/domain/money/money";
import { createCustomJewelryFinalPurchase } from "~/jobs/customjewelry/createFinalPurchase.server";
import type {
  CreateCustomJewelryDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";

/**
 * What staff can see, and what the queues surface.
 *
 * ============================================================================
 * EVERY TEST SCOPES TO ITS OWN ROWS
 * ============================================================================
 * The two queue functions are deliberately unpaginated and unfiltered — they
 * return everything needing attention in the whole database — so asserting on
 * counts would make each test depend on every other test's leftovers. Two of
 * my own admin-queue tests failed that way once, and one in this very
 * workstream did again.
 */

const CUSTOMER = "gid://shopify/Customer/3333";
const STAFF = "staff:gid://shopify/StaffMember/9";
const NOW = new Date("2026-11-01T12:00:00.000Z");
const BANK_PRICE = 500_000n;
const CARD_PRICE = 517_500n;

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

function port(): DraftOrderPort {
  return {
    async createCustomJewelryDraftOrder(
      _input: CreateCustomJewelryDraftOrderInput
    ): Promise<CreatedDraftOrder> {
      return { draftOrderGid: `gid://shopify/DraftOrder/sv-${uniq()}`, invoiceUrl: null };
    },
    async createRedemptionDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async createServiceDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("not expected");
    },
    async completeDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async cancelDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
  };
}

async function project(customerRef: string | null = CUSTOMER): Promise<string> {
  const row = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-SV-${uniq()}`,
      customerRef,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-sv-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "A solitaire.",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });
  return row.id;
}

function issue(projectId: string, overrides: Record<string, unknown> = {}) {
  return issueApprovalPackage({
    projectId,
    spec: { metalType: "platinum", metalColor: "white", ringSize: "6.5", mediaReferences: [] },
    bankPaymentPrice: usd(BANK_PRICE),
    regularCardPrice: usd(CARD_PRICE),
    issuedByActorRef: STAFF,
    now: NOW,
    ...overrides,
  } as Parameters<typeof issueApprovalPackage>[0]);
}

async function approve(packageId: string, customerRef: string = CUSTOMER, at: Date = NOW) {
  const policy = await prisma.policyVersion.findFirstOrThrow({
    where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
    orderBy: { version: "desc" },
  });
  const ack = await prisma.acknowledgment.create({
    data: {
      exactText: CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
      policyVersionId: policy.id,
      affirmativeActionLabel: CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
      customerRef,
      acknowledgedAt: at,
    },
  });
  return recordCustomerApproval({ packageId, customerRef, acknowledgmentId: ack.id, now: at });
}

describe("the project's approval history", () => {
  it("shows every version newest first, INCLUDING superseded ones", async () => {
    // A superseded version is the evidence of what was offered before the
    // design changed, and a claim about "the approved design" is decided
    // against exactly those rows.
    const projectId = await project();
    await issue(projectId);
    await issue(projectId, {
      spec: { metalType: "gold", metalColor: "yellow", ringSize: "7", mediaReferences: [] },
      supersedesReason: "customer changed metal",
    });

    const history = await loadProjectApprovalHistory(projectId);
    expect(history.packages.map((p) => p.version)).toEqual([2, 1]);
    expect(history.packages[1]!.status).toBe("superseded");
    expect(history.packages[1]!.supersededByVersion).toBe(2);
    expect(history.packages[1]!.supersededReason).toMatch(/changed metal/);
    // And version 1 still says what it said.
    expect(history.packages[1]!.metalType).toBe("platinum");
    expect(history.packages[0]!.metalType).toBe("gold");
  });

  it("shows WHETHER the customer approved, and which exact version", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    await approve(issued.package.id);

    const history = await loadProjectApprovalHistory(projectId);
    const approved = history.packages.find((p) => p.status === "approved");
    expect(approved?.version).toBe(1);
    expect(approved?.approvedByCustomerRef).toBe(CUSTOMER);
    expect(approved?.approvedAt).not.toBeNull();
    // The copy versions the customer was shown, preserved per the owner's list.
    expect(approved?.approvalAcknowledgmentPolicyVersion).toBeGreaterThan(0);
    expect(approved?.finalSaleCopyVersion).toBeGreaterThan(0);
  });

  it("shows the deposit reference, the remaining balance and the Shopify order", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    await approve(issued.package.id);
    const created = await createCustomJewelryFinalPurchase({
      approvalPackageId: issued.package.id,
      customerRef: CUSTOMER,
      email: "ada@example.com",
      shippingAddress: { address1: "1 Way", city: "London", zip: "SW1A 1AA", countryCode: "GB" },
      paymentBasis: "card",
      draftOrderPort: port(),
      now: NOW,
    });
    if (created.outcome !== "created") throw new Error("expected creation");

    const history = await loadProjectApprovalHistory(projectId);
    expect(history.purchase).not.toBeNull();
    // THE GROSS PRICE IS VISIBLE, not just the balance.
    expect(history.purchase!.grossApprovedPriceMinorUnits).toBe(CARD_PRICE);
    expect(history.purchase!.balanceDueMinorUnits).toBe(CARD_PRICE);
    expect(history.purchase!.shopifyDraftOrderGid).not.toBeNull();
    expect(history.purchase!.status).toBe("awaiting_payment");
  });

  it("returns an empty history for a project with no package", async () => {
    const history = await loadProjectApprovalHistory(await project());
    expect(history.packages).toEqual([]);
    expect(history.purchase).toBeNull();
  });
});

describe("projects blocked on the customer", () => {
  /** Only this test's own row, found by project id. */
  async function findMine(projectId: string) {
    const rows = await listProjectsBlockedOnCustomer();
    return rows.find((row) => row.projectId === projectId) ?? null;
  }

  it("SURFACES a project with an issued package and no approval", async () => {
    // Derived from the PACKAGE, not the project: a project sits at
    // `awaiting_approval` whether a package has been issued or not, so the
    // project status cannot distinguish "we owe them a package" from "they owe
    // us an answer".
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");

    const row = await findMine(projectId);
    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
    expect(row!.packageId).toBe(issued.package.id);
    expect(row!.hasAccount).toBe(true);
  });

  it("STOPS surfacing it once the customer approves", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    expect(await findMine(projectId)).not.toBeNull();

    await approve(issued.package.id);
    expect(await findMine(projectId)).toBeNull();
  });

  it("flags a project with NO ACCOUNT as unable to approve", async () => {
    // Blocked on US getting them signed in, not on them deciding. A queue that
    // conflated the two would have staff chasing a customer who has no way to
    // act.
    const projectId = await project(null);
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");

    const row = await findMine(projectId);
    expect(row).not.toBeNull();
    expect(row!.hasAccount).toBe(false);
  });

  it("does NOT surface a project whose package was superseded", async () => {
    // Only the live version is waiting on anyone.
    const projectId = await project();
    const first = await issue(projectId);
    if (first.outcome !== "issued") throw new Error("expected an issue");
    await issue(projectId, { spec: { metalType: "gold", metalColor: "rose", mediaReferences: [] } });

    const rows = await listProjectsBlockedOnCustomer();
    const mine = rows.filter((r) => r.projectId === projectId);
    // Exactly one — the live version, not the superseded one.
    expect(mine).toHaveLength(1);
    expect(mine[0]!.version).toBe(2);
  });
});

describe("payment anomalies", () => {
  const FAR_FUTURE = new Date("2027-01-01T00:00:00.000Z");

  async function findMine(projectId: string) {
    const rows = await listCustomJewelryPaymentAnomalies({ approvedBefore: FAR_FUTURE });
    return rows.filter((row) => row.projectId === projectId);
  }

  async function purchasedProject(basis: "card" | "bank_payment") {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    await approve(issued.package.id);
    const created = await createCustomJewelryFinalPurchase({
      approvalPackageId: issued.package.id,
      customerRef: CUSTOMER,
      email: "ada@example.com",
      shippingAddress: { address1: "1 Way", city: "London", zip: "SW1A 1AA", countryCode: "GB" },
      paymentBasis: basis,
      draftOrderPort: port(),
      now: NOW,
    });
    if (created.outcome !== "created") throw new Error("expected creation");
    return { projectId, purchase: created.purchase };
  }

  it("flags a purchase whose bank order was CANCELLED", async () => {
    // Money will never arrive, so the piece is not being made.
    const { projectId, purchase } = await purchasedProject("bank_payment");
    await prisma.bankPaymentOrder.update({
      where: { id: purchase.bankPaymentOrderId! },
      data: {
        status: "cancelled",
        cancelledAt: NOW,
        cancellationReason: "unpaid after the payment window",
      },
    });

    const mine = await findMine(projectId);
    expect(mine.map((r) => r.kind)).toContain("bank_order_cancelled");
    expect(mine.find((r) => r.kind === "bank_order_cancelled")!.detail).toMatch(/will not arrive/);
  });

  it("flags funds VERIFIED but the purchase never advanced — the urgent one", async () => {
    // The customer has paid and nothing downstream knows.
    const { projectId, purchase } = await purchasedProject("bank_payment");
    await prisma.bankPaymentOrder.update({
      where: { id: purchase.bankPaymentOrderId! },
      data: {
        verifiedAt: NOW,
        verifiedPaymentAmountMinorUnits: purchase.balanceDueMinorUnits,
        verifiedPaymentCurrency: "USD",
        verifiedPaymentMethod: "wire",
        verifiedPaymentReference: "WIRE-123",
        verifiedByShopifyUserId: 77n,
        verifiedByEmail: "staff@example.com",
      },
    });

    const mine = await findMine(projectId);
    const row = mine.find((r) => r.kind === "verified_but_not_recorded");
    expect(row).toBeDefined();
    expect(row!.detail).toMatch(/customer has paid and nothing downstream knows/);
  });

  it("flags an approval that was never purchased", async () => {
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    await approve(issued.package.id);

    const mine = await findMine(projectId);
    expect(mine.map((r) => r.kind)).toContain("approved_never_purchased");
  });

  it("does NOT flag an approval newer than the cutoff", async () => {
    // An approval from five minutes ago is a customer still choosing a payment
    // method, not an anomaly. The caller passes the cutoff rather than this
    // module inventing a policy deadline — there is no locked rule about how
    // long a customer may take to pay.
    const projectId = await project();
    const issued = await issue(projectId);
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    await approve(issued.package.id, CUSTOMER, NOW);

    const rows = await listCustomJewelryPaymentAnomalies({
      approvedBefore: new Date(NOW.getTime() - 60_000),
    });
    expect(rows.filter((r) => r.projectId === projectId)).toHaveLength(0);
  });

  it("does NOT flag a healthy awaiting-payment purchase", async () => {
    const { projectId } = await purchasedProject("bank_payment");
    const mine = await findMine(projectId);
    // The approval HAS a purchase, the bank order is open and unverified —
    // nothing is wrong.
    expect(mine).toHaveLength(0);
  });

  it("orders oldest first across all three kinds", async () => {
    // The thing that has been wrong longest is the thing to look at, whichever
    // shape it is.
    const rows = await listCustomJewelryPaymentAnomalies({ approvedBefore: FAR_FUTURE });
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.since.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.since.getTime());
    }
  });
});
