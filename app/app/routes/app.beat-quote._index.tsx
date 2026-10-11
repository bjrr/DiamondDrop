import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useRouteError } from "react-router";

import {
  searchBeatQuoteSubmissionsForStaff,
  type BeatQuoteStaffListRow,
} from "~/db/repositories/beatQuoteReviewRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/beat-quote — the staff "Let Us Beat Your Quote" triage queue.
 *
 * Mirrors `app.rma._index.tsx` and `app.custom-jewelry._index.tsx`: same
 * pagination discipline, same blank-search-shows-the-open-queue default, and
 * the same "loader only, so no `csrfResourceRouteFence` entry is needed"
 * reasoning — every mutation lives on `app.beat-quote.$id.tsx`.
 *
 * ============================================================================
 * THE NEXT ACTION COLUMN IS THE POINT OF THIS SCREEN
 * ============================================================================
 * A reviewer's question is never "what status is this?" — it is "what do I do
 * with it?". Those are different, and the mapping is not obvious from the raw
 * fields: a submission awaiting verification, one verified and awaiting a
 * pricing decision, and one declined with a $100 benefit still unissued are
 * three distinct queues that all look like "in progress" if you only read
 * `status`.
 *
 * The last of those is the one worth surfacing loudest. A declined guarantee
 * submission with no benefit issued is a promise CaratForUs has made and not
 * yet kept, and nothing else on this screen is a liability.
 *
 * Oldest first, because a triage queue is worked front to back and the
 * submission waiting longest is the one a customer is waiting on.
 *
 * NEVER SHOWS internal verification evidence or a decision reason — those are
 * long free text, and `searchBeatQuoteSubmissionsForStaff`'s own `select`
 * allowlist excludes them so this page could not render them by accident.
 */

/** Everything not yet finished — the default view when no search is active. */
const OPEN_STATUSES = ["submitted", "in_review", "offer_made", "declined_cannot_beat"] as const;

/**
 * What a reviewer should do next, derived from the frozen treatment plus the
 * two review facts. Deliberately a sentence rather than a status code.
 */
function nextAction(row: BeatQuoteStaffListRow): string {
  if (row.verification === "pending") return "Verify the seller, price and specs";
  if (row.verification === "rejected") return "Rejected — close when ready";
  if (row.status === "in_review") return "Decide: can we beat this price?";
  if (row.status === "offer_made") return "Offer made — awaiting the customer";
  if (row.status === "declined_cannot_beat") {
    if (row.treatment !== "guarantee") return "Declined — no benefit owed (review-only path)";
    if (row.benefitIssuedAt) return "Benefit issued";
    // The liability. Everything else here is work; this is an unkept promise.
    return row.hasAccount ? "OWED: issue the 10%-off benefit" : "OWED: needs the customer signed in first";
  }
  return row.status;
}

/** Minor units to a display string by integer arithmetic — no rounding helper. */
function formatMinorUnits(amountMinorUnits: bigint, currency: string): string {
  const major = amountMinorUnits / 100n;
  const minor = amountMinorUnits % 100n;
  return `${major}.${minor < 10n ? `0${minor}` : minor} ${currency}`;
}

interface ListRowView {
  readonly id: string;
  readonly submissionReference: string;
  readonly kind: string;
  readonly treatment: string;
  readonly customerName: string;
  readonly email: string;
  readonly quoteAge: string;
  readonly submittedAt: string;
  readonly competitorPrice: string;
  readonly nextAction: string;
  readonly owed: boolean;
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
    const result = await searchBeatQuoteSubmissionsForStaff({
      query: query || undefined,
      status: query ? undefined : OPEN_STATUSES,
      page,
    });
    rows = result.rows.map((row) => ({
      id: row.id,
      submissionReference: row.submissionReference,
      kind: row.kind,
      treatment: row.treatment,
      customerName: row.customerName,
      email: row.email,
      // "n/a" rather than blank: an online listing has NO age rule at all
      // (amendment §1), which is different from an age we failed to record.
      quoteAge: row.quoteAgeCalendarDays === null ? "n/a" : `${row.quoteAgeCalendarDays}d`,
      submittedAt: row.submittedAt.toISOString().slice(0, 16).replace("T", " "),
      competitorPrice:
        row.competitorPriceMinorUnits !== null && row.competitorPriceCurrency !== null
          ? formatMinorUnits(row.competitorPriceMinorUnits, row.competitorPriceCurrency)
          : "Not stated",
      nextAction: nextAction(row),
      owed:
        row.treatment === "guarantee" &&
        row.status === "declined_cannot_beat" &&
        row.benefitIssuedAt === null,
    }));
    totalCount = result.totalCount;
    pageSize = result.pageSize;
  } catch (error) {
    // Rendered as a banner rather than thrown: a queue that shows an error and
    // keeps its search box is more useful than Shopify's error boundary.
    loadError = error instanceof Error ? error.message : "Could not load submissions.";
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

export default function BeatQuoteIndexPage() {
  const { apiKey, query, rows, totalCount, page, pageSize, loadError } = useLoaderData<LoaderData>();
  // No division and no rounding helper — this repo bans those, and
  // `app.rma._index.tsx` sidesteps the same problem the same way.
  const hasNextPage = page * pageSize < totalCount;
  const owedCount = rows.filter((row) => row.owed).length;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ padding: "1.5rem", maxWidth: "80rem" }}>
        <h1 style={{ marginTop: 0 }}>Let Us Beat Your Quote — review queue</h1>

        {owedCount > 0 ? (
          <p role="alert" style={{ fontWeight: 600 }}>
            {owedCount} submission(s) on this page are owed the 10%-off benefit and have not been issued one.
          </p>
        ) : null}

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
          {query ? `${totalCount} result(s) for “${query}”` : `${totalCount} open submission(s)`} · page {page}
        </p>

        {rows.length === 0 ? (
          <p>{query ? "Nothing matched that search." : "No open submissions."}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Submitted</th>
                <th scope="col">Path</th>
                <th scope="col">Quote age</th>
                <th scope="col">Their price</th>
                <th scope="col">Customer</th>
                <th scope="col">Next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`/app/beat-quote/${row.id}`}>{row.submissionReference}</Link>
                  </td>
                  <td>{row.submittedAt}</td>
                  <td>
                    {row.kind}
                    <br />
                    {/* The frozen treatment, shown and never editable. */}
                    <strong>{row.treatment}</strong>
                  </td>
                  <td>{row.quoteAge}</td>
                  <td>{row.competitorPrice}</td>
                  <td>
                    {row.customerName}
                    <br />
                    {row.email}
                  </td>
                  <td style={row.owed ? { fontWeight: 600 } : undefined}>{row.nextAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {page > 1 || hasNextPage ? (
          <p>
            {page > 1 ? (
              <Link to={`/app/beat-quote?q=${encodeURIComponent(query)}&page=${page - 1}`}>Previous</Link>
            ) : null}{" "}
            {hasNextPage ? (
              <Link to={`/app/beat-quote?q=${encodeURIComponent(query)}&page=${page + 1}`}>Next</Link>
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
