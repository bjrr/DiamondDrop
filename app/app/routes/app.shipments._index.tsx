import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import { searchShipmentsForStaff, type ShipmentStaffListRow } from "~/db/repositories/shipmentRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/shipments — staff shipment-evidence triage/search surface
 * (Slice 11 admin surface, docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md).
 *
 * Reads through `searchShipmentsForStaff`, the same convention every other
 * admin list route in this codebase follows (`app.warranty-claims._index.tsx`
 * via `searchWarrantyClaimsForStaff`, `app.bank-payments._index.tsx` via
 * `searchBankPaymentOrders`) — never raw Prisma in the route.
 *
 * LOADER ONLY, deliberately — no `action` on this route, so it needs no
 * entry in `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES`.
 * Every mutation lives on `app.shipments.new.tsx` (create) and
 * `app.shipments.$id.tsx` (everything else).
 *
 * THE DIVERGENCE THE TEAM LEAD ASKED FOR IS VISIBLE HERE, NOT HIDDEN: the
 * "Insured" column shows what staff actually recorded; the "Computed (D29)"
 * column shows what the domain computed from the shipment's own contents.
 * Neither overwrites the other — see `app.shipments.$id.tsx` for the full
 * explanation surfaced per-shipment.
 *
 * NEVER SHOWS supplier cost, margin, or landed cost — there is none on
 * `Shipment` to begin with, and `searchShipmentsForStaff`'s own `select` is
 * an explicit field list (never a raw spread/include), so nothing could leak
 * one even by an accidental future join.
 */

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  rows: readonly ShipmentStaffListRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  loadError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;

  let rows: ShipmentStaffListRow[] = [];
  let totalCount = 0;
  let pageSize = 25;
  let loadError: string | null = null;
  try {
    const result = await searchShipmentsForStaff({ query: query || undefined, page });
    rows = [...result.rows];
    totalCount = result.totalCount;
    pageSize = result.pageSize;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to search shipments.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    query,
    rows,
    totalCount,
    page,
    pageSize,
    loadError,
  } satisfies LoaderData;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Whole minor units as a human dollar-and-cents string — display only, same discipline as `app.warranty-claims.$id.tsx`'s identical helper (no Number(), no toLocaleString). */
function formatMoney(minorUnits: bigint | null, currency: string | null): string {
  if (minorUnits === null || currency === null) return "—";
  const negative = minorUnits < 0n;
  const digits = (negative ? -minorUnits : minorUnits).toString();
  const padded = digits.padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${minor}`;
}

/** Visible, not silent: recorded insured value and the domain's computed shipment merchandise value disagree. Both null, or both present and equal, are not flagged — D30/G2 explicitly allows a difference (e.g. a carrier cap), so this is informational, never an error state. */
function insuredDivergesFromComputed(row: ShipmentStaffListRow): boolean {
  if (row.insuredValueMinorUnits === null || row.computedMerchandiseValueMinorUnits === null) {
    return row.insuredValueMinorUnits === null && row.computedMerchandiseValueMinorUnits !== null;
  }
  return (
    row.insuredValueMinorUnits !== row.computedMerchandiseValueMinorUnits ||
    row.insuredValueCurrency !== row.computedMerchandiseValueCurrency
  );
}

export default function ShipmentsListPage() {
  const { apiKey, shop, query, rows, totalCount, page, pageSize, loadError } = useLoaderData<typeof loader>();

  const hasNextPage = page * pageSize < totalCount;
  const hasPreviousPage = page > 1;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.75rem" }}>
          <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Shipments</h1>
          <Link to="/app/shipments/new">+ Record a new shipment</Link>
        </div>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. What was actually arranged with a carrier for each outbound package —
          not what a policy threshold would compute.
        </p>

        <Form method="get" role="search" style={{ margin: "0 0 1.5rem", display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label htmlFor="q" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Search by order, tracking number, or carrier
            </label>
            <input
              id="q"
              name="q"
              type="text"
              defaultValue={query}
              style={{ padding: "0.4rem 0.6rem", minWidth: "22rem" }}
              placeholder="e.g. TRACK-12345"
            />
          </div>
          <button type="submit">Search</button>
          {query ? (
            <Link to="/app/shipments" style={{ marginLeft: "0.5rem" }}>
              Clear
            </Link>
          ) : null}
        </Form>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not search shipments: {loadError}
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: "#555" }}>{query ? "No shipment matched that search." : "No shipments recorded yet."}</p>
        ) : (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
              <caption style={{ textAlign: "left", captionSide: "top", margin: "0 0 0.5rem", color: "#777" }}>
                {query ? "Search results" : "Most recently shipped first"} — {totalCount} total
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Order</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Carrier / tracking</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Shipped</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Signature</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Computed (D29)</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Insured</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Delivered</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.orderRef}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {row.carrier} — {row.trackingNumber}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <time dateTime={row.shipDate.toISOString()}>{formatDate(row.shipDate)}</time>
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {row.signatureRequired ? "Required" : "Not required"}
                      {row.signatureRequiredSource === "staff_override" ? " (override)" : ""}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {formatMoney(row.computedMerchandiseValueMinorUnits, row.computedMerchandiseValueCurrency)}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {formatMoney(row.insuredValueMinorUnits, row.insuredValueCurrency)}
                      {row.insuranceProviderId ? (row.insuranceCoverageVerifiedAt ? " (verified)" : " (unverified)") : ""}
                      {insuredDivergesFromComputed(row) ? (
                        <span style={{ marginLeft: "0.35rem", color: "#b06a00" }} title="Recorded insured value differs from the computed shipment merchandise value.">
                          ⚠
                        </span>
                      ) : null}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {row.deliveredAt ? formatTimestamp(row.deliveredAt) : "—"}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <Link to={`/app/shipments/${row.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hasPreviousPage || hasNextPage ? (
              <nav style={{ marginTop: "1rem", display: "flex", gap: "1rem" }} aria-label="Pagination">
                {hasPreviousPage ? (
                  <Link to={`?${new URLSearchParams({ q: query, page: String(page - 1) })}`}>&larr; Previous</Link>
                ) : null}
                {hasNextPage ? (
                  <Link to={`?${new URLSearchParams({ q: query, page: String(page + 1) })}`}>Next &rarr;</Link>
                ) : null}
              </nav>
            ) : null}
          </>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
