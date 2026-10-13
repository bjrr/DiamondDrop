import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import {
  searchCustomJewelryProjectsForStaff,
  type CustomJewelryStaffListRow,
} from "~/db/repositories/customJewelryProjectRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/custom-jewelry — the staff Custom Jewelry enquiry queue.
 *
 * Mirrors `app.rma._index.tsx` and `app.warranty-claims._index.tsx`: same
 * pagination discipline, same blank-search-shows-the-open-queue default, and
 * the same "loader only, so no `csrfResourceRouteFence` entry is needed"
 * reasoning — every mutation lives on `app.custom-jewelry.$id.tsx`.
 *
 * THE DEPOSIT COLUMNS ARE THE POINT OF THIS LIST. Staff need to see at a
 * glance which enquiries are waiting on the customer to accept the deposit
 * terms and which are waiting on us to issue the invoice — those are two
 * different queues of work, and without them this page is just a list of
 * names.
 *
 * NEVER SHOWS cost, margin or landed cost — there is none on these records.
 * The customer's own budget figure is deliberately absent too: it is not
 * needed to triage, and a figure a customer volunteered in confidence does
 * not belong on a screen that gets shown in meetings.
 *
 * `promptText` is also absent, for a plainer reason: it is long free text and
 * a list that renders it is unreadable. The detail page is where it belongs.
 */

/** Everything not yet finished — the default view when no search is active. */
const OPEN_STATUSES = ["submitted", "deposit_charged", "awaiting_approval", "approved"] as const;

interface ListRowView {
  readonly id: string;
  readonly projectReference: string;
  readonly status: string;
  readonly customerName: string;
  readonly email: string;
  readonly createdAt: string;
  readonly depositStage: string;
}

/**
 * The deposit situation as one readable phrase.
 *
 * Three distinct states, and conflating any two of them would hide a queue:
 * nobody has agreed yet; they agreed and we owe them an invoice; the invoice
 * is out and we are waiting on payment.
 */
function describeDepositStage(row: CustomJewelryStaffListRow): string {
  if (!row.depositAcceptedAt) return "Terms not accepted";
  if (!row.depositInvoiceIssuedAt) return "Accepted — invoice not issued";
  return "Invoice issued";
}

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  rows: readonly ListRowView[];
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

  let rows: ListRowView[] = [];
  let totalCount = 0;
  let pageSize = 25;
  let loadError: string | null = null;
  try {
    const result = await searchCustomJewelryProjectsForStaff({
      query: query || undefined,
      // A search looks everywhere; an unsearched visit shows the work queue.
      status: query ? undefined : OPEN_STATUSES,
      page,
    });
    rows = result.rows.map((row) => ({
      id: row.id,
      projectReference: row.projectReference,
      status: row.status,
      customerName: row.customerName,
      email: row.email,
      createdAt: row.createdAt.toISOString().slice(0, 10),
      depositStage: describeDepositStage(row),
    }));
    totalCount = result.totalCount;
    pageSize = result.pageSize;
  } catch (error) {
    // Rendered as a message rather than thrown: a staff queue that shows an
    // error banner is more useful than one that shows Shopify's error boundary
    // and loses the search box with it.
    loadError = error instanceof Error ? error.message : "Could not load enquiries.";
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

export default function CustomJewelryIndexPage() {
  const { apiKey, query, rows, totalCount, page, pageSize, loadError } = useLoaderData<LoaderData>();
  // NO DIVISION AND NO ROUNDING HELPER. This repo bans those helpers outright
  // — money rounding must go through the versioned rule registry — and the ban
  // is deliberately unconditional so nobody has to judge whether a given call
  // site is "money enough" to matter. A page count is not money and takes no
  // exception: `app.rma._index.tsx` sidesteps the same problem the same way,
  // with a multiplication instead of a division.
  //
  // The helpers are not named here even in prose, because the money-safety
  // scan is TEXTUAL — a comment mentioning them trips it just as a call would.
  const hasNextPage = page * pageSize < totalCount;
  const hasPreviousPage = page > 1;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ padding: "1.5rem", maxWidth: "70rem" }}>
        <h1 style={{ marginTop: 0 }}>Custom Jewelry enquiries</h1>

        {/* GET, not POST — a search is a navigation, and this route has no
            action at all, which is why it needs no CSRF fence entry. */}
        <Form method="get">
          <label htmlFor="q">Search by reference or email</label>{" "}
          <input id="q" type="search" name="q" defaultValue={query} />{" "}
          <button type="submit">Search</button>
        </Form>

        {loadError ? (
          <p role="alert" style={{ fontWeight: 600 }}>
            {loadError}
          </p>
        ) : null}

        <p>
          {query ? `${totalCount} result(s) for “${query}”` : `${totalCount} open enquiry/enquiries`} · page {page}
        </p>

        {rows.length === 0 ? (
          <p>{query ? "Nothing matched that search." : "No open enquiries."}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Submitted</th>
                <th scope="col">Status</th>
                <th scope="col">Design Deposit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`/app/custom-jewelry/${row.id}`}>{row.projectReference}</Link>
                  </td>
                  <td>
                    {row.customerName}
                    <br />
                    {row.email}
                  </td>
                  <td>{row.createdAt}</td>
                  <td>{row.status}</td>
                  <td>{row.depositStage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hasPreviousPage || hasNextPage ? (
          <p>
            {hasPreviousPage ? (
              <Link to={`/app/custom-jewelry?q=${encodeURIComponent(query)}&page=${page - 1}`}>Previous</Link>
            ) : null}{" "}
            {hasNextPage ? (
              <Link to={`/app/custom-jewelry?q=${encodeURIComponent(query)}&page=${page + 1}`}>Next</Link>
            ) : null}
          </p>
        ) : null}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
