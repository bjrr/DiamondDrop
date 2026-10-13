import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";

import {
  getGroupBuyCampaignTierPublishStatus,
  listGroupBuyCampaignsForStaff,
  type GroupBuyCampaignListRow,
  type GroupBuyCampaignTierPublishStatus,
} from "~/db/repositories/groupBuyRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/group-buy-campaigns — the Group Buy campaign admin landing list
 * (Slice 6, docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §11-§13).
 *
 * LOADER ONLY, deliberately — same reasoning as `app.warranty-claims._index.tsx`
 * and `app.bank-payments._index.tsx`: this route has no `action`, so it needs
 * no entry in `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES`.
 * Every mutation (create, configure, upload options, open) lives on
 * `app.group-buy-campaigns.new.tsx` or `app.group-buy-campaigns.$id.tsx`.
 *
 * Reads through `listGroupBuyCampaignsForStaff`, which selects only
 * identification/status/counts — never a frozen price, a frozen landed cost,
 * a pricing-profile reference, or an unsafe-override reason (CLAUDE.md rule
 * 10). This page is a directory, not a pricing report.
 *
 * "Shopify tier price" COLUMN — the list-view half of the tier-price-sync
 * recovery gap `app.group-buy-campaigns.$id.tsx`'s header comment describes
 * in full. Only an open campaign can have a publish gap at all (a draft has
 * nothing frozen yet, a closed campaign's frozen pricing stays as it was), so
 * `getGroupBuyCampaignTierPublishStatus` is only called for `status ===
 * "open"` rows — every other row shows "—" without the extra query. Still
 * only a tier number and a boolean; the resync action itself lives on the
 * detail page, not here.
 */

/**
 * Whether the campaign's CURRENT tier price has ever fully reached Shopify —
 * `null` (not applicable) for a draft or closed campaign. See
 * `app.group-buy-campaigns.$id.tsx`'s header comment on the recovery gap this
 * surfaces, and `getGroupBuyCampaignTierPublishStatus`'s own doc comment.
 */
interface TierPublishRowView {
  readonly tierNumber: number;
  readonly published: boolean;
}

interface SerializedCampaignRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly currency: string;
  readonly scheduledCloseAt: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly tierCount: number;
  readonly variantCount: number;
  readonly tierPublish: TierPublishRowView | null;
}

interface LoaderData {
  apiKey: string;
  shop: string;
  campaigns: readonly SerializedCampaignRow[];
  loadError: string | null;
  view: "operational" | "archived" | "all";
}

function serialize(row: GroupBuyCampaignListRow, tierPublish: GroupBuyCampaignTierPublishStatus | null): SerializedCampaignRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    currency: row.currency,
    scheduledCloseAt: row.scheduledCloseAt ? row.scheduledCloseAt.toISOString() : null,
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    tierCount: row.tierCount,
    variantCount: row.variantCount,
    tierPublish: tierPublish ? { tierNumber: tierPublish.tierNumber, published: tierPublish.published } : null,
  };
}

/**
 * Which campaigns this page is showing. Read from the query string so the
 * view is linkable and bookmarkable — a staff member investigating something
 * archived can send the URL to a colleague.
 *
 * ANYTHING UNRECOGNISED FALLS BACK TO `operational`. A typo in a hand-edited
 * URL should show the normal list, never silently widen it to include
 * archived or fixture rows while looking like the default.
 */
function resolveView(request: Request): "operational" | "archived" | "all" {
  const requested = new URL(request.url).searchParams.get("view");
  return requested === "archived" || requested === "all" ? requested : "operational";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const view = resolveView(request);

  let campaigns: SerializedCampaignRow[] = [];
  let loadError: string | null = null;
  try {
    const rows = await listGroupBuyCampaignsForStaff({ view });
    // Only OPEN campaigns can have a publish gap at all (see
    // getGroupBuyCampaignTierPublishStatus) — draft/closed rows skip the
    // extra query entirely rather than asking a question this list has no
    // action for.
    const tierPublishById = new Map<string, GroupBuyCampaignTierPublishStatus | null>();
    await Promise.all(
      rows
        .filter((row) => row.status === "open")
        .map(async (row) => {
          tierPublishById.set(row.id, await getGroupBuyCampaignTierPublishStatus(row.id));
        })
    );
    campaigns = rows.map((row) => serialize(row, tierPublishById.get(row.id) ?? null));
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Group Buy campaigns.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    campaigns,
    loadError,
    view,
  } satisfies LoaderData;
}

function formatTimestamp(iso8601: string | null): string {
  if (!iso8601) return "—";
  return `${iso8601.replace("T", " ").slice(0, 16)} UTC`;
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function GroupBuyCampaignsListPage() {
  const { apiKey, shop, campaigns, loadError, view } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
          <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Group Buy campaigns</h1>
          <Link to="/app/group-buy-campaigns/new">+ New campaign</Link>
        </div>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Opening a campaign freezes its pricing permanently — configure tiers,
          eligible variants, and the campaign-options upload while it is still a draft.
        </p>

        {/*
          VIEW SWITCHER. Archiving tidies the default list; it must never make
          history unreachable (owner-locked 2026-10-05), so the archived rows
          are one click away and the current view is always stated rather than
          implied by an empty table.
        */}
        <nav aria-label="Campaign views" style={{ display: "flex", gap: "0.75rem", margin: "0 0 1rem" }}>
          {([
            ["operational", "Active"],
            ["archived", "Archived"],
            ["all", "All"],
          ] as const).map(([value, label]) => (
            <Link
              key={value}
              to={value === "operational" ? "/app/group-buy-campaigns" : `/app/group-buy-campaigns?view=${value}`}
              aria-current={view === value ? "page" : undefined}
              style={{
                fontWeight: view === value ? 600 : 400,
                textDecoration: view === value ? "none" : "underline",
                color: view === value ? "#111" : undefined,
              }}
            >
              {label}
            </Link>
          ))}
        </nav>

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not load Group Buy campaigns: {loadError}
          </p>
        ) : campaigns.length === 0 ? (
          <p style={{ color: "#555" }}>
            {view === "archived"
              ? "No archived Group Buy campaigns."
              : view === "all"
                ? "No Group Buy campaigns yet."
                : "No active Group Buy campaigns. Archived ones are under the Archived view."}
          </p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem" }}>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Code
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Name
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Status
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Tiers
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Eligible variants
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Scheduled close
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Opened
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}>
                  Shopify tier price
                </th>
                <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.5rem" }}></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{campaign.code}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{campaign.name}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{statusLabel(campaign.status)}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{campaign.tierCount}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{campaign.variantCount}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    {formatTimestamp(campaign.scheduledCloseAt)}
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>{formatTimestamp(campaign.openedAt)}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    {campaign.tierPublish === null ? (
                      "—"
                    ) : campaign.tierPublish.published ? (
                      <span style={{ color: "#2a7a2a" }}>Tier {campaign.tierPublish.tierNumber} live</span>
                    ) : (
                      <span role="alert" style={{ color: "#b00", fontWeight: 600 }}>
                        Tier {campaign.tierPublish.tierNumber} NOT on Shopify
                      </span>
                    )}
                  </td>
                  <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                    <Link to={`/app/group-buy-campaigns/${campaign.id}`}>Open</Link>
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
