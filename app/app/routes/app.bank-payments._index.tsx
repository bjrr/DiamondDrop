import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";
import {
  searchBankPaymentOrders,
  type BankPaymentOrderSummary,
} from "~/domain/bankpayment/verification.server";

/**
 * GET /app/bank-payments — locating a Bank Payment order (Slice 2C phase
 * 2C-c, `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §5.4/§14, owner §23).
 *
 * "Authorised staff must be able to locate a Bank Payment order" is the
 * whole job of this page. A blank search lists every currently OPEN order —
 * the ones still needing a verification decision — because that is the
 * queue a staff member actually works from; a non-blank query matches
 * whichever identifier they have to hand (customer email, the Shopify draft
 * -order gid, the completed Shopify order gid, or this app's own order id).
 * See `searchBankPaymentOrders` for the exact match rule.
 *
 * LOADER ONLY, deliberately — same reasoning as `alerts.tsx`: this route has
 * no `action`, so it needs no entry in csrfResourceRouteFence.test.ts's
 * EXEMPT_UI_ACTION_ROUTES. The verification decision itself (the mutating
 * part) lives on `app.bank-payments.$id.tsx`, which does need that entry.
 *
 * NEVER SHOWS cost, margin, landed cost, pricing profile or uplift — only
 * what identifies an order and where it stands (contract mirrors
 * `alerts.tsx`'s own C-S5 discipline).
 */

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  orders: BankPaymentOrderSummary[];
  loadError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";

  let orders: BankPaymentOrderSummary[] = [];
  let loadError: string | null = null;
  try {
    orders = await searchBankPaymentOrders(query);
  } catch (error) {
    // A failed search must not blank the page — same discipline as
    // alerts.tsx's readError handling.
    loadError = error instanceof Error ? error.message : "Failed to search Bank Payment orders.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    query,
    orders,
    loadError,
  } satisfies LoaderData;
}

function statusLabel(status: BankPaymentOrderSummary["status"]): string {
  switch (status) {
    case "open":
      return "Open — awaiting verification";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Deterministic, locale-independent timestamp text — see alerts.tsx's identical helper and its own reasoning (toLocaleString varies by runtime ICU data). */
function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export default function BankPaymentsListPage() {
  const { apiKey, shop, query, orders, loadError } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Bank Payment orders</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Locate a Bank Payment order to record a verified
          payment or review one already verified.
        </p>

        <Form method="get" role="search" style={{ margin: "0 0 1.5rem", display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <div>
            <label htmlFor="q" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Search by customer email, draft order id, order id, or Bank Payment order id
            </label>
            <input
              id="q"
              name="q"
              type="text"
              defaultValue={query}
              style={{ padding: "0.4rem 0.6rem", minWidth: "22rem" }}
              placeholder="e.g. customer@example.com"
            />
          </div>
          <button type="submit">Search</button>
          {query ? (
            <Link to="/app/bank-payments" style={{ marginLeft: "0.5rem" }}>
              Clear — show open orders
            </Link>
          ) : null}
        </Form>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not search Bank Payment orders: {loadError}
          </p>
        ) : orders.length === 0 ? (
          <p style={{ color: "#555" }}>
            {query ? `No Bank Payment order matched "${query}".` : "No open Bank Payment orders — every order is verified or cancelled."}
          </p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
            <caption style={{ textAlign: "left", captionSide: "top", margin: "0 0 0.5rem", color: "#777" }}>
              {query ? `Results for "${query}"` : "Open orders, newest first"}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Customer email
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Status
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Quoted at
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Verified
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{order.customerEmail}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{statusLabel(order.status)}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <time dateTime={order.quotedAt.toISOString()}>{formatTimestamp(order.quotedAt)}</time>
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{order.verifiedAt ? "Yes" : "Not yet"}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <Link to={`/app/bank-payments/${order.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
