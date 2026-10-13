import { prisma } from "~/db/client.server";
import type { DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Turns a VERIFIED Bank Payment order into a real Shopify order and records
 * which order it became (spec §5.4, criteria 87-89).
 *
 * This is the smallest piece that makes `bank_payment_order.shopify_order_gid`
 * actually get written. The admin surface that calls it — the verification
 * workflow proper, with its sold-out re-check (criterion 103) and its remedy
 * choices — is 2C-c and is NOT built here.
 *
 * WHY IT REFUSES AN UNVERIFIED ORDER. §22 is that nothing is committed until
 * Bank Payment has been received and verified by hand. Completion is the
 * commitment: it creates a real order against real inventory. A function that
 * would complete an unverified order is a way for that rule to be broken by a
 * caller who simply forgot, so the refusal lives here rather than in whatever
 * UI eventually calls it.
 *
 * WHAT IT DOES NOT DO. It never asserts a payment. `draftOrderComplete` is
 * called with the draft id alone, so the resulting order is UNPAID —
 * `displayFinancialStatus: PENDING` — which is correct: the money arrived by
 * bank transfer outside Shopify, and Shopify should not claim to have
 * processed it. The verification record on our side is the evidence that it
 * arrived.
 */

export class BankPaymentOrderNotVerifiedError extends Error {
  constructor(bankPaymentOrderId: string) {
    super(
      `bank payment order ${bankPaymentOrderId} has no verified payment; ` +
        "§22 forbids completing an order before payment is received and verified"
    );
    this.name = "BankPaymentOrderNotVerifiedError";
  }
}

export class BankPaymentOrderNotOpenError extends Error {
  constructor(bankPaymentOrderId: string, status: string) {
    super(`bank payment order ${bankPaymentOrderId} is ${status}, not open`);
    this.name = "BankPaymentOrderNotOpenError";
  }
}

export interface CompleteBankPaymentOrderResult {
  readonly shopifyOrderGid: string;
  readonly orderName: string | null;
  /** True when this call found the order already completed and did nothing. */
  readonly alreadyCompleted: boolean;
}

export async function completeBankPaymentOrder(input: {
  bankPaymentOrderId: string;
  port: DraftOrderPort;
}): Promise<CompleteBankPaymentOrderResult> {
  const order = await prisma.bankPaymentOrder.findUniqueOrThrow({
    where: { id: input.bankPaymentOrderId },
  });

  /**
   * IDEMPOTENCE IS CHECKED BEFORE ANYTHING ELSE, and it is checked against the
   * stored gid rather than against the status alone. A second call must not
   * reach Shopify: `draftOrderComplete` on an already-completed draft is not a
   * harmless repeat, and a duplicate real order against real inventory is the
   * worst outcome this function can produce.
   */
  if (order.shopifyOrderGid) {
    return { shopifyOrderGid: order.shopifyOrderGid, orderName: null, alreadyCompleted: true };
  }
  if (order.status !== "open") {
    throw new BankPaymentOrderNotOpenError(order.id, order.status);
  }
  if (!order.verifiedAt) {
    throw new BankPaymentOrderNotVerifiedError(order.id);
  }

  const completed = await input.port.completeDraftOrder({
    draftOrderGid: order.shopifyDraftOrderGid,
  });

  /**
   * The gid is written under a guard on `shopify_order_gid` still being NULL,
   * so two callers racing past the read above cannot both claim the write.
   * `count === 0` means somebody else got there first — which is a successful
   * outcome for an idempotent operation, not an error, so the stored value is
   * returned rather than this call's.
   */
  const written = await prisma.bankPaymentOrder.updateMany({
    where: { id: order.id, shopifyOrderGid: null },
    data: {
      shopifyOrderGid: completed.orderGid,
      completedAt: new Date(),
      status: "completed",
    },
  });

  if (written.count === 0) {
    const current = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    return {
      shopifyOrderGid: current.shopifyOrderGid!,
      orderName: null,
      alreadyCompleted: true,
    };
  }

  return { shopifyOrderGid: completed.orderGid, orderName: completed.orderName, alreadyCompleted: false };
}
