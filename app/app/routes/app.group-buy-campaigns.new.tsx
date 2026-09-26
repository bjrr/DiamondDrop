import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";

import { createGroupBuyCampaign } from "~/db/repositories/groupBuyRepository.server";
import { InvalidTierSetError, MAX_TIERS, MIN_TIERS, type TierDefinition } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/group-buy-campaigns/new — draft campaign creation (Slice 6).
 *
 * A DEFAULT EXPORT WITH AN ACTION — see `csrfResourceRouteFence.test.ts`'s
 * `EXEMPT_UI_ACTION_ROUTES` for the reasoned exemption entry added for this
 * route, identical argument to `app.warranty-claims.$id.tsx`: Shopify Admin
 * iframes this route at the app's own host, so a form submitted from within
 * it is same-origin by construction.
 *
 * TIERS ARE ROW DATA, NOT A HARD-CODED SHAPE (docs/SLICE-2-AND-GROUP-BUY-
 * OWNER-DECISIONS.md / `tiers.ts`). This form renders `MAX_TIERS` rows and
 * passes whatever the staff member actually filled in straight to
 * `createGroupBuyCampaign`, which calls `validateTierSet` — every problem it
 * finds (count, contiguity, tier-1-starts-at-1, multiplier bounds) is
 * surfaced VERBATIM below, never re-worded or collapsed to "invalid tiers".
 *
 * "PERCENT OFF" IS A DISPLAY CONVENIENCE, NEVER FED BACK INTO PRICING. Staff
 * enter a percent-off per tier; this route converts it to the multiplier
 * `tiers.ts` actually stores (`multiplier = (100 - percentOff) / 100`) using
 * `MoneyDecimal` exact decimal arithmetic — never a floating-point division —
 * matching the money-safety discipline used everywhere else in this codebase.
 * The conversion happens once, here, before the multiplier is ever written;
 * `validateTierSet` then judges the resulting multiplier exactly as it would
 * judge one supplied directly.
 */

interface LoaderData {
  apiKey: string;
  shop: string;
  minTiers: number;
  maxTiers: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    minTiers: MIN_TIERS,
    maxTiers: MAX_TIERS,
  } satisfies LoaderData;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
  problems: readonly string[];
}

function fail(formError: string, problems: readonly string[] = []): ActionData {
  return { ok: false, formError, problems };
}

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

const PERCENT_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * One tier row -> a validated `TierDefinition`, or a plain-English problem
 * string if the row itself could not even be parsed (before `validateTierSet`
 * ever runs). Returns `null` when the row is entirely blank — a blank row is
 * simply "this campaign has fewer than `MAX_TIERS` tiers", not an error.
 */
function parseTierRow(
  formData: FormData,
  rowIndex: number
): { tier: TierDefinition } | { problem: string } | null {
  const tierNumber = rowIndex + 1;
  const unitsRaw = stringField(formData, `tierUnits_${tierNumber}`).trim();
  const percentRaw = stringField(formData, `tierPercentOff_${tierNumber}`).trim();

  if (unitsRaw === "" && percentRaw === "") return null;
  if (unitsRaw === "" || percentRaw === "") {
    return { problem: `tier ${tierNumber}: both qualifying units and percent off are required, or leave both blank to omit this tier` };
  }

  const minQualifyingUnits = Number(unitsRaw);
  if (!Number.isInteger(minQualifyingUnits) || minQualifyingUnits < 1) {
    return { problem: `tier ${tierNumber}: qualifying units must be a positive whole number, got "${unitsRaw}"` };
  }

  if (!PERCENT_PATTERN.test(percentRaw)) {
    return { problem: `tier ${tierNumber}: percent off must be a plain number with up to 4 decimal places (e.g. 10 or 12.5), got "${percentRaw}"` };
  }
  const percentOff = new MoneyDecimal(percentRaw);
  if (percentOff.lessThan(0) || percentOff.greaterThanOrEqualTo(100)) {
    return { problem: `tier ${tierNumber}: percent off must be at least 0 and less than 100, got "${percentRaw}"` };
  }

  // Exact decimal arithmetic — never floating point — matching validateTierSet's own DecimalString expectation.
  // decimal.js's own decimal-places rounding, formatted via toString() rather
  // than Number.prototype's fixed-decimal formatter: the repo-wide
  // money-safety scan flags that lexical pattern everywhere except its one
  // reviewed allow-list entry (scripts/check-money-safety.mjs) — the DB
  // column's own scale, not this string's trailing zeros, is what fixes the
  // stored precision.
  const priceMultiplier = new MoneyDecimal(100).minus(percentOff).dividedBy(100).toDecimalPlaces(6).toString();

  return { tier: { tierNumber, minQualifyingUnits, priceMultiplier } };
}

function parseTierRows(formData: FormData): { tiers: TierDefinition[] } | { problems: readonly string[] } {
  const tiers: TierDefinition[] = [];
  const problems: string[] = [];
  for (let i = 0; i < MAX_TIERS; i++) {
    const result = parseTierRow(formData, i);
    if (result === null) continue;
    if ("problem" in result) problems.push(result.problem);
    else tiers.push(result.tier);
  }
  if (problems.length > 0) return { problems };
  return { tiers };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) {
    logger.error("group_buy_campaigns.no_online_user", {});
    return Response.json(
      fail("This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again."),
      { status: 401 }
    );
  }
  const createdBy = `staff:${associatedUser.id}`;

  const formData = await request.formData();
  const code = stringField(formData, "code").trim();
  const name = stringField(formData, "name").trim();
  const currency = stringField(formData, "currency").trim().toUpperCase();
  const scheduledCloseAtRaw = stringField(formData, "scheduledCloseAt").trim();

  if (code === "" || !/^[a-z0-9-]+$/.test(code)) {
    return Response.json(fail("Campaign code is required and may contain only lowercase letters, numbers, and hyphens."), { status: 400 });
  }
  if (name === "") return Response.json(fail("Campaign name is required."), { status: 400 });
  if (!/^[A-Z]{3}$/.test(currency)) {
    return Response.json(fail("Currency must be a 3-letter ISO 4217 code (e.g. USD)."), { status: 400 });
  }
  let scheduledCloseAt: Date | null = null;
  if (scheduledCloseAtRaw !== "") {
    const parsed = new Date(scheduledCloseAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      return Response.json(fail("Scheduled close, if given, must be a valid date/time."), { status: 400 });
    }
    scheduledCloseAt = parsed;
  }

  const parsedTiers = parseTierRows(formData);
  if ("problems" in parsedTiers) {
    return Response.json(fail("Fix the tier rows below before creating the campaign.", parsedTiers.problems), { status: 400 });
  }

  try {
    const campaign = await createGroupBuyCampaign({
      code,
      name,
      currency,
      createdBy,
      scheduledCloseAt,
      tiers: parsedTiers.tiers,
    });
    return redirect(`/app/group-buy-campaigns/${campaign.id}`);
  } catch (error) {
    if (error instanceof InvalidTierSetError) {
      // Every problem the validator found, verbatim — never collapsed to "invalid tiers".
      return Response.json(fail("The tier set is invalid.", error.problems), { status: 400 });
    }
    // Most likely a duplicate `code` (unique constraint) — surfaced plainly rather than as a 500.
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("unique constraint")) {
      return Response.json(fail(`Campaign code "${code}" is already in use. Choose a different code.`), { status: 409 });
    }
    logger.error("group_buy_campaigns.create_failed", { message });
    throw error;
  }
}

const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };

export default function NewGroupBuyCampaignPage() {
  const { apiKey, shop, minTiers, maxTiers } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const rows = Array.from({ length: maxTiers }, (_, i) => i + 1);

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "40rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/group-buy-campaigns">&larr; Back to Group Buy campaigns</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>New Group Buy campaign (draft)</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. A new campaign starts as a draft — configure eligible variants and the
          campaign-options upload on its detail page, then open it explicitly when ready. Opening freezes pricing
          permanently.
        </p>

        {actionData?.formError ? (
          <div role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
            <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>{actionData.formError}</p>
            {actionData.problems.length > 0 ? (
              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                {actionData.problems.map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <Form method="post">
          <label htmlFor="code" style={labelStyle}>
            Campaign code (lowercase letters, numbers, hyphens — used in the storefront URL)
          </label>
          <input id="code" name="code" type="text" required pattern="[a-z0-9-]+" style={inputStyle} />

          <label htmlFor="name" style={labelStyle}>
            Campaign name
          </label>
          <input id="name" name="name" type="text" required style={inputStyle} />

          <label htmlFor="currency" style={labelStyle}>
            Currency (3-letter ISO code)
          </label>
          <input id="currency" name="currency" type="text" defaultValue="USD" maxLength={3} required style={inputStyle} />

          <label htmlFor="scheduledCloseAt" style={labelStyle}>
            Scheduled close (optional)
          </label>
          <input id="scheduledCloseAt" name="scheduledCloseAt" type="datetime-local" style={inputStyle} />

          <fieldset style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "0.75rem 1rem", marginBottom: "1rem" }}>
            <legend style={{ fontWeight: 600, fontSize: "0.875rem" }}>
              Tiers ({minTiers}-{maxTiers}) — fill in consecutive rows starting at Tier 1; leave trailing rows blank
            </legend>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#555" }}>
              Percent off is applied to the frozen Bank Payment base price at campaign open. Tier 1 must start at 1
              qualifying unit; 0% off is a valid Tier 1 (full price until the next tier unlocks).
            </p>
            {rows.map((tierNumber) => (
              <div key={tierNumber} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", marginBottom: "0.5rem" }}>
                <span style={{ fontSize: "0.875rem", fontWeight: 600, minWidth: "3.5rem" }}>Tier {tierNumber}</span>
                <div>
                  <label htmlFor={`tierUnits_${tierNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                    Qualifying units
                  </label>
                  <input
                    id={`tierUnits_${tierNumber}`}
                    name={`tierUnits_${tierNumber}`}
                    type="text"
                    inputMode="numeric"
                    style={{ ...inputStyle, maxWidth: "8rem", marginBottom: 0 }}
                  />
                </div>
                <div>
                  <label htmlFor={`tierPercentOff_${tierNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                    Percent off
                  </label>
                  <input
                    id={`tierPercentOff_${tierNumber}`}
                    name={`tierPercentOff_${tierNumber}`}
                    type="text"
                    inputMode="decimal"
                    style={{ ...inputStyle, maxWidth: "8rem", marginBottom: 0 }}
                  />
                </div>
              </div>
            ))}
          </fieldset>

          <button type="submit" disabled={busy}>
            Create draft campaign
          </button>
        </Form>
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
