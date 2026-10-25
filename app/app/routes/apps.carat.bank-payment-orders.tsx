import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { groupBuyInitialPaymentDeadline } from "~/domain/bankpayment/groupBuyPaymentWindow";
import { buildPaymentInstructionsView } from "~/domain/bankpayment/paymentInstructionsView";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { resolveBankPaymentCoordinates } from "~/lib/payments/bankPaymentCoordinates.server";
import { minorUnitsToDecimalString } from "~/shopify/admin/priceSyncAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/bank-payment-orders — the signed-in customer's own Bank
 * Payment orders, with payment instructions for the ones still awaiting
 * money (register D12).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Payment instructions used to reach the customer through exactly one
 * channel: an email. An email-provider outage therefore produced a customer
 * holding a real order with no idea where to send funds, and the only trace
 * was a staff log line. This is the durable half of the fix — the
 * confirmation page covers the moment of checkout, this covers every moment
 * after it.
 *
 * ============================================================================
 * AUTHORIZATION IS THE SHOPIFY CUSTOMER IDENTITY. NOTHING ELSE.
 * ============================================================================
 * `logged_in_customer_id` from the SIGNED App Proxy parameters, normalised to
 * a Customer GID, matched exactly against the order's stored `customerGid` —
 * the column whose own schema comment calls it "THE AUTHORIZATION BASIS"
 * (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4/§9).
 *
 * Deliberately NOT accepted as authorization, in any combination:
 *   - an email address;
 *   - an order id or reference on its own;
 *   - a customer id in the query string or body;
 *   - anything else the browser can choose.
 *
 * A signature proves the request came through Shopify's proxy. It does not
 * prove who is asking. Anonymous requests fail closed with 401 and reach no
 * query at all.
 *
 * ============================================================================
 * COORDINATES ARE RESOLVED PER REQUEST AND NEVER PERSISTED
 * ============================================================================
 * `resolveBankPaymentCoordinates()` reads Fly secrets at request time. They
 * are composed into the response by `buildPaymentInstructionsView` and thrown
 * away. Nothing here writes them to a table, a snapshot, an audit event, a
 * Shopify note, or a log — see that module's header.
 *
 * ============================================================================
 * TWO LIFECYCLES, NOT ONE
 * ============================================================================
 * Buy Now and Group Buy are reported separately and shaped differently,
 * because they mean different things. A Buy Now order is a staff-held draft
 * that commits nothing until funds are verified; a Group Buy order is a real
 * unpaid Shopify order that already counts toward the campaign. Collapsing
 * them into one "order" shape would require lying about one of them.
 *
 * INSTRUCTIONS ARE ONLY ATTACHED WHILE PAYMENT IS ACTIONABLE. A paid,
 * cancelled or inactivated order returns its status and no payment
 * destination — telling someone to send money for a cancelled order is worse
 * than telling them nothing.
 */

/** Buy Now: the only state in which money is still wanted. */
const BUY_NOW_PAYABLE: ReadonlySet<string> = new Set(["open"]);
/** Group Buy: `active` is payable; `inactive` is the 96-hour lapse, reactivatable by email while the campaign is open. */
const GROUP_BUY_PAYABLE: ReadonlySet<string> = new Set(["active"]);

/**
 * `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`.
 *
 * Repeated here rather than shared, matching the convention
 * `apps.carat.bank-checkout.tsx` and `apps.carat.rma-intake.tsx` already
 * follow — each authorization boundary states its own normalisation so that
 * reading one route tells you exactly what it trusts.
 */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    // THE PRECISE REASON, AND THE SIGNED SHOP WHEN THERE IS ONE.
    //
    // A shop mismatch and a bad signature are the same 401 to the caller and
    // must stay that way. They are not the same thing to whoever is reading
    // the logs: one is a stray or hostile request, the other means this
    // deployment's SHOPIFY_SHOP_DOMAIN disagrees with what Shopify signs,
    // and every storefront request is failing. Without the reason those are
    // indistinguishable, and the second looks like "nobody is using it".
    //
    // The shop domain is public, not a secret — unlike `signature` and
    // `logged_in_customer_id`, which are never logged (D9).
    logger.warn("bank_payment_orders.proxy_rejected", { reason, signedShop: shop });
    return unauthorized();
  }

  // Fail closed before any query runs. There is no branch of this route an
  // anonymous caller can reach.
  if (!loggedInCustomerId) {
    logger.warn("bank_payment_orders.anonymous_rejected", {});
    return unauthorized();
  }
  const customerGid = normalizeCustomerGid(loggedInCustomerId);

  // Resolved once, used only for orders that are still payable. An
  // unconfigured provider does not break the page: the customer still sees
  // their orders and statuses, just without a destination — which is the
  // honest outcome, and staff see the error.
  const coordinates = resolveBankPaymentCoordinates();
  if (!coordinates.configured) {
    logger.error("bank_payment_orders.payment_coordinates_unconfigured", {
      reason: coordinates.reason,
    });
  }

  const [buyNowOrders, groupBuyOrders] = await Promise.all([
    prisma.bankPaymentOrder.findMany({
      // THE AUTHORIZATION PREDICATE. Scoped by customerGid in the query
      // itself, not filtered afterwards — there is no code path that loads
      // another customer's row into memory.
      where: { customerGid },
      include: { lines: true },
      orderBy: { quotedAt: "desc" },
    }),
    prisma.groupBuyBankPaymentOrder.findMany({
      where: { customerGid },
      include: { lines: true, campaign: { select: { code: true, name: true, status: true } } },
      orderBy: { quotedAt: "desc" },
    }),
  ]);

  const buyNow = buyNowOrders.map((order) => {
    const totalMinorUnits = order.lines.reduce(
      (sum, line) => sum + line.quotedBankPaymentPriceMinorUnits * BigInt(line.quantity),
      0n
    );
    const currency = order.lines[0]?.currency ?? "USD";
    const payable = BUY_NOW_PAYABLE.has(order.status) && coordinates.configured;

    return {
      reference: order.id,
      status: order.status,
      formattedAmountDue: minorUnitsToDecimalString(totalMinorUnits),
      currency,
      quotedAt: order.quotedAt.toISOString(),
      guaranteeExpiresAt: order.guaranteeExpiresAt.toISOString(),
      instructions: payable
        ? buildPaymentInstructionsView({
            flow: "buy_now",
            reference: order.id,
            formattedAmountDue: minorUnitsToDecimalString(totalMinorUnits),
            currency,
            paymentDeadline: order.guaranteeExpiresAt,
            coordinates: coordinates.coordinates,
          })
        : null,
    };
  });

  const groupBuy = groupBuyOrders.map((order) => {
    const totalMinorUnits = order.lines.reduce(
      (sum, line) => sum + line.quotedBankPaymentPriceMinorUnits * BigInt(line.quantity),
      0n
    );
    const currency = order.lines[0]?.currency ?? "USD";
    const payable = GROUP_BUY_PAYABLE.has(order.status) && coordinates.configured;
    // The INITIAL 48-hour deadline, derived by the same function the email
    // and the checkout use — never recomputed here.
    const paymentDeadline = groupBuyInitialPaymentDeadline(order.quotedAt);

    return {
      reference: order.id,
      status: order.status,
      campaignCode: order.campaign.code,
      campaignName: order.campaign.name,
      campaignStatus: order.campaign.status,
      tierNumberAtQuote: order.tierNumberAtQuote,
      formattedAmountDue: minorUnitsToDecimalString(totalMinorUnits),
      currency,
      quotedAt: order.quotedAt.toISOString(),
      paymentDeadline: paymentDeadline.toISOString(),
      /** Set once the automatic extension has been consumed, so the page can say so rather than guess. */
      inactivatedAt: order.inactivatedAt ? order.inactivatedAt.toISOString() : null,
      reactivatedAt: order.reactivatedAt ? order.reactivatedAt.toISOString() : null,
      instructions: payable
        ? buildPaymentInstructionsView({
            flow: "group_buy",
            reference: order.id,
            formattedAmountDue: minorUnitsToDecimalString(totalMinorUnits),
            currency,
            paymentDeadline,
            coordinates: coordinates.coordinates,
          })
        : null,
    };
  });

  logger.info("bank_payment_orders.listed", {
    buyNowCount: buyNow.length,
    groupBuyCount: groupBuy.length,
  });

  return Response.json(
    { buyNow, groupBuy, coordinatesAvailable: coordinates.configured },
    {
      headers: {
        // PRIVATE AND UNCACHEABLE. This body is scoped to one customer and
        // carries payment destinations; a shared cache would be a disclosure.
        "Cache-Control": "no-store",
      },
    }
  );
}
