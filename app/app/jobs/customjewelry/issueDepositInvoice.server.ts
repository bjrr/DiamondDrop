import {
  getCustomJewelryProjectForDepositInvoice,
  recordCustomJewelryDepositInvoice,
} from "~/db/repositories/customJewelryProjectRepository.server";
import {
  depositInvoiceLineTitle,
  depositInvoiceTags,
  resolveDepositInvoiceAmount,
} from "~/domain/customjewelry/depositInvoice";
import { logger } from "~/lib/logger.server";
import type { DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Issues the $49 Design Deposit invoice for a Custom Jewelry project.
 *
 * ============================================================================
 * THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY
 * ============================================================================
 *   1. the project exists
 *   2. the customer ACCEPTED the deposit terms        <- refuses without this
 *   3. the amount still matches what they authorized  <- refuses on drift
 *   4. no invoice has already gone out                <- refuses on repeat
 *   5. create the Shopify draft order
 *   6. record it
 *
 * Steps 2–4 all happen BEFORE anything is created in Shopify, so a refusal
 * leaves nothing behind to clean up. The database enforces 2 and 4
 * independently (a NOT NULL FK to the acceptance, and a UNIQUE index on it),
 * so this function being wrong cannot produce an invoice without an
 * acceptance or a second invoice for one deposit — these checks exist to
 * produce a good error, not to be the guarantee.
 *
 * ============================================================================
 * THE ONE ORDERING HAZARD THAT REMAINS, STATED PLAINLY
 * ============================================================================
 * Step 5 happens before step 6, so a crash between them leaves a Shopify
 * draft order with no local record. That is the correct way round: the
 * reverse would record an invoice that does not exist, and a customer would
 * be told to pay something they were never sent.
 *
 * An orphaned DRAFT order is recoverable and harmless — it is unpaid, has no
 * invoice email attached (this function does not send one; see below), and
 * carries the project reference in its tags, so it can be found and either
 * deleted or reconciled. It is a mess, not a loss.
 *
 * ============================================================================
 * THIS DOES NOT SEND THE INVOICE EMAIL
 * ============================================================================
 * Creating the draft order and asking the customer for money are separate
 * acts. Shopify's `draftOrderInvoiceSend` is a real customer-facing email
 * whose wording is partly ours (`customMessage`), and that copy has not been
 * approved. Until it is, staff send the invoice from the Shopify admin, where
 * they can see exactly what goes out.
 *
 * An automated send would also make the crash window above worse: the
 * customer would have been asked for money by a run that then failed to
 * record anything.
 */

export type IssueDepositInvoiceResult =
  | { readonly outcome: "issued"; readonly draftOrderGid: string; readonly invoiceUrl: string | null }
  | { readonly outcome: "already_issued"; readonly draftOrderGid: string }
  | { readonly outcome: "project_not_found" }
  | { readonly outcome: "not_accepted" }
  | { readonly outcome: "amount_mismatch"; readonly detail: string };

export interface IssueDepositInvoiceInput {
  readonly projectId: string;
  /** The staff actor, for the evidence record. */
  readonly issuedByActorRef: string;
  readonly draftOrders: DraftOrderPort;
}

export async function issueCustomJewelryDepositInvoice(
  input: IssueDepositInvoiceInput
): Promise<IssueDepositInvoiceResult> {
  const project = await getCustomJewelryProjectForDepositInvoice(input.projectId);
  if (!project) return { outcome: "project_not_found" };

  const acceptance = project.depositAcceptance;
  if (!acceptance) {
    // THE GATE. The customer has not agreed to the four disclosures, so they
    // cannot be asked for money.
    logger.warn("custom_jewelry_deposit_invoice.refused_no_acceptance", {
      projectReference: project.projectReference,
    });
    return { outcome: "not_accepted" };
  }

  if (acceptance.invoice) {
    // Not an error — the deposit already has a live payment link, and issuing
    // a second would let the customer pay twice. Answered with what exists.
    return { outcome: "already_issued", draftOrderGid: acceptance.invoice.draftOrderGid };
  }

  let amount;
  try {
    // FROM THE ACCEPTANCE, checked against today's price. See
    // `resolveDepositInvoiceAmount` for why those are different questions.
    amount = resolveDepositInvoiceAmount({
      amountMinorUnits: acceptance.amountMinorUnits,
      currency: acceptance.currency,
    });
  } catch (error) {
    logger.error("custom_jewelry_deposit_invoice.amount_mismatch", {
      projectReference: project.projectReference,
    });
    return { outcome: "amount_mismatch", detail: error instanceof Error ? error.message : "unknown" };
  }

  // The acceptance's customerRef, NOT the project's. They are the same today
  // — the acceptance route requires the project to belong to the caller — but
  // the acceptance is the record of who authorized this specific charge, and
  // that is the identity the money should be attached to.
  const created = await input.draftOrders.createServiceDraftOrder({
    customerGid: acceptance.customerRef,
    email: project.email,
    title: depositInvoiceLineTitle(project.projectReference),
    unitPrice: amount,
    note: `Custom Jewelry Design Deposit for ${project.projectReference}`,
    tags: depositInvoiceTags(project.projectReference),
  });

  await recordCustomJewelryDepositInvoice({
    acceptanceId: acceptance.id,
    draftOrderGid: created.draftOrderGid,
    amountMinorUnits: acceptance.amountMinorUnits,
    currency: acceptance.currency,
    issuedByActorRef: input.issuedByActorRef,
  });

  logger.info("custom_jewelry_deposit_invoice.issued", {
    projectReference: project.projectReference,
    draftOrderGid: created.draftOrderGid,
  });

  return { outcome: "issued", draftOrderGid: created.draftOrderGid, invoiceUrl: created.invoiceUrl };
}
