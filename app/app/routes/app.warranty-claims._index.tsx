import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import {
  searchWarrantyClaimsForStaff,
  type WarrantyClaimStaffListRow,
} from "~/db/repositories/warrantyClaimRepository.server";
import { WARRANTY_CLAIM_STATUSES, type WarrantyClaimStatus } from "~/domain/warranty/claimStatus";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/warranty-claims — staff triage queue and search (Slice 5 task
 * 5-4, `docs/WARRANTY-CLAIMS.md`, `docs/specs/SLICE-5-WARRANTY-CLAIMS.md`
 * criteria 157-170).
 *
 * Reads through `searchWarrantyClaimsForStaff` (task 5-2), exactly the
 * convention every other admin list route in this codebase already follows
 * (`app.bank-payments._index.tsx` via `searchBankPaymentOrders`, `alerts.tsx`
 * via `listOpenAdminAlerts`) — never raw Prisma in the route.
 *
 * A blank search shows every OPEN claim (everything not yet `resolved` or
 * `closed`), oldest-submitted-first — the triage queue staff actually work
 * from, same reasoning as `app.bank-payments._index.tsx`'s blank-search
 * default. A non-blank query searches by claim reference, order ref,
 * purchaser name/email, or an exact id.
 *
 * LOADER ONLY, deliberately — same reasoning as `app.bank-payments._index.tsx`
 * and `alerts.tsx`: this route has no `action`, so it needs no entry in
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES`. Every
 * mutation lives on `app.warranty-claims.$id.tsx`.
 *
 * NEVER SHOWS cost, margin, landed cost or any pricing data — there is none
 * on a warranty claim, and `searchWarrantyClaimsForStaff`'s own `select`
 * excludes even the local-jeweller table entirely (see that function's doc
 * comment) — nothing here could leak it even by an accidental join.
 */

/** Every status except the two terminal ones — the triage queue's default view. */
const OPEN_STATUSES: readonly WarrantyClaimStatus[] = WARRANTY_CLAIM_STATUSES.filter(
  (status) => status !== "resolved" && status !== "closed"
);

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  statusFilter: string;
  rows: readonly WarrantyClaimStaffListRow[];
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

  let rows: WarrantyClaimStaffListRow[] = [];
  let totalCount = 0;
  let pageSize = 25;
  let loadError: string | null = null;
  try {
    const status: WarrantyClaimStatus | readonly WarrantyClaimStatus[] | undefined =
      statusFilter && (WARRANTY_CLAIM_STATUSES as readonly string[]).includes(statusFilter)
        ? (statusFilter as WarrantyClaimStatus)
        : query
          ? undefined // an explicit search looks across every status, not just the open queue
          : OPEN_STATUSES;

    const result = await searchWarrantyClaimsForStaff({ query: query || undefined, status, page });
    rows = [...result.rows];
    totalCount = result.totalCount;
    pageSize = result.pageSize;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to search warranty claims.";
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

function statusLabel(status: WarrantyClaimStatus): string {
  return status.replace(/_/g, " ");
}

export default function WarrantyClaimsListPage() {
  const { apiKey, shop, query, statusFilter, rows, totalCount, page, pageSize, loadError } = useLoaderData<typeof loader>();

  const hasNextPage = page * pageSize < totalCount;
  const hasPreviousPage = page > 1;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Warranty claims</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Locate a warranty claim to review, authorize, or decide.
        </p>

        <Form method="get" role="search" style={{ margin: "0 0 1.5rem", display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label htmlFor="q" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Search by claim reference, order, or purchaser name/email
            </label>
            <input
              id="q"
              name="q"
              type="text"
              defaultValue={query}
              style={{ padding: "0.4rem 0.6rem", minWidth: "22rem" }}
              placeholder="e.g. WC-ABC12345"
            />
          </div>
          <div>
            <label htmlFor="status" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Status
            </label>
            <select id="status" name="status" defaultValue={statusFilter} style={{ padding: "0.4rem 0.6rem" }}>
              <option value="">Any</option>
              {WARRANTY_CLAIM_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Search</button>
          {query || statusFilter ? (
            <Link to="/app/warranty-claims" style={{ marginLeft: "0.5rem" }}>
              Clear — show open claims
            </Link>
          ) : null}
        </Form>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not search warranty claims: {loadError}
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: "#555" }}>
            {query || statusFilter
              ? "No warranty claim matched that search."
              : "No open warranty claims — every claim is resolved or closed."}
          </p>
        ) : (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
              <caption style={{ textAlign: "left", captionSide: "top", margin: "0 0 0.5rem", color: "#777" }}>
                {query || statusFilter ? "Search results" : "Open claims, oldest first"} — {totalCount} total
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                    Claim reference
                  </th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                    Purchaser
                  </th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                    Status
                  </th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                    Submitted
                  </th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                    Coverage
                  </th>
                  <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.claimReference}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      {row.purchaserName} ({row.purchaserEmail})
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{statusLabel(row.status)}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <time dateTime={row.submittedAt.toISOString()}>{formatTimestamp(row.submittedAt)}</time>
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{row.coverageDecision ?? "—"}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                      <Link to={`/app/warranty-claims/${row.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hasPreviousPage || hasNextPage ? (
              <nav style={{ marginTop: "1rem", display: "flex", gap: "1rem" }} aria-label="Pagination">
                {hasPreviousPage ? (
                  <Link
                    to={`?${new URLSearchParams({ q: query, status: statusFilter, page: String(page - 1) })}`}
                  >
                    &larr; Previous
                  </Link>
                ) : null}
                {hasNextPage ? (
                  <Link
                    to={`?${new URLSearchParams({ q: query, status: statusFilter, page: String(page + 1) })}`}
                  >
                    Next &rarr;
                  </Link>
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
