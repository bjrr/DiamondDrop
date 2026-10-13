import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  listGroupBuyDemandSignals,
  markGroupBuyDemandSignalsNotified,
} from "~/db/repositories/groupBuyDemandSignalRepository.server";
import type { DemandSignalKind } from "~/domain/groupbuy/demandSignal";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/group-buy-demand — who asked to hear about what.
 *
 * README: "Completed campaigns support low-friction Bring It Back / Notify Me
 * If It Returns interest capture. Also provide a simple Request a New Group
 * Buy form."
 *
 * ============================================================================
 * A WORKLIST, NOT A MAILING TOOL
 * ============================================================================
 * This page answers one operational question — who still needs telling — and
 * offers one action: mark a batch as notified, AFTER staff have actually sent
 * something. It does not send email. Sending from here would mean a button
 * that mails strangers with no preview, no copy approval and no record of what
 * went out; the notification itself goes through whatever channel the owner
 * approves, and this page records that it happened.
 *
 * WHICH MEANS "MARK NOTIFIED" IS A CLAIM BY A HUMAN, and is attributed. The
 * repository only ever sets the flag, never clears it, so the list cannot be
 * cycled to make someone look un-notified.
 *
 * ============================================================================
 * THIS PAGE SHOWS EMAIL ADDRESSES. THAT IS THE POINT, AND THE LIMIT.
 * ============================================================================
 * An address is the only personal data demand capture holds, and staff cannot
 * act on a notification list without it. Nothing else about the person is
 * stored or shown — no name, no order history, no other campaigns they have
 * bought from. The page deliberately does not join to orders or customers:
 * "who wants this" is a different question from "who is this".
 *
 * VOTING IS POST-MVP. These rows are interest. Nothing here ranks campaigns,
 * totals them into a decision, or presents a leaderboard.
 */

// ---------------------------------------------------------------------------
// Staff identity — D23. Duplicated from app.group-buy-campaigns.$id.tsx for
// the reason stated there: a shared helper under app/routes/ would itself
// become a route, because React Router flat-routes treats dots as path
// separators.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

interface SignalView {
  readonly id: string;
  readonly kind: DemandSignalKind;
  readonly email: string;
  readonly campaignRef: string | null;
  readonly note: string | null;
  readonly notifiedAt: string | null;
  readonly notifiedBy: string | null;
  readonly createdAt: string;
}

interface LoaderData {
  readonly apiKey: string;
  readonly shop: string;
  readonly view: "outstanding" | "all";
  readonly signals: readonly SignalView[];
  /** Outstanding bring-it-back counts per campaign, biggest first. */
  readonly byCampaign: readonly { readonly campaignRef: string; readonly outstanding: number }[];
}

function resolveView(request: Request): "outstanding" | "all" {
  // DEFAULTS TO OUTSTANDING, because the reason to open this page is to find
  // out who is still waiting. `?view=all` is in the URL so a staff member can
  // send a colleague what they are looking at.
  return new URL(request.url).searchParams.get("view") === "all" ? "all" : "outstanding";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const view = resolveView(request);

  const signals = await listGroupBuyDemandSignals({ outstandingOnly: view === "outstanding" });

  // Grouped in memory rather than by a second query: this list is already
  // bounded by the repository's take, and a GROUP BY would disagree with the
  // rows shown whenever the cap bites.
  const counts = new Map<string, number>();
  for (const signal of signals) {
    if (signal.kind !== "bring_it_back" || !signal.campaignRef) continue;
    if (signal.notifiedAt !== null) continue;
    counts.set(signal.campaignRef, (counts.get(signal.campaignRef) ?? 0) + 1);
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    view,
    signals: signals.map((s) => ({
      id: s.id,
      kind: s.kind,
      email: s.email,
      campaignRef: s.campaignRef,
      note: s.note,
      notifiedAt: s.notifiedAt ? s.notifiedAt.toISOString() : null,
      notifiedBy: s.notifiedBy,
      createdAt: s.createdAt.toISOString(),
    })),
    byCampaign: [...counts.entries()]
      .map(([campaignRef, outstanding]) => ({ campaignRef, outstanding }))
      .sort((a, b) => b.outstanding - a.outstanding),
  } satisfies LoaderData;
}

interface ActionData {
  readonly ok: boolean;
  readonly formError: string | null;
  readonly markedCount?: number;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false, formError: "Method not allowed." } satisfies ActionData, { status: 405 });
  }

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("group_buy_demand.no_online_user", {});
    return Response.json(
      {
        ok: false,
        formError:
          "This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again.",
      } satisfies ActionData,
      { status: 401 }
    );
  }

  const formData = await request.formData();
  if (formData.get("intent") !== "mark_notified") {
    return Response.json({ ok: false, formError: "Unrecognized action." } satisfies ActionData, { status: 400 });
  }

  const ids = formData.getAll("signalId").map(String).filter((id) => id.length > 0);
  if (ids.length === 0) {
    return Response.json(
      { ok: false, formError: "Select at least one person to mark as notified." } satisfies ActionData,
      { status: 400 }
    );
  }

  const markedCount = await markGroupBuyDemandSignalsNotified({ ids, notifiedBy: staffActorRef });
  logger.info("group_buy_demand.marked_notified", { requested: ids.length, markedCount, by: staffActorRef });

  return Response.json({ ok: true, formError: null, markedCount } satisfies ActionData);
}

const sectionStyle = { border: "1px solid #ddd", padding: "1rem", marginBottom: "1rem" } as const;
const cellStyle = { padding: "0.35rem 0.6rem", borderBottom: "1px solid #eee", textAlign: "left" } as const;

export default function GroupBuyDemandPage() {
  const { apiKey, signals, view, byCampaign } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const busy = useNavigation().state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Group Buy demand</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          People who asked to hear if a past Group Buy returns, and people who asked for a new one. Marking
          someone as notified records that you have already contacted them — this page does not send email.
        </p>

        {actionData?.formError ? (
          <p role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
            {actionData.formError}
          </p>
        ) : null}
        {actionData?.ok && actionData.markedCount !== undefined ? (
          <p style={{ margin: "0 0 1rem" }}>
            Marked {actionData.markedCount} as notified.
            {/* Says so when fewer moved than were selected, rather than
                reporting the request as though it were the result. */}
            {actionData.markedCount === 0
              ? " Everyone selected had already been marked — nobody was notified twice."
              : ""}
          </p>
        ) : null}

        <p style={{ margin: "0 0 1rem" }}>
          {(
            [
              ["outstanding", "Outstanding"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <a
              key={value}
              href={`/app/group-buy-demand?view=${value}`}
              aria-current={view === value ? "page" : undefined}
              style={{ marginRight: "0.75rem", fontWeight: view === value ? 700 : 400 }}
            >
              {label}
            </a>
          ))}
        </p>

        {byCampaign.length > 0 ? (
          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Outstanding by past campaign</h2>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {byCampaign.map((row) => (
                <li key={row.campaignRef}>
                  <code>{row.campaignRef}</code> — {row.outstanding} waiting
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
            {view === "outstanding" ? "Waiting to hear from us" : "Every request"}
          </h2>

          {signals.length === 0 ? (
            <p style={{ margin: 0 }}>
              {view === "outstanding"
                ? "Nobody is waiting. Switch to All to see requests already handled."
                : "No Group Buy interest has been captured yet."}
            </p>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="mark_notified" />
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={cellStyle}>
                      <span className="visually-hidden">Select</span>
                    </th>
                    <th style={cellStyle}>Asked for</th>
                    <th style={cellStyle}>Email</th>
                    <th style={cellStyle}>In their words</th>
                    <th style={cellStyle}>Asked</th>
                    <th style={cellStyle}>Notified</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((signal) => (
                    <tr key={signal.id}>
                      <td style={cellStyle}>
                        {signal.notifiedAt === null ? (
                          <input
                            type="checkbox"
                            name="signalId"
                            value={signal.id}
                            aria-label={`Mark ${signal.email} as notified`}
                          />
                        ) : null}
                      </td>
                      <td style={cellStyle}>
                        {signal.kind === "bring_it_back" ? (
                          <>
                            Bring back <code>{signal.campaignRef}</code>
                          </>
                        ) : (
                          "A new Group Buy"
                        )}
                      </td>
                      <td style={cellStyle}>{signal.email}</td>
                      <td style={cellStyle}>{signal.note ?? "—"}</td>
                      <td style={cellStyle}>{new Date(signal.createdAt).toLocaleDateString()}</td>
                      <td style={cellStyle}>
                        {signal.notifiedAt
                          ? `${new Date(signal.notifiedAt).toLocaleDateString()} by ${signal.notifiedBy ?? "(unrecorded)"}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="submit" disabled={busy} style={{ marginTop: "0.75rem" }}>
                Mark selected as notified
              </button>
            </Form>
          )}
        </section>
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
