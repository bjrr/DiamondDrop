import { prisma } from "~/db/client.server";

/**
 * What staff need to see about a Custom Jewelry project's final approval and
 * purchase.
 *
 * ============================================================================
 * HISTORY INCLUDES SUPERSEDED VERSIONS, DELIBERATELY
 * ============================================================================
 * A superseded package is not clutter. It is the evidence of what was offered
 * before the design changed, and the final-sale exception for "material
 * failure to match the approved design" is decided against exactly these rows.
 * A view that showed only the current version would make the earlier ones
 * unreachable precisely when a claim needs them.
 *
 * ============================================================================
 * THE QUEUES ANSWER "WHAT DO I DO", NOT "WHAT STATUS IS THIS"
 * ============================================================================
 * Same discipline as the Let Us Beat Your Quote queue. "Blocked on the
 * customer" and "a payment anomaly" are the two states that need a person, and
 * neither is readable from `custom_jewelry_project.status` alone — a project
 * sits at `awaiting_approval` whether the customer has been sent a package or
 * not, and at `purchased` whether the money arrived or not.
 */

export interface ApprovalPackageStaffView {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly issuedAt: Date;
  readonly issuedByActorRef: string;
  readonly approvedAt: Date | null;
  readonly approvedByCustomerRef: string | null;
  readonly supersededAt: Date | null;
  readonly supersededByVersion: number | null;
  readonly supersededReason: string | null;
  readonly currency: string;
  readonly bankPaymentPriceMinorUnits: bigint;
  readonly regularCardPriceMinorUnits: bigint;
  readonly depositPaidMinorUnits: bigint;
  readonly depositCreditMinorUnits: bigint;
  readonly bankPaymentBalanceDueMinorUnits: bigint;
  readonly regularCardBalanceDueMinorUnits: bigint;
  /** The copy versions the customer was shown, preserved per the owner's list. */
  readonly finalSaleCopyVersion: number;
  readonly approvalAcknowledgmentPolicyVersion: number;
  readonly ringSize: string | null;
  readonly engraving: string | null;
  readonly metalType: string;
  readonly metalColor: string;
}

export interface FinalPurchaseStaffView {
  readonly id: string;
  readonly paymentBasis: string;
  readonly status: string;
  readonly currency: string;
  readonly grossApprovedPriceMinorUnits: bigint;
  readonly depositCreditMinorUnits: bigint;
  readonly depositPaymentReference: string | null;
  readonly benefitDiscountMinorUnits: bigint;
  readonly balanceDueMinorUnits: bigint;
  readonly bankPaymentOrderId: string | null;
  readonly shopifyDraftOrderGid: string | null;
  readonly shopifyOrderGid: string | null;
  readonly paidAt: Date | null;
  /** The bank order's own verification state, when this is a bank purchase. */
  readonly bankOrderStatus: string | null;
  readonly bankOrderVerifiedAt: Date | null;
}

export interface ProjectApprovalHistory {
  readonly packages: readonly ApprovalPackageStaffView[];
  readonly purchase: FinalPurchaseStaffView | null;
}

/** Every approval package for a project, newest first, plus the purchase if one exists. */
export async function loadProjectApprovalHistory(projectId: string): Promise<ProjectApprovalHistory> {
  const [packages, purchase] = await Promise.all([
    prisma.customJewelryApprovalPackage.findMany({
      where: { projectId },
      // NEWEST FIRST — the opposite of the triage queues. A reviewer opening a
      // project wants the current design at the top; history is context below
      // it, not a list to work through.
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        status: true,
        issuedAt: true,
        issuedByActorRef: true,
        approvedAt: true,
        approvedByCustomerRef: true,
        supersededAt: true,
        supersededByVersion: true,
        supersededReason: true,
        currency: true,
        bankPaymentPriceMinorUnits: true,
        regularCardPriceMinorUnits: true,
        depositPaidMinorUnits: true,
        depositCreditMinorUnits: true,
        bankPaymentBalanceDueMinorUnits: true,
        regularCardBalanceDueMinorUnits: true,
        finalSaleCopyVersion: true,
        approvalAcknowledgmentPolicyVersion: true,
        ringSize: true,
        engraving: true,
        metalType: true,
        metalColor: true,
      },
    }),
    prisma.customJewelryFinalPurchase.findFirst({
      where: { projectId },
      include: { bankPaymentOrder: { select: { status: true, verifiedAt: true } } },
    }),
  ]);

  return {
    packages,
    purchase: purchase
      ? {
          id: purchase.id,
          paymentBasis: purchase.paymentBasis,
          status: purchase.status,
          currency: purchase.currency,
          grossApprovedPriceMinorUnits: purchase.grossApprovedPriceMinorUnits,
          depositCreditMinorUnits: purchase.depositCreditMinorUnits,
          depositPaymentReference: purchase.depositPaymentReference,
          benefitDiscountMinorUnits: purchase.benefitDiscountMinorUnits,
          balanceDueMinorUnits: purchase.balanceDueMinorUnits,
          bankPaymentOrderId: purchase.bankPaymentOrderId,
          shopifyDraftOrderGid: purchase.shopifyDraftOrderGid,
          shopifyOrderGid: purchase.shopifyOrderGid,
          paidAt: purchase.paidAt,
          bankOrderStatus: purchase.bankPaymentOrder?.status ?? null,
          bankOrderVerifiedAt: purchase.bankPaymentOrder?.verifiedAt ?? null,
        }
      : null,
  };
}

export interface BlockedOnCustomerRow {
  readonly projectId: string;
  readonly projectReference: string;
  readonly customerName: string;
  readonly email: string;
  readonly packageId: string;
  readonly version: number;
  readonly issuedAt: Date;
  /** False when the project has no Shopify account linked — they cannot approve at all. */
  readonly hasAccount: boolean;
}

/**
 * Projects waiting on the customer to approve.
 *
 * DERIVED FROM THE PACKAGE, NOT THE PROJECT. A project sits at
 * `awaiting_approval` whether a package has been issued or not, so the project
 * status cannot distinguish "we owe them a package" from "they owe us an
 * answer". An `issued` package with no approval is exactly the second.
 *
 * `hasAccount` is carried because a project never linked to a Shopify customer
 * CANNOT be approved — the owner requires an authenticated customer, and there
 * is nobody to match. That row is blocked on us getting them signed in, not on
 * them deciding, and a queue that conflated the two would have staff chasing a
 * customer who has no way to act.
 */
export async function listProjectsBlockedOnCustomer(): Promise<BlockedOnCustomerRow[]> {
  const rows = await prisma.customJewelryApprovalPackage.findMany({
    where: { status: "issued" },
    // Oldest first: a triage queue is worked front to back, and the customer
    // kept waiting longest is the one to chase.
    orderBy: { issuedAt: "asc" },
    select: {
      id: true,
      version: true,
      issuedAt: true,
      project: {
        select: { id: true, projectReference: true, firstName: true, lastName: true, email: true, customerRef: true },
      },
    },
  });

  return rows.map((row) => ({
    projectId: row.project.id,
    projectReference: row.project.projectReference,
    customerName: `${row.project.firstName} ${row.project.lastName}`,
    email: row.project.email,
    packageId: row.id,
    version: row.version,
    issuedAt: row.issuedAt,
    hasAccount: row.project.customerRef !== null,
  }));
}

export type PaymentAnomalyKind =
  /** The bank order was cancelled. Money will never arrive, so the piece is not being made. */
  | "bank_order_cancelled"
  /** The bank order's funds were verified but the purchase never advanced. Our record is behind. */
  | "verified_but_not_recorded"
  /** Approved and never purchased. A sales follow-up rather than a fault. */
  | "approved_never_purchased";

export interface PaymentAnomalyRow {
  readonly kind: PaymentAnomalyKind;
  readonly projectId: string;
  readonly projectReference: string;
  readonly purchaseId: string | null;
  readonly approvalPackageId: string;
  readonly detail: string;
  readonly since: Date;
}

/**
 * Custom Jewelry payments that need a person.
 *
 * THREE DISTINCT SHAPES, EACH NEEDING A DIFFERENT ACTION, which is why they
 * are one function returning a kind rather than three the caller has to
 * remember to call:
 *
 *   bank_order_cancelled        the piece is not being made; tell the customer
 *   verified_but_not_recorded   the money arrived and our record is behind —
 *                               the urgent one, because the customer has paid
 *                               and nothing downstream knows
 *   approved_never_purchased    a sales follow-up, not a fault
 *
 * `approvedBefore` bounds the third: an approval from five minutes ago is a
 * customer still choosing a payment method, not an anomaly. The caller passes
 * the cutoff rather than this module inventing a policy deadline, because
 * there is no locked rule about how long a customer may take to pay.
 */
export async function listCustomJewelryPaymentAnomalies(input: {
  readonly approvedBefore: Date;
}): Promise<PaymentAnomalyRow[]> {
  const [cancelled, verifiedNotRecorded, neverPurchased] = await Promise.all([
    prisma.customJewelryFinalPurchase.findMany({
      where: { status: "awaiting_payment", bankPaymentOrder: { status: "cancelled" } },
      include: { project: { select: { projectReference: true } }, bankPaymentOrder: true },
    }),
    prisma.customJewelryFinalPurchase.findMany({
      where: { status: "awaiting_payment", bankPaymentOrder: { verifiedAt: { not: null } } },
      include: { project: { select: { projectReference: true } }, bankPaymentOrder: true },
    }),
    prisma.customJewelryApprovalPackage.findMany({
      where: {
        status: "approved",
        approvedAt: { lt: input.approvedBefore },
        finalPurchase: { is: null },
      },
      include: { project: { select: { id: true, projectReference: true } } },
    }),
  ]);

  const rows: PaymentAnomalyRow[] = [
    ...cancelled.map((p) => ({
      kind: "bank_order_cancelled" as const,
      projectId: p.projectId,
      projectReference: p.project.projectReference,
      purchaseId: p.id,
      approvalPackageId: p.approvalPackageId,
      detail:
        `the bank payment order was cancelled (${p.bankPaymentOrder?.cancellationReason ?? "no reason recorded"}), ` +
        `so the balance of ${p.balanceDueMinorUnits} ${p.currency} will not arrive`,
      since: p.bankPaymentOrder?.cancelledAt ?? p.createdAt,
    })),
    ...verifiedNotRecorded.map((p) => ({
      kind: "verified_but_not_recorded" as const,
      projectId: p.projectId,
      projectReference: p.project.projectReference,
      purchaseId: p.id,
      approvalPackageId: p.approvalPackageId,
      detail:
        `the bank payment order's funds were verified at ` +
        `${p.bankPaymentOrder?.verifiedAt?.toISOString() ?? "an unrecorded time"} but this purchase is still ` +
        `awaiting payment — the customer has paid and nothing downstream knows`,
      since: p.bankPaymentOrder?.verifiedAt ?? p.createdAt,
    })),
    ...neverPurchased.map((pkg) => ({
      kind: "approved_never_purchased" as const,
      projectId: pkg.project.id,
      projectReference: pkg.project.projectReference,
      purchaseId: null,
      approvalPackageId: pkg.id,
      detail: `approved version ${pkg.version} on ${pkg.approvedAt?.toISOString() ?? "an unrecorded date"} and no purchase was ever created`,
      since: pkg.approvedAt ?? pkg.issuedAt,
    })),
  ];

  // Oldest first across all three kinds: the thing that has been wrong longest
  // is the thing to look at, whichever shape it is.
  return rows.sort((a, b) => a.since.getTime() - b.since.getTime());
}
