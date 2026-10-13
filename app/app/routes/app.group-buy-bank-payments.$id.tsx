import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  GroupBuyBankPaymentOrderCampaignNotOpenError,
  GroupBuyBankPaymentOrderNotFoundError,
  getGroupBuyBankPaymentOrderForStaff,
  reactivateGroupBuyBankPaymentOrder,
} from "~/db/repositories/groupBuyBankPaymentOrderRepository.server";
import { groupBuyPaymentWindowDeadline, resolveGroupBuyPaymentWindowStart } from "~/domain/bankpayment/groupBuyPaymentWindow";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/group-buy-bank-payments/:id — Group Buy Bank Payment order
 * detail and staff reactivation (owner §24: "the customer requests
 * reactivation by email; do not create a replacement order... reactivation
 * preserves the original locked order price").
 *
 * LAUNCH-MINIMUM, matching `app.bank-payments.$id.tsx`'s own scope
 * discipline: shows the order and its lines, and exposes exactly one
 * action — reactivate an `inactive` order while its campaign remains open.
 * NOT built here: a campaign-wide listing view (owned by whichever surface
 * builds Group Buy campaign administration —
 * `app.group-buy-campaigns.$id.tsx`), settlement/refund actions, and
 * post-close manual reactivation (owner §26 — an explicit, non-automated,
 * case-by-case staff decision, deliberately not exposed as a button here;
 * see `GroupBuyBankPaymentOrderCampaignNotOpenError`'s own doc comment).
 *
 * A DEFAULT EXPORT WITH AN ACTION — same argument as
 * `app.bank-payments.$id.tsx` in `csrfResourceRouteFence.test.ts`'s
 * `EXEMPT_UI_ACTION_ROUTES`: this route IS a real production mutation
 * (reactivates an order), and stands on the same load-bearing leg alone —
 * Shopify Admin iframes this route at the app's own URL, so a form inside it
 * posts with the app's own Origin and is same-origin by construction, unlike
 * an App Proxy, webhook or cron caller.
 *
 * REACTIVATION IS ATTRIBUTED TO THE AUTHENTICATED SHOPIFY STAFF IDENTITY
 * (D23), never a typed name — identical discipline to every other
 * staff-attributed write in this codebase.
 */

interface LineViewModel {
  readonly id: string;
  readonly masterVariantId: string;
  readonly quantity: number;
  readonly quotedBankPaymentPriceMinorUnits: string;
  readonly quotedRegularCardPriceMinorUnits: string;
  readonly currency: string;
}

interface OrderViewModel {
  readonly id: string;
  readonly campaignCode: string;
  readonly campaignStatus: string;
  readonly status: string;
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string;
  readonly tierNumberAtQuote: number;
  readonly quotedAt: string;
  readonly windowDeadline: string;
  readonly inactivatedAt: string | null;
  readonly reactivatedAt: string | null;
  readonly reactivatedBy: string | null;
  readonly reactivationCount: number;
  readonly canReactivate: boolean;
  readonly lines: readonly LineViewModel[];
}

interface LoaderData {
  apiKey: string;
  shop: string;
  order: OrderViewModel | null;
}

function buildOrderViewModel(
  order: Awaited<ReturnType<typeof getGroupBuyBankPaymentOrderForStaff>>
): OrderViewModel {
  const windowStart = resolveGroupBuyPaymentWindowStart(order);
  return {
    id: order.id,
    campaignCode: order.campaignCode,
    campaignStatus: order.campaignStatus,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    tierNumberAtQuote: order.tierNumberAtQuote,
    quotedAt: order.quotedAt.toISOString(),
    windowDeadline: groupBuyPaymentWindowDeadline(windowStart).toISOString(),
    inactivatedAt: order.inactivatedAt?.toISOString() ?? null,
    reactivatedAt: order.reactivatedAt?.toISOString() ?? null,
    reactivatedBy: order.reactivatedBy,
    reactivationCount: order.reactivationCount,
    canReactivate: order.status === "inactive" && order.campaignStatus === "open",
    lines: order.lines.map((line) => ({
      id: line.id,
      masterVariantId: line.masterVariantId,
      quantity: line.quantity,
      quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits.toString(),
      quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits.toString(),
      currency: line.currency,
    })),
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing Group Buy Bank Payment order id.", { status: 400 });

  try {
    const order = await getGroupBuyBankPaymentOrderForStaff(id);
    return {
      apiKey: getEnv().SHOPIFY_API_KEY ?? "",
      shop: session.shop,
      order: buildOrderViewModel(order),
    } satisfies LoaderData;
  } catch (error) {
    if (error instanceof GroupBuyBankPaymentOrderNotFoundError) {
      return { apiKey: getEnv().SHOPIFY_API_KEY ?? "", shop: session.shop, order: null } satisfies LoaderData;
    }
    throw error;
  }
}

interface ActionData {
  ok: boolean;
  formError: string | null;
}

/** Resolves the AUTHENTICATED Shopify staff identity (D23), or null — never defaulted. */
function resolveStaffIdentity(
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"]
): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return associatedUser.email;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) {
    return Response.json({ ok: false, formError: "Missing Group Buy Bank Payment order id." }, { status: 400 });
  }
  if (request.method !== "POST") {
    return Response.json({ ok: false, formError: "Method not allowed." }, { status: 405 });
  }

  const staffIdentity = resolveStaffIdentity(session);
  if (!staffIdentity) {
    logger.error("group_buy_bank_payments.no_online_user", { groupBuyBankPaymentOrderId: id });
    return Response.json(
      {
        ok: false,
        formError:
          "This request could not be attributed to a signed-in Shopify staff member (no online session). " +
          "Reload the page and try again.",
      },
      { status: 401 }
    );
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "reactivate") {
    return Response.json({ ok: false, formError: "Unknown action." }, { status: 400 });
  }

  try {
    await reactivateGroupBuyBankPaymentOrder({ groupBuyBankPaymentOrderId: id, staffIdentity });
    return Response.json({ ok: true, formError: null } satisfies ActionData);
  } catch (error) {
    if (error instanceof GroupBuyBankPaymentOrderNotFoundError) {
      return Response.json({ ok: false, formError: error.message }, { status: 404 });
    }
    if (error instanceof GroupBuyBankPaymentOrderCampaignNotOpenError) {
      return Response.json({ ok: false, formError: error.message }, { status: 400 });
    }
    throw error;
  }
}

export default function GroupBuyBankPaymentDetailPage() {
  const { apiKey, shop, order } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "48rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/group-buy-campaigns">&larr; Back to Group Buy campaigns</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Group Buy Bank Payment order</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!order ? (
          <p role="alert" style={{ color: "#b00" }}>
            That Group Buy Bank Payment order was not found.
          </p>
        ) : (
          <>
            {actionData?.formError ? (
              <p role="alert" style={{ color: "#b00" }}>
                {actionData.formError}
              </p>
            ) : null}
            {actionData?.ok ? <p style={{ color: "#080" }}>Order reactivated.</p> : null}

            <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Order</h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Order reference: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <code>{order.id}</code>
                  </dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Campaign: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    {order.campaignCode} ({order.campaignStatus})
                  </dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Customer email: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.customerEmail}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Status: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.status}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Tier locked at placement: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.tierNumberAtQuote}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Quoted at: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.quotedAt}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Payment window deadline: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.windowDeadline}</dd>
                </div>
                {order.inactivatedAt ? (
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Inactivated at: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{order.inactivatedAt}</dd>
                  </div>
                ) : null}
                {order.reactivatedAt ? (
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Last reactivated at: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      {order.reactivatedAt} by {order.reactivatedBy} (x{order.reactivationCount})
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Shopify draft order: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <code>{order.shopifyDraftOrderGid}</code>
                  </dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Shopify order: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <code>{order.shopifyOrderGid}</code>
                  </dd>
                </div>
              </dl>
            </section>

            <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Lines</h2>
              <table style={{ width: "100%", fontSize: "0.875rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.25rem" }}>Variant</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "0.25rem" }}>Qty</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "0.25rem" }}>
                      Bank price (charged)
                    </th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "0.25rem" }}>
                      Card price (reference)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td style={{ padding: "0.25rem" }}>
                        <code>{line.masterVariantId}</code>
                      </td>
                      <td style={{ textAlign: "right", padding: "0.25rem" }}>{line.quantity}</td>
                      <td style={{ textAlign: "right", padding: "0.25rem" }}>
                        {line.quotedBankPaymentPriceMinorUnits} {line.currency}
                      </td>
                      <td style={{ textAlign: "right", padding: "0.25rem" }}>
                        {line.quotedRegularCardPriceMinorUnits} {line.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {order.canReactivate ? (
              <Form method="post">
                <input type="hidden" name="intent" value="reactivate" />
                <button type="submit" disabled={busy}>
                  Reactivate (same order, original locked price)
                </button>
              </Form>
            ) : order.status === "inactive" ? (
              <p style={{ color: "#555" }}>
                This order is inactive and its campaign is no longer open — automatic reactivation is unavailable
                (owner §26). Contact the customer and decide manually if this order can still be fulfilled.
              </p>
            ) : null}
          </>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
