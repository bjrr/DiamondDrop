import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import {
  hasGroupBuyPaymentWindowElapsed,
  resolveGroupBuyPaymentWindowStart,
} from "~/domain/bankpayment/groupBuyPaymentWindow";
import { logger } from "~/lib/logger.server";

/**
 * The Group Buy Bank Payment 48h+48h payment-window sweep (owner §24:
 * "after 96 hours unpaid, the order may be marked internally
 * inactive/canceled for nonpayment").
 *
 * WHY THIS IS A SEPARATE, SMALLER SWEEP FROM BUY NOW'S GUARANTEE SWEEP
 * (`~/jobs/bankpayment/guaranteeSweep.server.ts`), NOT A REUSE OF IT.
 * Buy Now's sweep answers a genuinely different question — "has the
 * PUBLISHED PRICE moved since this order was quoted" — against a fixed
 * 24-hour clock, and its action is a TERMINAL cancellation with a
 * customer-facing email. A Group Buy Bank Payment order's price never moves
 * (it is locked forever at placement — owner §21/§24) and is never
 * cancelled for a price reason at all; this sweep answers only "has the
 * 96-hour payment window elapsed", and its action is a NON-terminal,
 * INTERNAL status flip that a later staff reactivation can undo (Buy Now's
 * cancellation cannot be undone). Sharing one sweep between two unrelated
 * decisions — one price-driven and terminal, one time-driven and
 * reversible — would mean bending one or the other's shape to fit a
 * question it does not ask. The two things they legitimately share (reading
 * a table, marking rows, logging structured summaries) are a few lines each
 * and not worth coupling two otherwise-independent state machines over.
 *
 * IDEMPOTENT UNDER CONCURRENT/OVERLAPPING RUNS, same pattern as the
 * guarantee sweep and `completeBankPaymentOrder`: inactivation is an
 * `updateMany` GUARDED on `status: "active"` still being true at the moment
 * of the write, never a blind `update` by id. A losing concurrent caller's
 * `count === 0` is a successful idempotent no-op.
 *
 * NEVER INACTIVATES ON ITS OWN FAILURE. Each order is processed inside its
 * own try/catch; a thrown error leaves that order untouched — still
 * `active` — rather than either inactivating defensively or aborting the
 * whole sweep and leaving every OTHER order unevaluated until the next run.
 *
 * NO CUSTOMER EMAIL. Unlike Buy Now's guarantee-expiry cancellation, owner
 * §24 does not call for notifying the customer when an order goes
 * `inactive` — it remains fully payable and fully reactivatable, and no
 * owner-approved copy for such a notice exists. Inventing one is out of
 * scope here (same discipline the checkout route's own module comment
 * documents for the "not committed" disclosure).
 */

export interface GroupBuyBankPaymentInactivationSweepSummary {
  /** ISO-8601 — the instant this sweep evaluated against. */
  now: string;
  ordersConsidered: number;
  inactivated: number;
  kept: number;
  errored: number;
}

export interface GroupBuyBankPaymentInactivationSweepDeps {
  /** Defaults to `new Date()`. Injectable so the 96-hour boundary can be tested exactly. */
  now?: Date;
}

interface ActiveOrderForSweep {
  id: string;
  quotedAt: Date;
  reactivatedAt: Date | null;
}

export async function runGroupBuyBankPaymentInactivationSweep(
  deps: GroupBuyBankPaymentInactivationSweepDeps = {}
): Promise<GroupBuyBankPaymentInactivationSweepSummary> {
  const now = deps.now ?? new Date();

  const activeOrders: ActiveOrderForSweep[] = await prisma.groupBuyBankPaymentOrder.findMany({
    where: { status: "active" },
    select: { id: true, quotedAt: true, reactivatedAt: true },
  });

  let inactivated = 0;
  let kept = 0;
  let errored = 0;

  for (const order of activeOrders) {
    try {
      const windowStart = resolveGroupBuyPaymentWindowStart(order);
      if (!hasGroupBuyPaymentWindowElapsed(windowStart, now)) {
        kept += 1;
        continue;
      }

      const claimed = await prisma.groupBuyBankPaymentOrder.updateMany({
        where: { id: order.id, status: "active" },
        data: { status: "inactive", inactivatedAt: now },
      });

      if (claimed.count === 0) {
        // Lost the race to a concurrent sweep run, or a staff reactivation
        // landed in the interim — either way this is a successful
        // idempotent no-op, not an error.
        logger.info("group_buy_bank_payment.inactivation_already_resolved", { groupBuyBankPaymentOrderId: order.id });
        inactivated += 1;
        continue;
      }

      await createAuditEvent({
        actorType: "system",
        actorRef: "group-buy-bank-payment-inactivation-sweep",
        action: "groupbuy_bank_payment.inactivated",
        entityType: "group_buy_bank_payment_order",
        entityId: order.id,
        before: { status: "active", windowStartedAt: windowStart.toISOString() },
        after: { status: "inactive", inactivatedAt: now.toISOString() },
        reason: "96-hour Bank Payment window (48h initial + 48h automatic extension) elapsed unpaid (owner §24)",
      });

      logger.warn("group_buy_bank_payment.inactivated", { groupBuyBankPaymentOrderId: order.id });
      inactivated += 1;
    } catch (error) {
      errored += 1;
      logger.error("group_buy_bank_payment.inactivation_sweep_order_errored", {
        groupBuyBankPaymentOrderId: order.id,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      // Left untouched — still active — see the module comment.
    }
  }

  logger.info("group_buy_bank_payment.inactivation_sweep_completed", {
    ordersConsidered: activeOrders.length,
    inactivated,
    kept,
    errored,
  });

  return { now: now.toISOString(), ordersConsidered: activeOrders.length, inactivated, kept, errored };
}
