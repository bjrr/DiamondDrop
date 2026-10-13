import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useRouteError } from "react-router";

import type { AdminAlertView } from "~/db/repositories/adminAlertRepository.server";
import { listOpenAdminAlerts } from "~/db/repositories/adminAlertRepository.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /alerts — the persistent embedded-admin alert surface (Slice 2 stage
 * 2A; docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §7, §15).
 *
 * Owner §15 requires this to exist ALONGSIDE email, not instead of it: email
 * tells a person once, this page is where they check without having to have
 * been on shift when the email arrived. It lists every currently OPEN
 * (unresolved) pricing failure — calculation and sync — so staff can act
 * before the 48-hour cutoff makes a variant unavailable.
 *
 * LOADER ONLY, DELIBERATELY. No `action` export, so this route needs no
 * entry in csrfResourceRouteFence.test.ts's EXEMPT_UI_ACTION_ROUTES — the
 * fence only ever looks at routes that combine an action with a default
 * export. Dismissing a sync-failure alert is a real capability
 * (`dismissSyncFailureAlert` exists in the repository layer) but is NOT
 * wired up here; adding that button later means adding an `action` and,
 * with it, a reasoned exemption entry — read that fence file first.
 *
 * NOT AN App Proxy route. This sits behind `authenticate.admin`, the same
 * embedded-session gate `_index.tsx` uses, so only Shopify Admin's own
 * embedded frame can reach it (see EXEMPT_UI_ACTION_ROUTES's reasoning for
 * _index.tsx, which applies identically here).
 *
 * THE VIEW MODEL IS NOT COMPUTED HERE. `listOpenAdminAlerts` (owned by the
 * alerts-backend agent) is the single source of truth this page and the
 * alert email both read from, so the two surfaces cannot drift apart by
 * each re-deriving "time remaining" or "is this suspended" slightly
 * differently. This route's only job is to render exactly what that
 * function returns — no cost, margin, landed-cost, pricing-profile,
 * uplift-rate, rule id, token or secret is read or displayed here (contract
 * C-S5); `AdminAlertView.reason` is a human-readable failure message, never
 * a cost breakdown.
 */

interface LoaderData {
  apiKey: string;
  shop: string;
  alerts: AdminAlertView[];
  /** Set when listOpenAdminAlerts itself throws — the page still renders, with this banner instead of a crash. */
  loadError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Performs/refreshes the embedded-admin session. Throws a redirect when
  // re-authentication is needed, exactly like _index.tsx.
  const { session } = await authenticate.admin(request);

  let alerts: AdminAlertView[] = [];
  let loadError: string | null = null;
  try {
    alerts = await listOpenAdminAlerts();
  } catch (error) {
    // A failed read must not blank the page — the page is also how staff
    // find out the read failed. Mirrors _index.tsx's readError handling.
    loadError = error instanceof Error ? error.message : "Failed to load pricing alerts.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    alerts,
    loadError,
  } satisfies LoaderData;
}

/**
 * Whole-minute-granular duration text, e.g. "1 day 4 hours 12 minutes" — no
 * abbreviations, for reliable screen-reader pronunciation.
 *
 * Integer arithmetic rather than `Math.floor` — the repo-wide ad-hoc-rounding
 * guard (`npm run check:money-safety`) is deliberately blunt with no
 * allowlist, and a duration is not worth an exception to a rule that exists
 * to protect prices. Subtracting the remainder before dividing floors
 * exactly for any non-negative `ms` (same pattern as
 * `~/domain/alerts/emailContent.ts`'s own `formatDuration` and
 * `~/domain/groupbuy/campaignProgress.ts`'s countdown). `ms` is clamped to
 * 0 first since a negative remainder would floor the wrong way.
 */
function formatDuration(ms: number): string {
  const clamped = ms > 0 ? ms : 0;
  const totalMinutes = (clamped - (clamped % 60_000)) / 60_000;
  const days = (totalMinutes - (totalMinutes % (24 * 60))) / (24 * 60);
  const minutesAfterDays = totalMinutes % (24 * 60);
  const hours = (minutesAfterDays - (minutesAfterDays % 60)) / 60;
  const minutes = minutesAfterDays % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** Deterministic, locale-independent timestamp text — toLocaleString varies by runtime ICU data, which would make rendered output (and tests against it) depend on where the process runs. */
function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function productDisplay(alert: AdminAlertView): string {
  if (alert.productTitle) return alert.productTitle;
  // A product that cannot be resolved is MORE alarming than a normal row,
  // not less — never drop the row, show the id instead.
  return alert.shopifyProductGid
    ? `Unresolved product (${alert.shopifyProductGid})`
    : `Unresolved product (variant ${alert.masterVariantId})`;
}

function variantDisplay(alert: AdminAlertView): string {
  if (alert.variantLabel) return alert.variantLabel;
  return alert.shopifyVariantGid
    ? `Unresolved variant (${alert.shopifyVariantGid})`
    : `Unresolved variant (${alert.masterVariantId})`;
}

function timeRemainingText(alert: AdminAlertView): string {
  if (alert.suspended) {
    return "0 minutes remaining — the 48-hour cutoff has already passed.";
  }
  return `${formatDuration(alert.msRemainingBeforeSuspension)} remaining before this variant becomes unavailable automatically.`;
}

function resolutionStatusText(alert: AdminAlertView): string {
  switch (alert.status) {
    case "dismissed":
      // Deliberately does NOT say "resolved" or "fixed" anywhere in this
      // sentence — a dismissed alert is only quieter, not closed.
      return "Dismissed by staff. The underlying failure is still unresolved — dismissing silences the alert, it does not fix the failure or guarantee the variant is available.";
    case "suspended":
      return "Suspended. Unresolved for more than 48 hours.";
    case "active":
    default:
      return "Active. Unresolved, within the 48-hour window.";
  }
}

function variantAvailabilityText(alert: AdminAlertView): string {
  return alert.suspended
    ? "Unavailable — taken off sale automatically after the 48-hour cutoff."
    : "Available — the last valid published price remains live while this is unresolved.";
}

interface AlertListProps {
  kindLabel: string;
  emptyText: string;
  alerts: AdminAlertView[];
  accentColor: string;
}

/** One alert kind's section: heading, explanatory copy, and a real <ul>/<li> list — never a styled <div> soup. */
function AlertSection({ kindLabel, emptyText, alerts, accentColor }: AlertListProps) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {alerts.length === 0 ? (
        <li style={{ color: "#555", fontSize: "0.875rem" }}>{emptyText}</li>
      ) : (
        alerts.map((alert) => (
          <li
            key={alert.episodeId}
            style={{
              border: "1px solid #ddd",
              borderLeft: `4px solid ${accentColor}`,
              borderRadius: "4px",
              padding: "0.75rem 1rem",
              marginBottom: "0.75rem",
            }}
          >
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>
              {/* The text label IS the distinguishing signal — accentColor above is a supplementary cue only. */}
              <span style={{ fontWeight: 700 }}>{kindLabel}</span> — {productDisplay(alert)} —{" "}
              {variantDisplay(alert)}
            </h3>
            <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Failure type: </dt>
                <dd style={{ display: "inline", margin: 0 }}>{alert.failureType}</dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Reason: </dt>
                <dd style={{ display: "inline", margin: 0 }}>{alert.reason}</dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>First unresolved failure: </dt>
                <dd style={{ display: "inline", margin: 0 }}>
                  <time dateTime={alert.firstFailedAt.toISOString()}>
                    {formatTimestamp(alert.firstFailedAt)}
                  </time>{" "}
                  ({formatDuration(alert.ageMs)} ago)
                </dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Time remaining before 48-hour cutoff: </dt>
                <dd style={{ display: "inline", margin: 0 }}>{timeRemainingText(alert)}</dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Latest retry result: </dt>
                <dd style={{ display: "inline", margin: 0 }}>
                  Attempt {alert.attemptCount} at{" "}
                  <time dateTime={alert.lastAttemptAt.toISOString()}>
                    {formatTimestamp(alert.lastAttemptAt)}
                  </time>
                  : {alert.lastError}
                </dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Resolution status: </dt>
                <dd style={{ display: "inline", margin: 0 }}>{resolutionStatusText(alert)}</dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Variant availability: </dt>
                <dd style={{ display: "inline", margin: 0 }}>{variantAvailabilityText(alert)}</dd>
              </div>
            </dl>
          </li>
        ))
      )}
    </ul>
  );
}

export default function AdminAlertsPage() {
  const { apiKey, shop, alerts, loadError } = useLoaderData<typeof loader>();

  const calculationAlerts = alerts.filter((a) => a.kind === "calculation_failure");
  const syncAlerts = alerts.filter((a) => a.kind === "sync_failure");

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Pricing alerts</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. This page lists every currently unresolved pricing
          failure so it can be found here without waiting for the alert email.
        </p>

        {loadError ? (
          <p role="alert" style={{ color: "#b00", margin: "0 0 1.5rem" }}>
            Could not load pricing alerts: {loadError}
          </p>
        ) : alerts.length === 0 ? (
          <p style={{ margin: "0 0 1.5rem", color: "#060" }}>
            No unresolved pricing alerts. Every variant is currently pricing and syncing normally.
          </p>
        ) : null}

        {!loadError ? (
          <>
            <section style={{ marginBottom: "2rem" }}>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.25rem" }}>Calculation failures</h2>
              <p style={{ margin: "0 0 0.75rem", color: "#777", fontSize: "0.875rem" }}>
                We could not compute a price for these variants at all — a missing or invalid pricing
                input. {calculationAlerts.length} unresolved.
              </p>
              <AlertSection
                kindLabel="CALCULATION FAILURE"
                emptyText="No active calculation failures."
                alerts={calculationAlerts}
                accentColor="#b06a00"
              />
            </section>

            <section>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.25rem" }}>Sync failures</h2>
              <p style={{ margin: "0 0 0.75rem", color: "#777", fontSize: "0.875rem" }}>
                We computed a price, but Shopify would not accept it — the published price is stale
                until this is resolved. {syncAlerts.length} unresolved.
              </p>
              <AlertSection
                kindLabel="SYNC FAILURE"
                emptyText="No active sync failures."
                alerts={syncAlerts}
                accentColor="#5b3ea6"
              />
            </section>
          </>
        ) : null}
      </main>
    </AppProvider>
  );
}

/** Re-emits Shopify's document headers, exactly as _index.tsx does — required for the embedded frame to render at all. */
export const headers: HeadersFunction = (args) => boundary.headers(args);

/** Re-throws the library's re-authentication redirects instead of swallowing them as a generic error page — see _index.tsx's identical comment. */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
