import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";

import { listUnmatchedLuxuryStealOrderChecks } from "~/db/repositories/luxuryStealRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/luxury-steals/held-orders — the durable, pull-based surface for
 * criterion 138's "held for staff review" state (Slice 3 task 3-2b,
 * docs/specs/SLICE-3-LUXURY-STEALS.md).
 *
 * LOADER ONLY, deliberately — no `action`, so this route needs no entry in
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES` (same
 * reasoning as `app.bank-payments._index.tsx`'s own header comment).
 *
 * WHY THIS PAGE EXISTS SEPARATELY FROM AN EMAIL ALERT. Task 3-4 sends a
 * best-effort email when a line is held; an email that bounces, lands in
 * spam, or is simply never read must not mean the hold becomes invisible.
 * This page queries `luxury_steal_order_check` directly for every
 * `unmatched` row — the same append-only table task 3-4 writes to — so a
 * staff member can find every held order without depending on a
 * notification having arrived at all.
 *
 * NO RELEASE/APPROVE ACTION HERE, ON PURPOSE. Releasing a hold is a decision
 * with policy consequences (does the order ship as-is? does someone contact
 * the customer for a fresh acknowledgment? is it cancelled?) that the owner
 * has not specified for this slice. Building a button here would be
 * inventing that policy rather than implementing it. This page surfaces and
 * records only — see this task's handoff for what a future slice needs to
 * decide before a release action can be added.
 *
 * NEVER EXPOSES supplier cost, margin or internal pricing data (CLAUDE.md
 * rule 10) — only order/line/variant references and when each was checked.
 */

export interface HeldCheckView {
  readonly id: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly variantRef: string;
  readonly checkedAt: string;
}

interface LoaderData {
  apiKey: string;
  shop: string;
  held: HeldCheckView[];
  loadError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  let held: HeldCheckView[] = [];
  let loadError: string | null = null;
  try {
    const rows = await listUnmatchedLuxuryStealOrderChecks();
    held = rows.map((row) => ({
      id: row.id,
      orderRef: row.orderRef,
      lineRef: row.lineRef,
      variantRef: row.variantRef,
      checkedAt: row.checkedAt.toISOString(),
    }));
  } catch (error) {
    // A failed read must not blank the page — same discipline as
    // app.bank-payments._index.tsx's loadError handling.
    loadError = error instanceof Error ? error.message : "Failed to load held Luxury Steal orders.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    held,
    loadError,
  } satisfies LoaderData;
}

function formatTimestamp(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default function LuxuryStealsHeldOrdersPage() {
  const { apiKey, shop, held, loadError } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/luxury-steals">&larr; Back to Luxury Steal assignment</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Held Luxury Steal orders</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Every line below matched no stored Final Sale acknowledgment at
          the order boundary (criterion 138) and is held for staff review — never silently fulfilled, never
          auto-cancelled. This list does not depend on the notification email having arrived; it reads the
          same evidence table the order-time check writes to.
        </p>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not load held Luxury Steal orders: {loadError}
          </p>
        ) : held.length === 0 ? (
          <p style={{ color: "#555" }}>No held orders — every checked Luxury Steal line has matched.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
            <caption style={{ textAlign: "left", captionSide: "top", margin: "0 0 0.5rem", color: "#777" }}>
              {held.length} held line{held.length === 1 ? "" : "s"}, most recently checked first
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Order
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Line
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Variant
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Checked at
                </th>
              </tr>
            </thead>
            <tbody>
              {held.map((row) => (
                <tr key={row.id}>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <code>{row.orderRef}</code>
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <code>{row.lineRef}</code>
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <code>{row.variantRef}</code>
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <time dateTime={row.checkedAt}>{formatTimestamp(row.checkedAt)}</time>
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
