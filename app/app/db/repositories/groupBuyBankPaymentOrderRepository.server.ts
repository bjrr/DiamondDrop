import type { GroupBuyBankPaymentOrder, GroupBuyBankPaymentOrderLine } from "@prisma/client";

import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { resolveGroupBuyPaymentWindowStart } from "~/domain/bankpayment/groupBuyPaymentWindow";

import { prisma } from "../client.server";

/**
 * Read/reactivation surface for `GroupBuyBankPaymentOrder` (owner §24). The
 * checkout route (`apps.carat.group-buy-bank-checkout.tsx`) and the
 * inactivation sweep
 * (`~/jobs/bankpayment/groupBuyBankPaymentInactivationSweep.server.ts`) are
 * this table's other two writers; this file owns the STAFF-FACING read and
 * reactivation paths only.
 */

export class GroupBuyBankPaymentOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Group Buy Bank Payment order ${id} was not found.`);
    this.name = "GroupBuyBankPaymentOrderNotFoundError";
  }
}

/**
 * Owner §26: "Once the Group Buy closes, automatic reactivation eligibility
 * ends. A customer may still email CaratForUs, and staff may decide
 * case-by-case whether the order can be fulfilled/reactivated." That
 * case-by-case decision is explicitly NOT automated — it is a manual
 * judgement call the owner reserved for staff, made through whatever process
 * they choose, not through this function. This error is what keeps this
 * function from silently becoming that path by accident.
 */
export class GroupBuyBankPaymentOrderCampaignNotOpenError extends Error {
  constructor(id: string, campaignStatus: string) {
    super(
      `Group Buy Bank Payment order ${id}'s campaign is ${campaignStatus}, not open; ` +
        "automatic reactivation is only available while the campaign remains open (owner §24/§26)."
    );
    this.name = "GroupBuyBankPaymentOrderCampaignNotOpenError";
  }
}

export interface GroupBuyBankPaymentOrderDetail extends GroupBuyBankPaymentOrder {
  readonly lines: readonly GroupBuyBankPaymentOrderLine[];
  readonly campaignStatus: string;
  readonly campaignCode: string;
}

async function loadOrderWithCampaign(id: string): Promise<GroupBuyBankPaymentOrderDetail> {
  const order = await prisma.groupBuyBankPaymentOrder.findUnique({
    where: { id },
    include: { lines: true, campaign: { select: { status: true, code: true } } },
  });
  if (!order) throw new GroupBuyBankPaymentOrderNotFoundError(id);
  const { campaign, ...rest } = order;
  return { ...rest, lines: order.lines, campaignStatus: campaign.status, campaignCode: campaign.code };
}

export async function getGroupBuyBankPaymentOrderForStaff(id: string): Promise<GroupBuyBankPaymentOrderDetail> {
  return loadOrderWithCampaign(id);
}

export async function listGroupBuyBankPaymentOrdersForCampaign(
  campaignId: string
): Promise<readonly GroupBuyBankPaymentOrder[]> {
  return prisma.groupBuyBankPaymentOrder.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });
}

export interface ReactivateGroupBuyBankPaymentOrderResult {
  readonly order: GroupBuyBankPaymentOrder;
  /** True when the order was already `active` — a successful idempotent no-op, not an error. */
  readonly alreadyActive: boolean;
}

/**
 * Owner §24: "the customer requests reactivation by email; do not create a
 * replacement order... reactivation preserves the original locked order
 * price." This function does exactly that and nothing more — it never
 * touches a line's quoted price, never recomputes anything from the current
 * tier, and never creates a second Shopify order. It only flips the
 * bookkeeping status back to `active` and resets the payment-window clock
 * (`resolveGroupBuyPaymentWindowStart` — see that function's own doc
 * comment for why `reactivatedAt` then takes priority over `quotedAt`).
 *
 * IDEMPOTENT: reactivating an already-`active` order is a successful no-op,
 * not an error — a staff member re-submitting the same action (a double
 * click, or two support agents acting on the same email) must not be told
 * they broke something, and must not accidentally reset the clock a second
 * time for no reason.
 *
 * REFUSES ONCE THE CAMPAIGN HAS CLOSED (see
 * `GroupBuyBankPaymentOrderCampaignNotOpenError`'s own doc comment) — this
 * is the AUTOMATIC eligibility path only.
 */
export async function reactivateGroupBuyBankPaymentOrder(input: {
  groupBuyBankPaymentOrderId: string;
  /** The authenticated Shopify staff identity — never a typed/free-text name (D23 discipline, same as every other staff-attributed write in this codebase). */
  staffIdentity: string;
  now?: Date;
}): Promise<ReactivateGroupBuyBankPaymentOrderResult> {
  const now = input.now ?? new Date();
  const existing = await loadOrderWithCampaign(input.groupBuyBankPaymentOrderId);

  if (existing.status === "active") {
    return { order: existing, alreadyActive: true };
  }

  if (existing.campaignStatus !== "open") {
    throw new GroupBuyBankPaymentOrderCampaignNotOpenError(existing.id, existing.campaignStatus);
  }

  const previousWindowStart = resolveGroupBuyPaymentWindowStart(existing);

  const order = await prisma.groupBuyBankPaymentOrder.update({
    where: { id: existing.id },
    data: {
      status: "active",
      reactivatedAt: now,
      reactivatedBy: input.staffIdentity,
      reactivationCount: { increment: 1 },
    },
  });

  await createAuditEvent({
    actorType: "staff",
    actorRef: input.staffIdentity,
    action: "groupbuy_bank_payment.reactivated",
    entityType: "group_buy_bank_payment_order",
    entityId: order.id,
    before: { status: existing.status, windowStartedAt: previousWindowStart.toISOString() },
    after: { status: order.status, windowStartedAt: now.toISOString(), reactivationCount: order.reactivationCount },
    reason: "customer-requested reactivation by email (owner §24) — same order, original locked price",
  });

  return { order, alreadyActive: false };
}
