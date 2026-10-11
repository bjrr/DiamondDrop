import { Prisma } from "@prisma/client";
import type { CustomJewelryApprovalPackage } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
  CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION,
} from "~/domain/customjewelry/finalApprovalCopy";
import {
  computeApprovalPackageMoney,
  type ApprovalPackageMoney,
} from "~/domain/customjewelry/finalApprovalMoney";
import { Money } from "~/domain/money/money";
import { logger } from "~/lib/logger.server";

/**
 * Issuing, superseding and approving a Custom Jewelry final approval package.
 *
 * ============================================================================
 * WHAT THIS MODULE PROTECTS
 * ============================================================================
 * The package is the evidence a final-sale purchase rests on. Three properties
 * matter more than anything else here, and each is enforced by the database
 * rather than by this code alone:
 *
 *   one issued package per project    two live packages would let the customer
 *                                     approve either, and "which design did
 *                                     they approve" would be decided by
 *                                     whichever link they clicked.
 *   one approved package per project  one piece, one approved design.
 *   immutable once written            the final-sale exception for "material
 *                                     failure to match the approved design" is
 *                                     only decidable against a design that
 *                                     still says what it said at approval.
 *
 * ============================================================================
 * SUPERSEDING IS A TRANSACTION, NOT A SEQUENCE
 * ============================================================================
 * Issuing version N+1 while version N is live has to mark N superseded and
 * create N+1 as one atomic fact. Two statements would leave a window with
 * either two issued packages (the partial UNIQUE index refuses, so the issue
 * fails and the old one is already marked dead) or none.
 */

/** The warranty copy has no separate version of its own; it ships with the final-sale version. */
const WARRANTY_COPY_VERSION = CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION;

export class ApprovalPackageNotFoundError extends Error {
  constructor(id: string) {
    super(`no custom jewelry approval package ${id}`);
    this.name = "ApprovalPackageNotFoundError";
  }
}

export class ApprovalPackageProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`no custom jewelry project ${id}`);
    this.name = "ApprovalPackageProjectNotFoundError";
  }
}

/**
 * The specification a staff member states. Every field is what it says; none
 * is derived, because a derived spec is a spec nobody agreed.
 */
export interface ApprovalPackageSpecInput {
  readonly metalType: string;
  readonly metalColor: string;
  readonly centerStone?: Prisma.InputJsonValue;
  readonly accentStones?: Prisma.InputJsonValue;
  readonly dimensions?: string;
  readonly ringSize?: string;
  readonly engraving?: string;
  readonly constructionNotes?: string;
  readonly agreedCustomizations?: Prisma.InputJsonValue;
  /** CAD, renderings and final design images, as references. Never bytes. */
  readonly mediaReferences: Prisma.InputJsonValue;
  /**
   * Production/timeline information that is ACTUALLY APPROVED. Omit when none
   * has been agreed — which is honest, and better than a template sentence the
   * owner forbade.
   */
  readonly approvedTimelineText?: string;
}

export interface IssueApprovalPackageInput {
  readonly projectId: string;
  readonly spec: ApprovalPackageSpecInput;
  /** The authoritative underlying figure for the finished piece. */
  readonly bankPaymentPrice: Money;
  /** Derived from it by `deriveRegularCardPrice`, passed in by the caller. */
  readonly regularCardPrice: Money;
  /** The AUTHENTICATED staff identity. Never a form field. */
  readonly issuedByActorRef: string;
  /** Why this supersedes the previous version, when one is live. */
  readonly supersedesReason?: string;
  readonly now: Date;
}

export type IssueApprovalPackageResult =
  | { readonly outcome: "issued"; readonly package: CustomJewelryApprovalPackage; readonly supersededVersion: number | null }
  /** The project already has an APPROVED package. One piece, one approved design. */
  | { readonly outcome: "already_approved"; readonly approvedVersion: number };

/**
 * Issues a new approval package, superseding any live one.
 *
 * THE DEPOSIT IS READ FROM THE RECORDED PAYMENT, never passed in. A staff
 * member typing the credit would be typing money, and the whole point of the
 * `deposit_payment_id` FK is that the credit points at a transaction that
 * actually happened.
 */
export async function issueApprovalPackage(
  input: IssueApprovalPackageInput
): Promise<IssueApprovalPackageResult> {
  const project = await prisma.customJewelryProject.findUnique({
    where: { id: input.projectId },
    include: {
      depositAcceptance: { include: { invoice: { include: { payment: true } } } },
      approvalPackages: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!project) throw new ApprovalPackageProjectNotFoundError(input.projectId);

  // ONE APPROVED PACKAGE PER PROJECT. Checked before anything is written so
  // the caller gets a clear answer rather than a constraint violation — and
  // the partial UNIQUE index refuses it anyway if this races.
  const approved = await prisma.customJewelryApprovalPackage.findFirst({
    where: { projectId: input.projectId, status: "approved" },
    select: { version: true },
  });
  if (approved) return { outcome: "already_approved", approvedVersion: approved.version };

  const payment = project.depositAcceptance?.invoice?.payment ?? null;
  const depositPaid = payment
    ? Money.fromMinorUnits(payment.amountMinorUnits, payment.currency)
    : Money.fromMinorUnits(0n, input.bankPaymentPrice.currency);

  // THE ARITHMETIC IS THE DOMAIN'S, not this module's. A repository that
  // computes money is a repository that has to be tested for money.
  const money: ApprovalPackageMoney = computeApprovalPackageMoney({
    bankPaymentPrice: input.bankPaymentPrice,
    regularCardPrice: input.regularCardPrice,
    depositPaid,
  });

  const live = await prisma.customJewelryApprovalPackage.findFirst({
    where: { projectId: input.projectId, status: "issued" },
    select: { id: true, version: true },
  });
  const nextVersion = (project.approvalPackages[0]?.version ?? 0) + 1;

  // ONE TRANSACTION. Superseding the live version and creating the next one is
  // a single fact; two statements would leave a window with two issued
  // packages or none.
  const created = await prisma.$transaction(async (tx) => {
    if (live) {
      const superseded = await tx.customJewelryApprovalPackage.updateMany({
        // Conditional on STILL being issued: if the customer approved it while
        // we were reading, this writes nothing and the create below fails on
        // the one-approved index rather than quietly killing their approval.
        where: { id: live.id, status: "issued" },
        data: {
          status: "superseded",
          supersededAt: input.now,
          supersededByVersion: nextVersion,
          supersededReason:
            input.supersedesReason ?? `superseded by version ${nextVersion}`,
        },
      });
      if (superseded.count !== 1) {
        throw new Prisma.PrismaClientKnownRequestError(
          `approval package ${live.id} was no longer issued when version ${nextVersion} was created`,
          { code: "P2025", clientVersion: "x" }
        );
      }
    }

    return tx.customJewelryApprovalPackage.create({
      data: {
        projectId: input.projectId,
        version: nextVersion,
        metalType: input.spec.metalType,
        metalColor: input.spec.metalColor,
        ...(input.spec.centerStone !== undefined ? { centerStone: input.spec.centerStone } : {}),
        ...(input.spec.accentStones !== undefined ? { accentStones: input.spec.accentStones } : {}),
        ...(input.spec.dimensions !== undefined ? { dimensions: input.spec.dimensions } : {}),
        ...(input.spec.ringSize !== undefined ? { ringSize: input.spec.ringSize } : {}),
        ...(input.spec.engraving !== undefined ? { engraving: input.spec.engraving } : {}),
        ...(input.spec.constructionNotes !== undefined
          ? { constructionNotes: input.spec.constructionNotes }
          : {}),
        ...(input.spec.agreedCustomizations !== undefined
          ? { agreedCustomizations: input.spec.agreedCustomizations }
          : {}),
        mediaReferences: input.spec.mediaReferences,
        ...(input.spec.approvedTimelineText !== undefined
          ? { approvedTimelineText: input.spec.approvedTimelineText }
          : {}),
        currency: money.bankPaymentPrice.currency,
        bankPaymentPriceMinorUnits: money.bankPaymentPrice.amountMinorUnits,
        regularCardPriceMinorUnits: money.regularCardPrice.amountMinorUnits,
        depositPaidMinorUnits: money.depositPaid.amountMinorUnits,
        depositCreditMinorUnits: money.depositCredit.amountMinorUnits,
        // Null when no deposit was paid — and the CHECK requires a payment id
        // whenever the credit is non-zero, so crediting money nobody can point
        // at is unrepresentable.
        ...(payment && money.depositCredit.amountMinorUnits > 0n
          ? { depositPaymentId: payment.id }
          : {}),
        bankPaymentBalanceDueMinorUnits: money.bankPaymentBalanceDue.amountMinorUnits,
        regularCardBalanceDueMinorUnits: money.regularCardBalanceDue.amountMinorUnits,
        finalSaleCopyVersion: CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION,
        warrantyCopyVersion: WARRANTY_COPY_VERSION,
        approvalAcknowledgmentPolicyVersion: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
        issuedAt: input.now,
        issuedByActorRef: input.issuedByActorRef,
      },
    });
  });

  // The project advances to `awaiting_approval`. Conditional and forward-only:
  // a project already further along is not dragged backwards, and the trigger
  // refuses it regardless.
  await prisma.customJewelryProject.updateMany({
    where: { id: input.projectId, status: { in: ["submitted", "deposit_charged"] } },
    data: { status: "awaiting_approval" },
  });

  await createAuditEvent({
    entityType: "custom_jewelry_approval_package",
    entityId: created.id,
    action: "issued",
    actorType: "staff",
    actorRef: input.issuedByActorRef,
    after: {
      projectId: input.projectId,
      version: created.version,
      bankPaymentPriceMinorUnits: created.bankPaymentPriceMinorUnits.toString(),
      regularCardPriceMinorUnits: created.regularCardPriceMinorUnits.toString(),
      depositCreditMinorUnits: created.depositCreditMinorUnits.toString(),
      supersededVersion: live?.version ?? null,
    },
  });

  logger.info("custom_jewelry_approval.issued", {
    projectId: input.projectId,
    packageId: created.id,
    version: created.version,
  });

  return { outcome: "issued", package: created, supersededVersion: live?.version ?? null };
}

export type ApproveResult =
  | { readonly outcome: "approved"; readonly package: CustomJewelryApprovalPackage }
  /** The same customer approving again. Idempotent, and nothing is rewritten. */
  | { readonly outcome: "already_approved"; readonly package: CustomJewelryApprovalPackage }
  /** A newer version exists. The customer was looking at a stale page. */
  | { readonly outcome: "superseded"; readonly currentVersion: number | null }
  | { readonly outcome: "not_found" };

/**
 * Records the customer's approval of one specific package version.
 *
 * ============================================================================
 * CONDITIONAL ON THE VERSION STILL BEING THE LIVE ONE
 * ============================================================================
 * A customer can hold a page open while staff issue a revision. Approving the
 * version they are LOOKING AT, after it has been superseded, would bind them to
 * a design that is no longer the one being made — so the update is conditional
 * on `status = 'issued'` and a superseded version reports itself as such.
 *
 * IDEMPOTENT. A double-click, a retried request or a back-button resubmission
 * finds the package already approved and returns it unchanged. Re-stamping
 * would rewrite the approval timestamp, which is evidence.
 */
export async function recordCustomerApproval(input: {
  readonly packageId: string;
  /** The AUTHENTICATED Shopify customer. Never a body field. */
  readonly customerRef: string;
  readonly acknowledgmentId: string;
  readonly now: Date;
}): Promise<ApproveResult> {
  const existing = await prisma.customJewelryApprovalPackage.findUnique({
    where: { id: input.packageId },
    select: { id: true, projectId: true, status: true, version: true, approvedByCustomerRef: true },
  });
  if (!existing) return { outcome: "not_found" };

  if (existing.status === "approved") {
    const row = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: input.packageId },
    });
    return { outcome: "already_approved", package: row };
  }
  if (existing.status === "superseded") {
    const current = await prisma.customJewelryApprovalPackage.findFirst({
      where: { projectId: existing.projectId, status: "issued" },
      select: { version: true },
    });
    return { outcome: "superseded", currentVersion: current?.version ?? null };
  }

  // THE CONDITIONAL WRITE. `status = 'issued'` in the WHERE is what makes a
  // concurrent supersession safe: the loser writes nothing.
  const updated = await prisma.customJewelryApprovalPackage.updateMany({
    where: { id: input.packageId, status: "issued" },
    data: {
      status: "approved",
      approvedAt: input.now,
      approvedByCustomerRef: input.customerRef,
      approvalAcknowledgmentId: input.acknowledgmentId,
    },
  });

  if (updated.count !== 1) {
    // Lost a race. Re-read and report what actually happened rather than
    // guessing — the two outcomes mean very different things to the customer.
    const after = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: input.packageId },
    });
    if (after.status === "approved") return { outcome: "already_approved", package: after };
    const current = await prisma.customJewelryApprovalPackage.findFirst({
      where: { projectId: existing.projectId, status: "issued" },
      select: { version: true },
    });
    return { outcome: "superseded", currentVersion: current?.version ?? null };
  }

  // Forward-only, conditional: the project reaches `approved` from
  // `awaiting_approval` and is not dragged back from anywhere later.
  await prisma.customJewelryProject.updateMany({
    where: { id: existing.projectId, status: { in: ["submitted", "deposit_charged", "awaiting_approval"] } },
    data: { status: "approved" },
  });

  const row = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
    where: { id: input.packageId },
  });

  await createAuditEvent({
    entityType: "custom_jewelry_approval_package",
    entityId: row.id,
    action: "customer_approved",
    actorType: "customer",
    actorRef: input.customerRef,
    after: {
      projectId: row.projectId,
      version: row.version,
      approvedAt: input.now.toISOString(),
      acknowledgmentId: input.acknowledgmentId,
      approvalAcknowledgmentPolicyVersion: row.approvalAcknowledgmentPolicyVersion,
      finalSaleCopyVersion: row.finalSaleCopyVersion,
    },
  });

  logger.info("custom_jewelry_approval.customer_approved", {
    packageId: row.id,
    projectId: row.projectId,
    version: row.version,
  });

  return { outcome: "approved", package: row };
}

/**
 * The package a given customer is allowed to see for a given project.
 *
 * ============================================================================
 * THE OWNERSHIP CHECK IS THE JOIN, NOT A COMPARISON AFTERWARDS
 * ============================================================================
 * Owner requirement: "The customer must only be able to view and approve their
 * own project." Written as a `where` clause on the project's own
 * `customerRef`, so there is no code path that loads a package first and
 * compares second — the shape where somebody later moves the comparison, or
 * returns early before reaching it.
 *
 * A project belonging to another customer and a project that does not exist
 * get the SAME answer: null. Distinguishing them would turn this into an
 * oracle for discovering other people's project ids.
 */
export async function findApprovalPackageForCustomer(input: {
  readonly packageId: string;
  readonly customerRef: string;
}): Promise<CustomJewelryApprovalPackage | null> {
  return prisma.customJewelryApprovalPackage.findFirst({
    where: {
      id: input.packageId,
      project: { customerRef: input.customerRef },
    },
  });
}

/** The live package for a project, for a customer who owns it. */
export async function findIssuedPackageForCustomer(input: {
  readonly projectId: string;
  readonly customerRef: string;
}): Promise<CustomJewelryApprovalPackage | null> {
  return prisma.customJewelryApprovalPackage.findFirst({
    where: {
      projectId: input.projectId,
      status: "issued",
      project: { customerRef: input.customerRef },
    },
  });
}
