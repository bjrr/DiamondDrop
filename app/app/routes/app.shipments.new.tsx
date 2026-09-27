import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties } from "react";

import {
  createShipment,
  InvalidShipmentInsuredValueError,
  InvalidSignatureOverrideError,
  type ShipmentAddress,
  type ShipmentMerchandiseLine,
} from "~/db/repositories/shipmentRepository.server";
import { EmptyShipmentContentsError, InvalidShipmentMerchandiseLineError } from "~/domain/shipping/merchandiseValue";
import { UnsupportedSignatureThresholdCurrencyError } from "~/domain/shipping/signatureRequirement";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";
import { Money } from "~/domain/money/money";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/shipments/new — record a new outbound shipment (Slice 11
 * admin surface, docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md).
 *
 * A DEFAULT EXPORT WITH AN ACTION — see `csrfResourceRouteFence.test.ts`'s
 * `EXEMPT_UI_ACTION_ROUTES` for the reasoned exemption entry added for this
 * route, identical argument to `app.warranty-claims.$id.tsx`: Shopify Admin
 * iframes this route at the app's own host, so a form submitted from within
 * it is same-origin by construction.
 *
 * CONTENT LINES ARE ROW DATA, RENDERED FIXED — same idiom as
 * `app.group-buy-campaigns.new.tsx`'s `MAX_TIERS` rows: this form renders
 * `MAX_CONTENT_LINES` rows and passes whatever staff actually filled in to
 * `computeShipmentMerchandiseValue` (via `createShipment`), never inventing
 * a merchandise value from anything else. No order-line/Shopify fetch here —
 * out of scope for this task (spec §8); staff enter what is physically going
 * in THIS package and its net merchandise selling value directly.
 *
 * WHAT THIS FORM DOES NOT DO: it never asks for or accepts an amount paid,
 * a tender/payment method, a discount applied for choosing one, or a
 * balance due — see `merchandiseValue.ts`'s own header for why. Only
 * quantity + net merchandise value per line + currency.
 *
 * INSURANCE HERE IS THE BARE CASE ONLY (a plain declared value + optional
 * reference, no named provider) — matching `createShipment`'s existing
 * `insuredValueMinorUnits`/`insuranceReference` fields. Recording an
 * externally PURCHASED policy through a named provider (D32) happens
 * afterward on the shipment's own detail page
 * (`app.shipments.$id.tsx`), which is also where verification lives — this
 * keeps every provider-specific concept (`app/app/insurance/**`) out of the
 * one form every shipment goes through, so the adapter boundary stays
 * visible by which file a control lives in, not by convention alone.
 *
 * NEVER SHOWS supplier cost, margin, or landed cost — there is none on this
 * form or in `createShipment`'s input shape.
 */

const MAX_CONTENT_LINES = 6;
const MAJOR_UNIT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface LoaderData {
  apiKey: string;
  shop: string;
  maxContentLines: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    maxContentLines: MAX_CONTENT_LINES,
  } satisfies LoaderData;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
}

function fail(formError: string): ActionData {
  return { ok: false, formError };
}

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
function optionalStringField(formData: FormData, name: string): string | undefined {
  const value = stringField(formData, name).trim();
  return value === "" ? undefined : value;
}

interface ParsedMoney {
  readonly minorUnits: bigint;
  readonly currency: string;
}

/** Same dollars-and-cents discipline as `app.warranty-claims.$id.tsx`'s identical helper — rejected, never rounded, if not exactly representable. */
function parseMoneyField(amountText: string, currencyText: string, fieldLabel: string): ParsedMoney | { error: string } {
  const amount = amountText.trim();
  const currency = currencyText.trim().toUpperCase();
  if (!MAJOR_UNIT_AMOUNT_PATTERN.test(amount)) {
    return { error: `${fieldLabel} amount must be dollars and cents, at most two decimal places, no symbol — e.g. 150 or 150.00.` };
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    return { error: `${fieldLabel} currency must be a 3-letter ISO 4217 code (e.g. USD).` };
  }
  const minorUnits = Money.fromDecimalMajorUnits(amount, currency, DEFAULT_ROUNDING_RULE_ID).amountMinorUnits;
  return { minorUnits, currency };
}

/**
 * One content-line row -> a `ShipmentMerchandiseLine`, or a plain-English
 * problem string, or `null` for an entirely blank row (fewer than
 * `MAX_CONTENT_LINES` lines is normal, not an error) — same three-way shape
 * as `app.group-buy-campaigns.new.tsx`'s `parseTierRow`.
 */
function parseContentLine(formData: FormData, rowNumber: number): { line: ShipmentMerchandiseLine } | { problem: string } | null {
  const quantityRaw = stringField(formData, `contentQuantity_${rowNumber}`).trim();
  const amountRaw = stringField(formData, `contentAmount_${rowNumber}`).trim();
  const currencyRaw = stringField(formData, `contentCurrency_${rowNumber}`).trim();

  if (quantityRaw === "" && amountRaw === "") return null;

  const quantity = Number(quantityRaw);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { problem: `content line ${rowNumber}: quantity must be a positive whole number, got "${quantityRaw}"` };
  }

  const parsedAmount = parseMoneyField(amountRaw, currencyRaw || "USD", `content line ${rowNumber} merchandise value`);
  if ("error" in parsedAmount) return { problem: parsedAmount.error };

  return {
    line: { quantity, merchandiseValueMinorUnits: parsedAmount.minorUnits, currency: parsedAmount.currency },
  };
}

function parseContentLines(formData: FormData): { lines: ShipmentMerchandiseLine[] } | { problems: readonly string[] } {
  const lines: ShipmentMerchandiseLine[] = [];
  const problems: string[] = [];
  for (let i = 1; i <= MAX_CONTENT_LINES; i++) {
    const result = parseContentLine(formData, i);
    if (result === null) continue;
    if ("problem" in result) problems.push(result.problem);
    else lines.push(result.line);
  }
  if (problems.length > 0) return { problems };
  return { lines };
}

function parseAddress(formData: FormData): ShipmentAddress {
  return {
    line1: stringField(formData, "addressLine1").trim(),
    line2: optionalStringField(formData, "addressLine2") ?? null,
    city: stringField(formData, "addressCity").trim(),
    region: optionalStringField(formData, "addressRegion") ?? null,
    postalCode: stringField(formData, "addressPostalCode").trim(),
    country: stringField(formData, "addressCountry").trim(),
  };
}

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("shipments.no_online_user", {});
    return Response.json(
      fail("This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again."),
      { status: 401 }
    );
  }

  const formData = await request.formData();

  const orderRef = stringField(formData, "orderRef").trim();
  const carrier = stringField(formData, "carrier").trim();
  const trackingNumber = stringField(formData, "trackingNumber").trim();
  const shipDateRaw = stringField(formData, "shipDate").trim();
  if (!orderRef || !carrier || !trackingNumber || !shipDateRaw) {
    return Response.json(fail("Order, carrier, tracking number, and ship date are all required."), { status: 400 });
  }
  const shipDate = new Date(shipDateRaw);
  if (Number.isNaN(shipDate.getTime())) {
    return Response.json(fail("Ship date is not a valid date."), { status: 400 });
  }

  const address = parseAddress(formData);
  if (!address.line1 || !address.city || !address.postalCode || !address.country) {
    return Response.json(fail("Address line 1, city, postal code, and country are all required."), { status: 400 });
  }

  const parsedContents = parseContentLines(formData);
  if ("problems" in parsedContents) {
    return Response.json(fail(parsedContents.problems.join(" ")), { status: 400 });
  }

  let insuredValueMinorUnits: bigint | undefined;
  let insuredValueCurrency: string | undefined;
  const insuredValueAmount = stringField(formData, "insuredValueAmount").trim();
  if (insuredValueAmount !== "") {
    const parsed = parseMoneyField(insuredValueAmount, stringField(formData, "insuredValueCurrency"), "Insured value");
    if ("error" in parsed) return Response.json(fail(parsed.error), { status: 400 });
    insuredValueMinorUnits = parsed.minorUnits;
    insuredValueCurrency = parsed.currency;
  }

  const signatureOverrideRequested = stringField(formData, "signatureOverride") === "on";
  const signatureOverrideReason = optionalStringField(formData, "signatureOverrideReason");

  try {
    const shipment = await createShipment({
      orderRef,
      carrier,
      service: optionalStringField(formData, "service"),
      trackingNumber,
      shipDate,
      contents: parsedContents.lines,
      insuredValueMinorUnits,
      insuredValueCurrency,
      insuranceReference: optionalStringField(formData, "insuranceReference"),
      signatureOverride: signatureOverrideRequested
        ? { overriddenByActorRef: staffActorRef, overriddenAt: new Date(), reason: signatureOverrideReason }
        : null,
      address,
      enteredByActorRef: staffActorRef,
    });
    return redirect(`/app/shipments/${shipment.id}`);
  } catch (error) {
    if (error instanceof EmptyShipmentContentsError) {
      return Response.json(fail("At least one content line is required — an empty shipment has no merchandise value."), { status: 400 });
    }
    if (error instanceof InvalidShipmentMerchandiseLineError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof InvalidShipmentInsuredValueError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof InvalidSignatureOverrideError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof UnsupportedSignatureThresholdCurrencyError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    logger.error("shipments.create_failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const sectionStyle: CSSProperties = { marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" };
const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };
const rowStyle: CSSProperties = { display: "flex", gap: "0.5rem", alignItems: "flex-end", marginBottom: "0.5rem" };

function Field({
  id,
  name,
  label,
  defaultValue,
  required,
  type = "text",
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input id={id} name={name} type={type} defaultValue={defaultValue} required={required} style={inputStyle} />
    </div>
  );
}

export default function NewShipmentPage() {
  const { apiKey, shop, maxContentLines } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "56rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/shipments">&larr; Back to shipments</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Record a new shipment</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Record what was actually arranged with the carrier for one outbound
          package.
        </p>

        {actionData?.formError ? (
          <p role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
            {actionData.formError}
          </p>
        ) : null}

        <Form method="post">
          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Shipment</h2>
            <Field id="orderRef" name="orderRef" label="Order reference" required />
            <Field id="carrier" name="carrier" label="Carrier" required />
            <Field id="service" name="service" label="Service level (optional)" />
            <Field id="trackingNumber" name="trackingNumber" label="Tracking number" required />
            <Field id="shipDate" name="shipDate" label="Ship date" type="date" required />
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Contents (net merchandise value only)</h2>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#555" }}>
              What is physically going in this package, and its net merchandise selling value — after merchandise
              discounts, never reduced by tax, shipping, gift cards, store credit, or which payment method the
              customer used. Leave a row blank to omit it.
            </p>
            {Array.from({ length: maxContentLines }, (_, i) => i + 1).map((rowNumber) => (
              <div key={rowNumber} style={rowStyle}>
                <div>
                  <label htmlFor={`contentQuantity_${rowNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                    Qty
                  </label>
                  <input id={`contentQuantity_${rowNumber}`} name={`contentQuantity_${rowNumber}`} type="text" style={{ ...inputStyle, maxWidth: "5rem", marginBottom: 0 }} />
                </div>
                <div>
                  <label htmlFor={`contentAmount_${rowNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                    Merchandise value
                  </label>
                  <input id={`contentAmount_${rowNumber}`} name={`contentAmount_${rowNumber}`} type="text" style={{ ...inputStyle, maxWidth: "9rem", marginBottom: 0 }} />
                </div>
                <div>
                  <label htmlFor={`contentCurrency_${rowNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                    Currency
                  </label>
                  <input id={`contentCurrency_${rowNumber}`} name={`contentCurrency_${rowNumber}`} type="text" defaultValue="USD" maxLength={3} style={{ ...inputStyle, maxWidth: "5rem", marginBottom: 0 }} />
                </div>
              </div>
            ))}
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Address</h2>
            <Field id="addressLine1" name="addressLine1" label="Address line 1" required />
            <Field id="addressLine2" name="addressLine2" label="Address line 2 (optional)" />
            <Field id="addressCity" name="addressCity" label="City" required />
            <Field id="addressRegion" name="addressRegion" label="Region/state (optional)" />
            <Field id="addressPostalCode" name="addressPostalCode" label="Postal code" required />
            <Field id="addressCountry" name="addressCountry" label="Country" required />
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Insurance (bare declared value, optional)</h2>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#555" }}>
              A plain declared value with no named provider — e.g. a carrier&apos;s own declared-value coverage. To
              record an externally purchased policy through a named provider, do that afterward on the
              shipment&apos;s detail page.
            </p>
            <Field id="insuredValueAmount" name="insuredValueAmount" label="Insured value (dollars and cents, optional)" />
            <Field id="insuredValueCurrency" name="insuredValueCurrency" label="Currency" defaultValue="USD" />
            <Field id="insuranceReference" name="insuranceReference" label="Insurance reference (optional)" />
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Signature</h2>
            <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
              Left unchecked, the standard $100 threshold rule decides this automatically from the contents entered
              above. Check this only to require a stricter signature than the rule alone would — this can never
              waive a signature the rule requires.
            </p>
            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
              <input type="checkbox" id="signatureOverride" name="signatureOverride" /> Require signature regardless of the rule
            </label>
            <Field id="signatureOverrideReason" name="signatureOverrideReason" label="Reason (optional)" />
          </section>

          <button type="submit" disabled={busy}>
            Record shipment
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
