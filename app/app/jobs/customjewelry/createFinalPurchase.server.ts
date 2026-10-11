import { Prisma } from "@prisma/client";
import type { CustomJewelryApprovalPackage, CustomJewelryFinalPurchase } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import {
  computeApprovalPackageMoney,
  computeFinalPurchaseAmounts,
  type CustomJewelryPaymentBasis,
} from "~/domain/customjewelry/finalApprovalMoney";
import { Money } from "~/domain/money/money";
import { attachBankPaymentOrderToRedemption } from "~/jobs/beatyourquote/bankPaymentRedemption.server";
import {
  attachRedemptionDraftOrder,
  releaseBeatQuoteRedemption,
  reserveBeatQuoteRedemption,
  type ReserveRefusal,
} from "~/jobs/beatyourquote/redeemFallbackBenefit.server";
import { logger } from "~/lib/logger.server";
import type { DraftOrderPort, DraftOrderShippingAddressInput } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Creating the authoritative payable object for a Custom Jewelry final
 * purchase.
 *
 * ============================================================================
 * ONE PURCHASE PER APPROVED PACKAGE, AND THE DATABASE DECIDES
 * ============================================================================
 * Owner requirement: "retries cannot create duplicate final purchases." The
 * UNIQUE index on `approval_package_id` is what guarantees it — a second
 * creation attempt cannot insert, whatever this code does, so a double-click,
 * a retried request and two concurrent requests all converge on one purchase.
 *
 * ============================================================================
 * THE CUSTOMER CANNOT MODIFY ANY OF IT
 * ============================================================================
 * Owner requirement, and this function is where it is kept. Everything that
 * decides money or identity comes from the FROZEN package or the authenticated
 * session:
 *
 *   the price          the package, on the basis chosen
 *   the deposit credit the package, which read it from a recorded payment
 *   the customer       the authenticated Shopify customer, compared against
 *                      the project's own `customerRef` by the caller's lookup
 *   the specification  the package
 *
 * The caller passes a payment basis and shipping details. Nothing else about
 * the purchase is theirs to supply.
 *
 * ============================================================================
 * THE EXISTING MONEY SYSTEMS, REUSED
 * ============================================================================
 * Card goes through a Shopify-payable draft order. Bank Payment goes through
 * `bank_payment_order` with its §22 rules intact: the draft carries
 * "Due on receipt" terms so it completes UNPAID, a human verifies the transfer,
 * and no payment state is inferred from the customer's action. There is no
 * second verification path and no second sweep.
 */

export class FinalPurchaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalPurchaseError";
  }
}

export type CreateFinalPurchaseRefusal =
  | "package_not_found"
  /** The customer has not approved this package yet. */
  | "not_approved"
  /** A newer version exists; the approved one is not the current design. */
  | "superseded"
  /** The project is already purchased, or past it. */
  | "project_not_purchasable"
  /** The benefit could not be reserved. Carries the reservation's own refusal. */
  | "benefit_refused";

export type CreateFinalPurchaseResult =
  | { readonly outcome: "created"; readonly purchase: CustomJewelryFinalPurchase }
  /** A retry, a double-click or a concurrent request. The existing purchase, unchanged. */
  | { readonly outcome: "already_created"; readonly purchase: CustomJewelryFinalPurchase }
  | {
      readonly outcome: "refused";
      readonly refusal: CreateFinalPurchaseRefusal;
      readonly detail: string;
      readonly benefitRefusal?: ReserveRefusal;
    };

export interface CreateFinalPurchaseInput {
  readonly approvalPackageId: string;
  /** The AUTHENTICATED Shopify customer. Never a request field. */
  readonly customerRef: string;
  readonly email: string;
  readonly shippingAddress: DraftOrderShippingAddressInput;
  /**
   * Which basis the customer chose. The owner forbade choosing for them, so
   * this is required and has no default.
   */
  readonly paymentBasis: CustomJewelryPaymentBasis;
  /**
   * A Let Us Beat Your Quote benefit code, if the customer is applying one.
   * Reserved through the EXISTING Slice 10 machinery — there is no second
   * redemption engine.
   */
  readonly benefitCode?: string;
  readonly draftOrderPort: DraftOrderPort;
  readonly now: Date;
}

export async function createCustomJewelryFinalPurchase(
  input: CreateFinalPurchaseInput
): Promise<CreateFinalPurchaseResult> {
  const pkg = await prisma.customJewelryApprovalPackage.findFirst({
    // OWNERSHIP AS THE JOIN, same discipline as the approval repository: there
    // is no path that loads a package and compares the customer afterwards.
    where: { id: input.approvalPackageId, project: { customerRef: input.customerRef } },
    include: { project: true, depositPayment: true, finalPurchase: true },
  });
  if (!pkg) {
    return {
      outcome: "refused",
      refusal: "package_not_found",
      detail: "no approval package with that id belongs to this customer",
    };
  }

  // IDEMPOTENT BEFORE ANYTHING ELSE. A retry must not reserve a benefit, call
  // Shopify, or write a second row — and checking first means the common retry
  // costs one query rather than a failed insert.
  if (pkg.finalPurchase) {
    return { outcome: "already_created", purchase: pkg.finalPurchase };
  }

  if (pkg.status === "superseded") {
    return {
      outcome: "refused",
      refusal: "superseded",
      detail: "this version of the design has been replaced; the customer must review the current package",
    };
  }
  if (pkg.status !== "approved") {
    // NOT PURCHASABLE WITHOUT AN APPROVAL. The final-sale term rests on the
    // customer having approved the design; a purchase without one would make
    // that term unenforceable and unfair at the same time.
    return {
      outcome: "refused",
      refusal: "not_approved",
      detail: "the customer has not approved this package",
    };
  }
  if (pkg.project.status === "purchased" || pkg.project.status === "closed") {
    return {
      outcome: "refused",
      refusal: "project_not_purchasable",
      detail: `the project is ${pkg.project.status}`,
    };
  }

  // ---- THE MONEY, RE-DERIVED FROM THE FROZEN FIGURES -------------------
  //
  // Recomputed from the package's own stored prices rather than read straight
  // out of its balance columns, so the arithmetic is checked once more against
  // the same domain function that produced them. If the two ever disagreed —
  // a hand-edited row, a migration mistake — this is where it surfaces, before
  // money moves, rather than in a reconciliation later.
  const money = computeApprovalPackageMoney({
    bankPaymentPrice: Money.fromMinorUnits(pkg.bankPaymentPriceMinorUnits, pkg.currency),
    regularCardPrice: Money.fromMinorUnits(pkg.regularCardPriceMinorUnits, pkg.currency),
    depositPaid: Money.fromMinorUnits(pkg.depositPaidMinorUnits, pkg.currency),
  });
  const expectedBalance =
    input.paymentBasis === "bank_payment"
      ? pkg.bankPaymentBalanceDueMinorUnits
      : pkg.regularCardBalanceDueMinorUnits;
  const recomputedBalance =
    input.paymentBasis === "bank_payment"
      ? money.bankPaymentBalanceDue.amountMinorUnits
      : money.regularCardBalanceDue.amountMinorUnits;
  if (recomputedBalance !== expectedBalance) {
    throw new FinalPurchaseError(
      `approval package ${pkg.id} v${pkg.version} stores a ${input.paymentBasis} balance of ` +
        `${expectedBalance} but its own prices recompute to ${recomputedBalance}; refusing to charge either`
    );
  }

  // ---- THE BENEFIT, THROUGH THE EXISTING MACHINERY ---------------------
  let benefitDiscount = Money.fromMinorUnits(0n, pkg.currency);
  let reservedIntentId: string | null = null;
  if (input.benefitCode) {
    const grossPrice =
      input.paymentBasis === "bank_payment" ? money.bankPaymentPrice : money.regularCardPrice;

    const reservation = await reserveBeatQuoteRedemption({
      benefitCode: input.benefitCode,
      customerRef: input.customerRef,
      // THE CUSTOM JEWELRY SURFACE. Amendment §3 makes the benefit eligible
      // here, and the surface enum has had this member since Slice 10 — the
      // seam was built and tested before the flow existed to use it.
      surface: "custom_jewelry",
      paymentBasis: input.paymentBasis,
      lines: [
        {
          // One line: the piece. Priced at the GROSS approved price on the
          // chosen basis, because the benefit is 10% of the eligible
          // MERCHANDISE subtotal and the deposit credit is not a reduction in
          // what the merchandise costs — it is money the customer already
          // handed over against it. Computing the benefit on the post-credit
          // balance would shrink it by 10% of the deposit, silently.
          reference: `custom_jewelry_approval_package:${pkg.id}`,
          quantity: 1,
          unitPrice: grossPrice,
          // A bespoke piece is neither a Group Buy line nor a Luxury Steal,
          // and the DEPOSIT CREDIT IS NOT A PROMOTION — so this line is
          // eligible merchandise. Stated explicitly because the field is
          // required and has no default: a caller that has not decided cannot
          // compile.
          ineligibleBecause: null,
        },
      ],
      // The deposit credit is the customer's own money returning to them, not
      // a promotional discount — so there is no promotion to stack with. The
      // owner was explicit: "deposit credit is not promotional stacking".
      otherPromotionApplied: false,
      stackingExpresslyAuthorized: false,
      now: input.now,
    });

    if (reservation.outcome === "refused") {
      logger.info("custom_jewelry_purchase.benefit_refused", {
        approvalPackageId: pkg.id,
        refusal: reservation.refusal,
      });
      return {
        outcome: "refused",
        refusal: "benefit_refused",
        detail: reservation.detail ?? `the benefit could not be applied: ${reservation.refusal}`,
        benefitRefusal: reservation.refusal,
      };
    }
    benefitDiscount = Money.fromMinorUnits(
      reservation.intent.discountMinorUnits,
      reservation.intent.currency
    );
    reservedIntentId = reservation.intent.id;
  }

  const amounts = computeFinalPurchaseAmounts({
    money,
    paymentBasis: input.paymentBasis,
    benefitDiscount,
  });

  // ---- THE PAYABLE OBJECT ----------------------------------------------
  const totalCredit = Money.fromMinorUnits(
    amounts.depositCredit.amountMinorUnits + amounts.benefitDiscount.amountMinorUnits,
    pkg.currency
  );
  const title = describePiece(pkg);

  let created;
  try {
    created = await input.draftOrderPort.createCustomJewelryDraftOrder({
      customerGid: input.customerRef,
      email: input.email.toLowerCase(),
      shippingAddress: input.shippingAddress,
      title,
      // THE GROSS PRICE REACHES SHOPIFY. The credits come off as a discount,
      // so the sale is recorded at what the piece actually sold for.
      grossPrice: amounts.grossApprovedPrice,
      totalCredit,
      creditTitle: describeCredit(amounts.depositCredit, amounts.benefitDiscount),
      paymentBasis: input.paymentBasis,
      note:
        `Custom Jewelry ${pkg.project.projectReference}, approval package v${pkg.version} (${pkg.id}). ` +
        `Gross ${amounts.grossApprovedPrice.amountMinorUnits} ${pkg.currency}; deposit credit ` +
        `${amounts.depositCredit.amountMinorUnits}; benefit ${amounts.benefitDiscount.amountMinorUnits}; ` +
        `balance ${amounts.balanceDue.amountMinorUnits}.`,
      tags: [
        "carat-custom-jewelry",
        `carat-project-${pkg.project.projectReference}`,
        `carat-cj-approval-${pkg.id}`,
      ],
    });
  } catch (error) {
    // RELEASE THE BENEFIT. A Shopify failure must not leave the customer's
    // single-use benefit locked against a checkout that does not exist — they
    // have to be able to try again.
    if (reservedIntentId) {
      const released = await releaseBeatQuoteRedemption({
        intentId: reservedIntentId,
        reason: "checkout_failed",
        detail: `custom jewelry draft order creation failed: ${error instanceof Error ? error.message : String(error)}`,
        now: new Date(),
      });
      logger.error("custom_jewelry_purchase.draft_order_failed_benefit_released", {
        approvalPackageId: pkg.id,
        intentId: reservedIntentId,
        released: released.released,
      });
    }
    throw error;
  }

  // ---- THE RECORD ------------------------------------------------------
  try {
    const purchase = await prisma.$transaction(async (tx) => {
      // For Bank Payment, the order and its custom line live in the EXISTING
      // bank payment tables, so the §22 verification path, the amount
      // comparison and the guarantee sweep all apply unchanged.
      let bankPaymentOrderId: string | null = null;
      if (input.paymentBasis === "bank_payment") {
        const bankOrder = await tx.bankPaymentOrder.create({
          data: {
            shopifyDraftOrderGid: created.draftOrderGid,
            customerEmail: input.email.toLowerCase(),
            customerGid: input.customerRef,
            quotedAt: input.now,
            // The §22 window, from the same constant the Buy Now path uses.
            guaranteeExpiresAt: new Date(input.now.getTime() + BANK_GUARANTEE_DURATION_MS),
          },
        });
        await tx.bankPaymentOrderLine.create({
          data: {
            bankPaymentOrderId: bankOrder.id,
            // A CUSTOM LINE: no variant, no engine calculation. Its price
            // comes from the approved package, which the FK records.
            customLineDescription: title,
            customJewelryApprovalPackageId: pkg.id,
            quantity: 1,
            // WHAT IS ACTUALLY COLLECTED. The amount comparison at
            // verification sums these, and what arrives is the balance — so
            // the quoted figure here is the balance, not the gross price.
            quotedBankPaymentPriceMinorUnits: amounts.balanceDue.amountMinorUnits,
            quotedRegularCardPriceMinorUnits: amounts.balanceDue.amountMinorUnits,
            currency: pkg.currency,
            eligibleAtQuoteTime: true,
          },
        });
        bankPaymentOrderId = bankOrder.id;
      }

      return tx.customJewelryFinalPurchase.create({
        data: {
          projectId: pkg.projectId,
          approvalPackageId: pkg.id,
          paymentBasis: input.paymentBasis,
          currency: pkg.currency,
          grossApprovedPriceMinorUnits: amounts.grossApprovedPrice.amountMinorUnits,
          depositCreditMinorUnits: amounts.depositCredit.amountMinorUnits,
          depositPaymentReference: pkg.depositPayment?.orderGid ?? null,
          benefitDiscountMinorUnits: amounts.benefitDiscount.amountMinorUnits,
          balanceDueMinorUnits: amounts.balanceDue.amountMinorUnits,
          ...(bankPaymentOrderId ? { bankPaymentOrderId } : {}),
          // The card path's payable object is the draft order itself.
          ...(input.paymentBasis === "card" ? { shopifyDraftOrderGid: created.draftOrderGid } : {}),
        },
      });
    });

    // Link the benefit reservation to whichever payable object it belongs to,
    // so Slice 10's verification and release paths can find it.
    if (reservedIntentId) {
      if (purchase.bankPaymentOrderId) {
        await attachBankPaymentOrderToRedemption({
          intentId: reservedIntentId,
          bankPaymentOrderId: purchase.bankPaymentOrderId,
        });
      } else {
        await attachRedemptionDraftOrder({
          intentId: reservedIntentId,
          draftOrderGid: created.draftOrderGid,
        });
      }
    }

    // Forward-only and conditional: the project reaches `purchased` from
    // `approved` and is not dragged back from anywhere later.
    await prisma.customJewelryProject.updateMany({
      where: { id: pkg.projectId, status: { in: ["awaiting_approval", "approved"] } },
      data: { status: "purchased" },
    });

    await createAuditEvent({
      entityType: "custom_jewelry_final_purchase",
      entityId: purchase.id,
      action: "created",
      actorType: "customer",
      actorRef: input.customerRef,
      after: {
        projectId: pkg.projectId,
        approvalPackageId: pkg.id,
        approvalPackageVersion: pkg.version,
        paymentBasis: input.paymentBasis,
        grossApprovedPriceMinorUnits: purchase.grossApprovedPriceMinorUnits.toString(),
        depositCreditMinorUnits: purchase.depositCreditMinorUnits.toString(),
        benefitDiscountMinorUnits: purchase.benefitDiscountMinorUnits.toString(),
        balanceDueMinorUnits: purchase.balanceDueMinorUnits.toString(),
        shopifyDraftOrderGid: created.draftOrderGid,
      },
    });

    logger.info("custom_jewelry_purchase.created", {
      purchaseId: purchase.id,
      approvalPackageId: pkg.id,
      paymentBasis: input.paymentBasis,
      balanceDueMinorUnits: purchase.balanceDueMinorUnits.toString(),
    });

    return { outcome: "created", purchase };
  } catch (error) {
    // THE CONCURRENCY BOUNDARY. Two requests both got past the idempotency
    // check and both created a draft order; the UNIQUE index on
    // `approval_package_id` decides which record exists.
    //
    // NOTE WHAT IS NOT CLAIMED HERE: the loser's draft order is now orphaned in
    // Shopify. That is recorded as an anomaly rather than cancelled
    // automatically, because cancelling the WRONG one would destroy the live
    // checkout — and telling the two apart needs the record that just failed
    // to be written.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.customJewelryFinalPurchase.findUnique({
        where: { approvalPackageId: pkg.id },
      });
      if (existing) {
        logger.error("custom_jewelry_purchase.duplicate_draft_order_orphaned", {
          approvalPackageId: pkg.id,
          orphanedDraftOrderGid: created.draftOrderGid,
          keptPurchaseId: existing.id,
        });
        await createAuditEvent({
          entityType: "custom_jewelry_final_purchase",
          entityId: existing.id,
          action: "anomaly",
          actorType: "system",
          actorRef: "job:custom-jewelry-final-purchase",
          reason:
            `a concurrent request created draft order ${created.draftOrderGid} for approval package ` +
            `${pkg.id}, which already has purchase ${existing.id}. That draft order is orphaned and must ` +
            `be cancelled by hand — cancelling automatically risks destroying the live checkout instead.`,
        });
        if (reservedIntentId) {
          await releaseBeatQuoteRedemption({
            intentId: reservedIntentId,
            reason: "superseded",
            detail: `lost the race to create the purchase for approval package ${pkg.id}`,
            now: new Date(),
          });
        }
        return { outcome: "already_created", purchase: existing };
      }
    }
    throw error;
  }
}

/** §22's 24-hour guarantee window, matching the Buy Now Bank Payment path. */
const BANK_GUARANTEE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * What the customer sees as the line's name.
 *
 * NAMES THE APPROVAL VERSION. A custom piece's invoice line is otherwise
 * indistinguishable from any other, and the version is how a later claim about
 * "the approved design" finds the right package.
 */
function describePiece(pkg: CustomJewelryApprovalPackage & { project: { projectReference: string } }): string {
  const parts = [pkg.metalColor, pkg.metalType].filter((part) => part.trim() !== "");
  const material = parts.length > 0 ? `${parts.join(" ")} ` : "";
  return `Custom Jewelry — ${material}(${pkg.project.projectReference}, approved design v${pkg.version})`;
}

/**
 * Names each component of the credit on the invoice.
 *
 * BOTH ARE NAMED WHEN BOTH APPLY. Shopify's `appliedDiscount` is singular, so
 * the two have to be summed into one line — but a customer seeing a single
 * unexplained deduction cannot check it against what they were told. Our own
 * record keeps them in separate columns; this is the customer-facing summary
 * of that record.
 */
function describeCredit(depositCredit: Money, benefitDiscount: Money): string {
  const parts: string[] = [];
  if (depositCredit.amountMinorUnits > 0n) parts.push("Design Deposit credit");
  if (benefitDiscount.amountMinorUnits > 0n) parts.push("Let Us Beat Your Quote benefit");
  // Never empty in practice: the caller sends no discount at all when the
  // total credit is zero. Named defensively so a future caller cannot produce
  // an untitled discount line.
  return parts.length > 0 ? parts.join(" + ") : "Credit";
}
