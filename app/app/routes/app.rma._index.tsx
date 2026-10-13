import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import { searchRmaRequestsForStaff, type RmaStaffListRow } from "~/db/repositories/rmaRepository.server";
import { RMA_STATUSES } from "~/domain/rma/status";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/rma — the staff Buy Now RMA triage queue and search (Slice 4
 * remedy-execution task, `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`,
 * `docs/specs/SLICE-4-BUY-NOW-RMA.md`). Mirrors `app.warranty-claims._index.tsx`
 * exactly — same pagination discipline, same blank-search-shows-open-queue
 * default, same "loader only, no `csrfResourceRouteFence` entry needed"
 * reasoning (every mutation lives on `app.rma.$id.tsx`).
 *
 * NEVER SHOWS cost, margin, landed cost, or any remedy processor reference —
 * `searchRmaRequestsForStaff`'s own `select` allowlist excludes all of that;
 * this list surfaces only `remedyStatus`, never `processorReference`.
 */

const OPEN_STATUSES = RMA_STATUSES.filter((status) => status !== "resolved" && status !== "closed" && status !== "denied" && status !== "expired");

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  statusFilter: string;
  rows: readonly RmaStaffListRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  loadError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const statusFilter = url.searchParams.get("status") ?? "";
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;

  let rows: RmaStaffListRow[] = [];
  let totalCount = 0;
  let pageSize = 25;
  let loadError: string | null = null;
  try {
    const status =
      statusFilter && (RMA_STATUSES as readonly string[]).includes(statusFilter)
        ? (statusFilter as (typeof RMA_STATUSES)[number])
        : query
          ? undefined
          : OPEN_STATUSES;

    const result = await searchRmaRequestsForStaff({ query: query || undefined, status, page });
    rows = [...result.rows];
    totalCount = result.totalCount;
    pageSize = result.pageSize;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to search RMAs.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    query,
    statusFilter,
    rows,
    totalCount,
    page,
    pageSize,
    loadError,
  } satisfies LoaderData;
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export default function RmaListPage() {
  const { apiKey, shop, query, statusFilter, rows, totalCount, page, pageSize, loadError } = useLoaderData<typeof loader>();
  const hasNextPage = page * pageSize < totalCount;
  const hasPreviousPage = page > 1;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Buy Now RMAs</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Locate an RMA to review, approve, or issue its remedy.
        </p>

        <Form method="get" role="search" style={{ margin: "0 0 1.5rem", display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label htmlFor="q" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Search by RMA reference, order, or purchaser email
            </label>
            <input id="q" name="q" type="text" defaultValue={query} style={{ padding: "0.4rem 0.6rem", minWidth: "22rem" }} placeholder="e.g. RMA-ABC12345" />
          </div>
          <div>
            <label htmlFor="status" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Status
            </label>
            <select id="status" name="status" defaultValue={statusFilter} style={{ padding: "0.4rem 0.6rem" }}>
              <option value="">Any</option>
              {RMA_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Search</button>
          {query || statusFilter ? (
            <Link to="/app/rma" style={{ marginLeft: "0.5rem" }}>
              Clear — show open RMAs
            </Link>
          ) : null}
        </Form>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not search RMAs: {loadError}
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: "#555" }}>{query || statusFilter ? "No RMA matched that search." : "No open RMAs."}</p>
        ) : (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
              <caption style={{ textAlign: "left", captionSide: "top", margin: "0 0 0.5rem", color: "#777" }}>
                {query || statusFilter ? "Search results" : "Open RMAs, oldest first"} — {totalCount} total
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>RMA reference</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Purchaser</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Status</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Window</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Requested</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>Remedy</th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.rmaReference}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.purchaserEmail}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{statusLabel(row.status)}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.windowKind}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <time dateTime={row.requestedAt.toISOString()}>{formatTimestamp(row.requestedAt)}</time>
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.remedyStatus ? statusLabel(row.remedyStatus) : "—"}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <Link to={`/app/rma/${row.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hasPreviousPage || hasNextPage ? (
              <nav style={{ marginTop: "1rem", display: "flex", gap: "1rem" }} aria-label="Pagination">
                {hasPreviousPage ? <Link to={`?${new URLSearchParams({ q: query, status: statusFilter, page: String(page - 1) })}`}>&larr; Previous</Link> : null}
                {hasNextPage ? <Link to={`?${new URLSearchParams({ q: query, status: statusFilter, page: String(page + 1) })}`}>Next &rarr;</Link> : null}
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
