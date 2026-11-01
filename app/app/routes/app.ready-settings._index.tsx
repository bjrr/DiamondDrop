import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  findReadySettingById,
  listReadySettings,
  setReadySettingActive,
  upsertReadySetting,
  type ReadySettingRow,
} from "~/db/repositories/readySettingWrites.server";
import {
  parseReadySettingInput,
  READY_SETTING_SHAPES,
  ReadySettingInputError,
  type FieldErrors,
} from "~/domain/setyourownstone/readySettingInput";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/ready-settings — the operator surface for Set Your Own Stone
 * compatibility metadata.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Owner decision 2026-10-31: "Do not require direct database edits as the
 * normal workflow." Every field the matching rules consult is entered here.
 *
 * That makes this screen the place where a customer's experience of their own
 * diamond is decided. A mistyped nominal width does not produce an error — it
 * produces a confident, wrong "Matches your stone size" for a mounting that
 * cannot hold the stone, and nobody discovers it until a bench does. So the
 * form refuses bad input with an explanation rather than storing it, and
 * every rule it enforces lives in a unit-tested domain module instead of in
 * this file.
 *
 * ============================================================================
 * WHAT THE TWO FLAGS MEAN, BECAUSE THEY ARE EASY TO CONFLATE
 * ============================================================================
 * `eligibleForSetYourOwnStone` — does this mounting take a customer's own
 * stone at all. Off means it is never offered.
 *
 * `prongSetToleranceEligible` — is the setting style reasonably adjustable by
 * prong setting, and so does it get the owner's ±0.3 mm allowance. OFF BY
 * DEFAULT AND DELIBERATELY NARROW: a bezel, channel or tension setting marked
 * eligible would be advertised as a size match for a stone it cannot take.
 * The form says this next to the checkbox, because an operator ticking boxes
 * quickly is exactly who needs to read it.
 *
 * `isActive` — is this record still in force. Withdrawal is a deactivation,
 * never a delete, so past sessions that matched a discontinued mounting still
 * explain themselves.
 */

interface ActionData {
  readonly formError?: string;
  readonly fieldErrors?: FieldErrors;
  readonly saved?: string;
}

/**
 * `staff:<shopify user id>`, from the ONLINE session only — never a form field.
 *
 * Three independent technical barriers stand in front of every write here, and
 * none of them is the staff review step further down the workflow:
 *
 *   1. `authenticate.admin` validates a Shopify session token. A request
 *      without one is redirected to auth and never reaches the action.
 *   2. React Router's `throwIfPotentialCSRFAttack` rejects a mutation whose
 *      Origin differs from this app's own host. Shopify Admin frames this
 *      route at the app's own URL, so its forms are same-origin by
 *      construction while anything cross-origin is refused.
 *   3. This function. An OFFLINE session carries no associated user, and a
 *      write with no staff identity is refused outright rather than recorded
 *      against nobody.
 *
 * The third exists because the first two establish "a valid session for this
 * shop", which is not the same claim as "a known member of staff did this".
 * Compatibility data decides what a customer is told about their own diamond,
 * so an unattributable change to it is not something to accept and sort out
 * afterwards.
 */
function resolveStaffActorRef(
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"]
): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    settings: await listReadySettings(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json({ formError: "Method not allowed." } satisfies ActionData, { status: 405 });
  }

  // Refused BEFORE the body is read, so an unattributable request does no work
  // at all and cannot be distinguished by timing from one that was merely
  // malformed.
  const actorRef = resolveStaffActorRef(session);
  if (!actorRef) {
    logger.warn("ready_setting.write_without_staff_identity", { shop: session.shop });
    return Response.json(
      {
        formError:
          "This change could not be attributed to a staff account. Reopen this page from Shopify Admin and try again.",
      } satisfies ActionData,
      { status: 401 }
    );
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "toggle-active") {
    const id = String(form.get("id") ?? "");
    const existing = id ? await findReadySettingById(id) : null;
    if (!existing) {
      return Response.json({ formError: "That compatibility record no longer exists." } satisfies ActionData);
    }
    const updated = await setReadySettingActive(id, !existing.isActive);
    logger.info("ready_setting.active_toggled", {
      shopifyVariantGid: updated.shopifyVariantGid,
      isActive: updated.isActive,
      actorRef,
      shop: session.shop,
    });
    return Response.json({
      saved: `${updated.shopifyVariantGid} is now ${updated.isActive ? "active" : "inactive"}.`,
    } satisfies ActionData);
  }

  if (intent !== "save") {
    return Response.json({ formError: "Unrecognised action." } satisfies ActionData);
  }

  const fields = Object.fromEntries(form.entries());

  let input;
  try {
    input = parseReadySettingInput(fields);
  } catch (error) {
    if (error instanceof ReadySettingInputError) {
      // Field-keyed, so the operator sees every problem at once rather than
      // discovering them one resubmission at a time.
      return Response.json({
        formError: "Nothing was saved. Correct the fields below and submit again.",
        fieldErrors: error.fieldErrors,
      } satisfies ActionData);
    }
    throw error;
  }

  const saved = await upsertReadySetting(input);
  logger.info("ready_setting.saved", {
    shopifyVariantGid: saved.shopifyVariantGid,
    shape: saved.shape,
    nominalLengthUm: saved.nominalLengthUm,
    nominalWidthUm: saved.nominalWidthUm,
    hasVendorRange: saved.minLengthUm !== null,
    prongSetToleranceEligible: saved.prongSetToleranceEligible,
    eligibleForSetYourOwnStone: saved.eligibleForSetYourOwnStone,
    isActive: saved.isActive,
    actorRef,
    shop: session.shop,
  });

  return Response.json({ saved: `Saved ${saved.shopifyVariantGid}.` } satisfies ActionData);
}

// ----------------------------------------------------------------------- view

const page: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "1.5rem",
  lineHeight: 1.5,
  maxWidth: "64rem",
};
const sectionStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: "6px",
  padding: "1rem 1.25rem",
  margin: "0 0 1.25rem",
};
const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.85rem" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  fontSize: "0.95rem",
  border: "1px solid #bbb",
  borderRadius: "4px",
  boxSizing: "border-box",
};
const errorTextStyle: React.CSSProperties = { color: "#b00", fontSize: "0.8rem", margin: "0.25rem 0 0" };
const rowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" };
const cellStyle: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "0.5rem 0.6rem", textAlign: "left" };
const numericCellStyle: React.CSSProperties = { ...cellStyle, fontVariantNumeric: "tabular-nums" };

/** Micrometres back to a readable millimetre figure. Trailing zeros trimmed:
 *  "10" reads as a nominal size, "10.000" reads as a measurement. */
function mm(um: number | null): string {
  if (um === null) return "—";
  return (um / 1000).toFixed(3).replace(/\.?0+$/, "");
}

function Field({
  name,
  label,
  hint,
  error,
  required,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={name} style={labelStyle}>
        {label}
        {required ? " *" : ""}
      </label>
      <input
        id={name}
        name={name}
        style={error ? { ...inputStyle, borderColor: "#b00", borderWidth: 2 } : inputStyle}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
      />
      {hint ? (
        <p id={`${name}-hint`} style={{ fontSize: "0.78rem", color: "#555", margin: "0.2rem 0 0" }}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${name}-error`} style={errorTextStyle}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Check({ name, label, hint, defaultChecked }: { name: string; label: string; hint: string; defaultChecked?: boolean }) {
  return (
    <div style={{ margin: "0 0 0.75rem" }}>
      <label htmlFor={name} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
        <input id={name} name={name} type="checkbox" defaultChecked={defaultChecked} style={{ marginTop: "0.25rem" }} />
        <span>
          <strong style={{ fontSize: "0.9rem" }}>{label}</strong>
          <br />
          <span style={{ fontSize: "0.8rem", color: "#555" }}>{hint}</span>
        </span>
      </label>
    </div>
  );
}

function SettingsTable({ settings }: { settings: ReadySettingRow[] }) {
  if (settings.length === 0) {
    return (
      <p style={{ color: "#555", margin: 0 }}>
        No ready mountings are recorded yet. Until at least one is, every customer who describes a stone is routed to
        Custom Jewelry — which is correct behaviour, but it is not the feature working.
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.88rem" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Variant</th>
            <th style={cellStyle}>Shape</th>
            <th style={cellStyle}>Nominal L×W×D (mm)</th>
            <th style={cellStyle}>Vendor range (mm)</th>
            <th style={cellStyle}>±0.3 mm</th>
            <th style={cellStyle}>SYOS</th>
            <th style={cellStyle}>Status</th>
          </tr>
        </thead>
        <tbody>
          {settings.map((s) => (
            <tr key={s.id} style={s.isActive ? undefined : { color: "#888" }}>
              <td style={cellStyle}>
                <code style={{ fontSize: "0.8rem" }}>{s.shopifyVariantGid.replace("gid://shopify/ProductVariant/", "")}</code>
              </td>
              <td style={cellStyle}>{s.shape}</td>
              <td style={numericCellStyle}>
                {mm(s.nominalLengthUm)} × {mm(s.nominalWidthUm)}
                {s.nominalDepthUm !== null ? ` × ${mm(s.nominalDepthUm)}` : ""}
              </td>
              <td style={numericCellStyle}>
                {s.minLengthUm === null
                  ? "—"
                  : `${mm(s.minLengthUm)}–${mm(s.maxLengthUm)} × ${mm(s.minWidthUm)}–${mm(s.maxWidthUm)}`}
              </td>
              {/* A vendor range overrides the allowance entirely, so showing
                  "yes" beside one would misdescribe what happens at match
                  time. */}
              <td style={cellStyle}>
                {s.minLengthUm !== null ? "n/a — vendor range" : s.prongSetToleranceEligible ? "yes" : "no"}
              </td>
              <td style={cellStyle}>{s.eligibleForSetYourOwnStone ? "yes" : "no"}</td>
              <td style={cellStyle}>
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="toggle-active" />
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" style={{ font: "inherit", cursor: "pointer" }}>
                    {s.isActive ? "Active — withdraw" : "Inactive — restore"}
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ReadySettingsPage() {
  const { apiKey, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const fieldErrors = actionData?.fieldErrors ?? {};

  return (
    <AppProvider apiKey={apiKey}>
      <main style={page}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.35rem" }}>Set Your Own Stone — ready mountings</h1>
        <p style={{ margin: "0 0 1.25rem", color: "#555" }}>
          Compatibility data for mountings that accept a customer&rsquo;s own stone. These values decide what a customer
          is told about their own diamond, so they are matched on shape and millimetres only — never carat.
        </p>

        {actionData?.formError ? (
          <p role="alert" style={{ color: "#b00", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem", margin: "0 0 1rem" }}>
            {actionData.formError}
          </p>
        ) : null}
        {actionData?.saved ? (
          <p role="status" style={{ border: "1px solid #176", color: "#176", borderRadius: "4px", padding: "0.75rem 1rem", margin: "0 0 1rem" }}>
            {actionData.saved}
          </p>
        ) : null}

        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Recorded mountings</h2>
          <SettingsTable settings={settings} />
        </section>

        <Form method="post">
          <input type="hidden" name="intent" value="save" />

          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>Add or correct a mounting</h2>
            <p style={{ fontSize: "0.82rem", color: "#555", margin: "0 0 0.9rem" }}>
              Saving uses the variant id as the key: entering a variant that is already recorded corrects it rather than
              adding a second row. One row per purchasable configuration.
            </p>

            <div style={{ display: "grid", gap: "0.75rem", marginBottom: "0.75rem" }}>
              <Field
                name="shopifyProductGid"
                label="Shopify product id"
                required
                placeholder="gid://shopify/Product/123456"
                error={fieldErrors.shopifyProductGid}
              />
              <Field
                name="shopifyVariantGid"
                label="Shopify variant id"
                required
                placeholder="gid://shopify/ProductVariant/123456"
                hint="If a design is sold in several centre sizes, each size is its own variant and its own row."
                error={fieldErrors.shopifyVariantGid}
              />
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <label htmlFor="shape" style={labelStyle}>
                Centre-stone shape *
              </label>
              <select
                id="shape"
                name="shape"
                defaultValue=""
                style={fieldErrors.shape ? { ...inputStyle, borderColor: "#b00", borderWidth: 2 } : inputStyle}
                aria-invalid={fieldErrors.shape ? true : undefined}
              >
                <option value="">Choose a shape…</option>
                {READY_SETTING_SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {fieldErrors.shape ? <p style={errorTextStyle}>{fieldErrors.shape}</p> : null}
            </div>

            <h3 style={{ fontSize: "0.9rem", margin: "1rem 0 0.5rem" }}>Nominal centre size</h3>
            <div style={rowStyle}>
              <Field name="nominalLengthMm" label="Length (mm)" required placeholder="10" error={fieldErrors.nominalLengthMm} />
              <Field name="nominalWidthMm" label="Width (mm)" required placeholder="7" error={fieldErrors.nominalWidthMm} />
              <Field name="nominalDepthMm" label="Depth (mm, optional)" placeholder="4.2" error={fieldErrors.nominalDepthMm} />
            </div>

            <h3 style={{ fontSize: "0.9rem", margin: "1.25rem 0 0.25rem" }}>Explicit vendor range (optional)</h3>
            <p style={{ fontSize: "0.82rem", color: "#555", margin: "0 0 0.6rem" }}>
              Only when the manufacturer published one. A vendor range <strong>overrides everything else</strong>,
              including the ±0.3 mm allowance, in both directions — it will refuse a stone the allowance would have
              accepted, and accept one it would have refused. All four bounds, or leave the whole group blank.
            </p>
            <div style={{ ...rowStyle, gridTemplateColumns: "repeat(4, 1fr)" }}>
              <Field name="minLengthMm" label="Min length" placeholder="9.8" error={fieldErrors.minLengthMm} />
              <Field name="maxLengthMm" label="Max length" placeholder="10.3" error={fieldErrors.maxLengthMm} />
              <Field name="minWidthMm" label="Min width" placeholder="6.8" error={fieldErrors.minWidthMm} />
              <Field name="maxWidthMm" label="Max width" placeholder="7.2" error={fieldErrors.maxWidthMm} />
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <Field
                name="vendorRangeSource"
                label="Where the range came from"
                hint="Required when a range is entered — a spec sheet, catalogue page or supplier email. It outranks our own rules, so the claim needs a source."
                error={fieldErrors.vendorRangeSource}
              />
            </div>

            <h3 style={{ fontSize: "0.9rem", margin: "1.25rem 0 0.5rem" }}>Eligibility</h3>
            <Check
              name="eligibleForSetYourOwnStone"
              label="Eligible for Set Your Own Stone"
              hint="Off means this mounting is never offered for a customer-supplied stone."
            />
            <Check
              name="prongSetToleranceEligible"
              label="Prong-adjustable — may use the approved ±0.3 mm allowance"
              hint="Tick only for professional prong-set mountings a bench can adjust during setting. Leave off for bezel, channel, tension and any design that cannot be opened up: a mounting marked here is advertised as a size match up to 0.3 mm from nominal, and the customer's own stone is already in the post by the time a bench finds out otherwise."
            />
            <Check
              name="isActive"
              label="Active"
              defaultChecked
              hint="Untick to withdraw this mounting without deleting the record, so past sessions that matched it still explain themselves."
            />

            <button
              type="submit"
              disabled={busy}
              style={{ font: "inherit", padding: "0.5rem 1.1rem", cursor: busy ? "progress" : "pointer" }}
            >
              {busy ? "Saving…" : "Save mounting"}
            </button>
          </section>
        </Form>

        <p style={{ fontSize: "0.8rem", color: "#555" }}>
          Matching rules: exact nominal, or inside a vendor range, or within ±0.3 mm for a prong-adjustable mounting →
          shown as matching. Over 0.3 mm and up to 1.0 mm → review required. Beyond that → the customer is directed to
          a custom setting. Owner decision 2026-10-31; see <code>docs/SET-YOUR-OWN-STONE.md</code> §6.2.1.
        </p>
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
