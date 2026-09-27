import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import {
  applyShipmentSignatureOverride,
  getShipmentForStaff,
  InvalidShipmentAddressChangeError,
  InvalidShipmentInsurancePurchaseError,
  InvalidSignatureOverrideError,
  InvalidSignatureServiceUsedError,
  recordShipmentAddressChange,
  recordShipmentDeliveryConfirmation,
  recordShipmentInsurancePurchase,
  recordShipmentSignatureServiceUsed,
  ShipmentInsuranceNotRecordedError,
  ShipmentNotFoundError,
  verifyShipmentInsuranceCoverage,
  type ShipmentForStaff,
} from "~/db/repositories/shipmentRepository.server";
import {
  decideStandardSignatureRequirementByRule,
  isSignatureServiceUsed,
  UnsupportedSignatureThresholdCurrencyError,
} from "~/domain/shipping/signatureRequirement";
import { Money } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";
import { listInsuranceProviders } from "~/insurance/registry";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/shipments/:id — the staff shipment detail/workflow surface
 * (Slice 11 admin surface, docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md).
 *
 * CALLS THE REPOSITORY; DOES NOT RE-DERIVE ANYTHING. Every mutation below is
 * a thin wrapper around a repository function, which itself calls the pure
 * `app/domain/shipping/**` functions — never reimplemented here. "Rule says"
 * in the Signature section below is the ONE exception: it recomputes
 * `decideStandardSignatureRequirementByRule` from the shipment's own already
 * -stored `computedMerchandiseValueMinorUnits`, for DISPLAY ONLY, so a staff
 * member can see the rule's answer next to what was actually recorded
 * without those ever silently overwriting each other — never persisted,
 * never fed back into any decision.
 *
 * A DEFAULT EXPORT WITH AN ACTION — same shape as `app.warranty-claims.$id.tsx`;
 * see this repo's `csrfResourceRouteFence.test.ts` `EXEMPT_UI_ACTION_ROUTES`
 * for the reasoned exemption entry added for this route.
 *
 * STAFF IDENTITY FROM THE AUTHENTICATED SESSION — D23, same discipline as
 * `app.warranty-claims.$id.tsx`'s `resolveStaffActorRef`. Never a form field.
 *
 * NEVER SHOWS cost, margin, landed cost, or any pricing-profile data — there
 * is none on `Shipment`/`ShipmentAddressChangeEvent`, so nothing needs
 * excluding by hand; `buildShipmentView` below is still an explicit field
 * list, not a raw spread, so that stays legible rather than accidental.
 *
 * THE PROVIDER-ADAPTER SEAM (D32) IS VISIBLE HERE BY WHERE ITS CODE LIVES:
 * this route imports `listInsuranceProviders` from `~/insurance/registry`
 * for the picker and calls `recordShipmentInsurancePurchase` /
 * `verifyShipmentInsuranceCoverage` — it never imports a specific provider
 * module, and carries no provider-specific validation of its own.
 */

// ---------------------------------------------------------------------------
// View model — an explicit field list, never a raw spread of a Prisma row.
// BigInt/Date are stringified at this boundary, same convention as
// `app.warranty-claims.$id.tsx`.
// ---------------------------------------------------------------------------

interface AddressView {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string;
  readonly country: string;
}

interface AddressChangeView {
  readonly id: string;
  readonly from: AddressView;
  readonly to: AddressView;
  readonly reason: string | null;
  readonly actorType: string;
  readonly actorRef: string | null;
  readonly createdAt: string;
}

interface ShipmentView {
  readonly id: string;
  readonly orderRef: string;
  readonly carrier: string;
  readonly service: string | null;
  readonly trackingNumber: string;
  readonly shipDate: string;
  readonly computedMerchandiseValueMinorUnits: string | null;
  readonly computedMerchandiseValueCurrency: string | null;
  readonly insuredValueMinorUnits: string | null;
  readonly insuredValueCurrency: string | null;
  readonly insuranceReference: string | null;
  readonly insuranceProviderId: string | null;
  readonly insuranceCoverageVerifiedAt: string | null;
  readonly insuranceCoverageVerifiedByActorRef: string | null;
  readonly signatureRequired: boolean;
  readonly signatureRequiredSource: string;
  readonly signatureRequiredSetByActorRef: string | null;
  readonly signatureRequiredSetAt: string | null;
  readonly signatureServiceUsed: string | null;
  readonly deliveredAt: string | null;
  readonly deliveryConfirmationReference: string | null;
  readonly proofOfSignatureReference: string | null;
  readonly address: AddressView;
  readonly enteredByActorRef: string;
  readonly enteredAt: string;
  readonly addressChanges: readonly AddressChangeView[];
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function addressView(row: {
  addressLine1: string;
  addressLine2: string | null;
  addressCity: string;
  addressRegion: string | null;
  addressPostalCode: string;
  addressCountry: string;
}): AddressView {
  return {
    line1: row.addressLine1,
    line2: row.addressLine2,
    city: row.addressCity,
    region: row.addressRegion,
    postalCode: row.addressPostalCode,
    country: row.addressCountry,
  };
}

function buildShipmentView(shipment: ShipmentForStaff): ShipmentView {
  return {
    id: shipment.id,
    orderRef: shipment.orderRef,
    carrier: shipment.carrier,
    service: shipment.service,
    trackingNumber: shipment.trackingNumber,
    shipDate: shipment.shipDate.toISOString(),
    computedMerchandiseValueMinorUnits: shipment.computedMerchandiseValueMinorUnits?.toString() ?? null,
    computedMerchandiseValueCurrency: shipment.computedMerchandiseValueCurrency,
    insuredValueMinorUnits: shipment.insuredValueMinorUnits?.toString() ?? null,
    insuredValueCurrency: shipment.insuredValueCurrency,
    insuranceReference: shipment.insuranceReference,
    insuranceProviderId: shipment.insuranceProviderId,
    insuranceCoverageVerifiedAt: iso(shipment.insuranceCoverageVerifiedAt),
    insuranceCoverageVerifiedByActorRef: shipment.insuranceCoverageVerifiedByActorRef,
    signatureRequired: shipment.signatureRequired,
    signatureRequiredSource: shipment.signatureRequiredSource,
    signatureRequiredSetByActorRef: shipment.signatureRequiredSetByActorRef,
    signatureRequiredSetAt: iso(shipment.signatureRequiredSetAt),
    signatureServiceUsed: shipment.signatureServiceUsed,
    deliveredAt: iso(shipment.deliveredAt),
    deliveryConfirmationReference: shipment.deliveryConfirmationReference,
    proofOfSignatureReference: shipment.proofOfSignatureReference,
    address: addressView(shipment),
    enteredByActorRef: shipment.enteredByActorRef,
    enteredAt: shipment.enteredAt.toISOString(),
    addressChanges: shipment.addressChanges.map((event) => ({
      id: event.id,
      from: addressView({
        addressLine1: event.fromAddressLine1,
        addressLine2: event.fromAddressLine2,
        addressCity: event.fromAddressCity,
        addressRegion: event.fromAddressRegion,
        addressPostalCode: event.fromAddressPostalCode,
        addressCountry: event.fromAddressCountry,
      }),
      to: addressView({
        addressLine1: event.toAddressLine1,
        addressLine2: event.toAddressLine2,
        addressCity: event.toAddressCity,
        addressRegion: event.toAddressRegion,
        addressPostalCode: event.toAddressPostalCode,
        addressCountry: event.toAddressCountry,
      }),
      reason: event.reason,
      actorType: event.actorType,
      actorRef: event.actorRef,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

/**
 * "Rule says" — recomputed for DISPLAY ONLY from the shipment's already-
 * stored computed merchandise value, never persisted. `null` when the
 * shipment has no computed value yet, or when it is in a currency the D31
 * threshold does not cover — both are shown as "not available" rather than
 * a crash.
 */
function ruleDecisionForDisplay(view: ShipmentView): { required: boolean } | null {
  if (view.computedMerchandiseValueMinorUnits === null || view.computedMerchandiseValueCurrency === null) return null;
  try {
    const money = Money.fromMinorUnits(BigInt(view.computedMerchandiseValueMinorUnits), view.computedMerchandiseValueCurrency);
    return decideStandardSignatureRequirementByRule(money);
  } catch (error) {
    if (error instanceof UnsupportedSignatureThresholdCurrencyError) return null;
    throw error;
  }
}

/** Visible, not silent — see `app.shipments._index.tsx`'s identical helper. */
function insuredDivergesFromComputed(view: ShipmentView): boolean {
  if (view.insuredValueMinorUnits === null || view.computedMerchandiseValueMinorUnits === null) {
    return view.insuredValueMinorUnits === null && view.computedMerchandiseValueMinorUnits !== null;
  }
  return (
    view.insuredValueMinorUnits !== view.computedMerchandiseValueMinorUnits ||
    view.insuredValueCurrency !== view.computedMerchandiseValueCurrency
  );
}

// ---------------------------------------------------------------------------
// Staff identity — D23, exactly `app.warranty-claims.$id.tsx`'s discipline.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

// ---------------------------------------------------------------------------
// Money parsing — same discipline as `app.warranty-claims.$id.tsx`.
// ---------------------------------------------------------------------------

const MAJOR_UNIT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface ParsedMoney {
  readonly minorUnits: bigint;
  readonly currency: string;
}

function parseMoneyField(amountText: string, currencyText: string, fieldLabel: string): ParsedMoney | { error: string } {
  const amount = amountText.trim();
  const currency = currencyText.trim().toUpperCase();
  if (amount === "") return { error: `${fieldLabel} amount is required.` };
  if (!MAJOR_UNIT_AMOUNT_PATTERN.test(amount)) {
    return { error: `${fieldLabel} amount must be dollars and cents, at most two decimal places, no symbol — e.g. 150 or 150.00.` };
  }
  if (currency === "" || !CURRENCY_PATTERN.test(currency)) {
    return { error: `${fieldLabel} currency must be a 3-letter ISO 4217 code (e.g. USD).` };
  }
  const minorUnits = Money.fromDecimalMajorUnits(amount, currency, DEFAULT_ROUNDING_RULE_ID).amountMinorUnits;
  if (minorUnits <= 0n) return { error: `${fieldLabel} amount must be greater than zero.` };
  return { minorUnits, currency };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface LoaderData {
  apiKey: string;
  shop: string;
  shipment: ShipmentView | null;
  insuranceProviders: readonly { id: string; displayName: string }[];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing shipment id.", { status: 400 });

  const shipment = await getShipmentForStaff(id);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    shipment: shipment ? buildShipmentView(shipment) : null,
    insuranceProviders: listInsuranceProviders().map((provider) => ({ id: provider.id, displayName: provider.displayName })),
  } satisfies LoaderData;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface ActionData {
  ok: boolean;
  formError: string | null;
}

function ok(): ActionData {
  return { ok: true, formError: null };
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

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return Response.json(fail("Missing shipment id."), { status: 400 });
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("shipments.no_online_user", { shipmentId: id });
    return Response.json(
      fail("This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again."),
      { status: 401 }
    );
  }

  const formData = await request.formData();
  const intent = stringField(formData, "intent");

  try {
    switch (intent) {
      case "apply_signature_override": {
        const reason = optionalStringField(formData, "reason");
        await applyShipmentSignatureOverride(id, { overriddenByActorRef: staffActorRef, overriddenAt: new Date(), reason });
        return Response.json(ok());
      }

      case "record_signature_service_used": {
        const serviceUsed = stringField(formData, "serviceUsed");
        if (!isSignatureServiceUsed(serviceUsed)) {
          return Response.json(fail("A recognized signature service (none, standard, or adult_signature_required) is required."), { status: 400 });
        }
        await recordShipmentSignatureServiceUsed(id, serviceUsed);
        return Response.json(ok());
      }

      case "record_delivery_confirmation": {
        const deliveredAtRaw = stringField(formData, "deliveredAt").trim();
        if (!deliveredAtRaw) return Response.json(fail("A delivery date/time is required."), { status: 400 });
        const deliveredAt = new Date(deliveredAtRaw);
        if (Number.isNaN(deliveredAt.getTime())) return Response.json(fail("Delivery date/time is not valid."), { status: 400 });
        await recordShipmentDeliveryConfirmation(id, {
          deliveredAt,
          deliveryConfirmationReference: optionalStringField(formData, "deliveryConfirmationReference"),
          proofOfSignatureReference: optionalStringField(formData, "proofOfSignatureReference"),
        });
        return Response.json(ok());
      }

      case "record_address_change": {
        const to = {
          line1: stringField(formData, "addressLine1").trim(),
          line2: optionalStringField(formData, "addressLine2") ?? null,
          city: stringField(formData, "addressCity").trim(),
          region: optionalStringField(formData, "addressRegion") ?? null,
          postalCode: stringField(formData, "addressPostalCode").trim(),
          country: stringField(formData, "addressCountry").trim(),
        };
        await recordShipmentAddressChange(id, {
          to,
          reason: optionalStringField(formData, "reason") ?? null,
          actorType: "staff",
          actorRef: staffActorRef,
        });
        return Response.json(ok());
      }

      case "record_insurance_purchase": {
        const providerId = stringField(formData, "providerId").trim();
        if (!providerId) return Response.json(fail("An insurance provider is required."), { status: 400 });
        const reference = stringField(formData, "policyOrCertificateReference").trim();
        const parsedValue = parseMoneyField(
          stringField(formData, "coveredValueAmount"),
          stringField(formData, "coveredValueCurrency"),
          "Covered value"
        );
        if ("error" in parsedValue) return Response.json(fail(parsedValue.error), { status: 400 });

        await recordShipmentInsurancePurchase(id, {
          providerId,
          policyOrCertificateReference: reference,
          coveredValueMinorUnits: parsedValue.minorUnits,
          coveredValueCurrency: parsedValue.currency,
        });
        return Response.json(ok());
      }

      case "verify_insurance_coverage": {
        await verifyShipmentInsuranceCoverage(id, { verifiedByActorRef: staffActorRef, verifiedAt: new Date() });
        return Response.json(ok());
      }

      default:
        return Response.json(fail(`Unrecognized action: ${intent}`), { status: 400 });
    }
  } catch (error) {
    if (error instanceof ShipmentNotFoundError) {
      return Response.json(fail("That shipment no longer exists."), { status: 404 });
    }
    if (error instanceof InvalidSignatureOverrideError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof InvalidSignatureServiceUsedError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof InvalidShipmentAddressChangeError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof InvalidShipmentInsurancePurchaseError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof ShipmentInsuranceNotRecordedError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    logger.error("shipments.action_failed", {
      shipmentId: id,
      intent,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso8601: string): string {
  return `${iso8601.replace("T", " ").slice(0, 16)} UTC`;
}

function formatDate(iso8601: string): string {
  return iso8601.slice(0, 10);
}

/** Same discipline as `app.warranty-claims.$id.tsx`'s identical helper — no Number(), no toLocaleString. */
function formatMoney(minorUnits: string | null, currency: string | null): string {
  if (minorUnits === null || currency === null) return "(not recorded)";
  const negative = minorUnits.startsWith("-");
  const digits = negative ? minorUnits.slice(1) : minorUnits;
  const padded = digits.padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${minor}`;
}

function formatAddress(address: AddressView): string {
  const parts = [address.line1, address.line2, address.city, address.region, address.postalCode, address.country].filter(
    (part): part is string => !!part
  );
  return parts.join(", ");
}

const sectionStyle: CSSProperties = { marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" };
const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };

function Field({
  id,
  name,
  label,
  defaultValue,
  type = "text",
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input id={id} name={name} type={type} defaultValue={defaultValue} style={inputStyle} />
    </div>
  );
}

export default function ShipmentDetailPage() {
  const { apiKey, shop, shipment, insuranceProviders } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const ruleDecision = shipment ? ruleDecisionForDisplay(shipment) : null;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "56rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/shipments">&larr; Back to shipments</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Shipment</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!shipment ? (
          <p role="alert" style={{ color: "#b00" }}>
            That shipment was not found.
          </p>
        ) : (
          <>
            {actionData?.formError ? (
              <p role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
                {actionData.formError}
              </p>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>{shipment.orderRef}</h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Carrier">
                  {shipment.carrier}
                  {shipment.service ? ` — ${shipment.service}` : ""}
                </Row>
                <Row label="Tracking number">{shipment.trackingNumber}</Row>
                <Row label="Ship date">{formatDate(shipment.shipDate)}</Row>
                <Row label="Address">{formatAddress(shipment.address)}</Row>
                <Row label="Entered by">
                  {shipment.enteredByActorRef} at {formatTimestamp(shipment.enteredAt)}
                </Row>
              </dl>
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Merchandise value &amp; signature</h2>
              <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                What the domain computed from this shipment&apos;s own contents, alongside what was actually
                recorded — a divergence is informational, never silently overwritten.
              </p>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Computed merchandise value (D29)">
                  {formatMoney(shipment.computedMerchandiseValueMinorUnits, shipment.computedMerchandiseValueCurrency)}
                </Row>
                <Row label="Rule says (recomputed for display only)">
                  {ruleDecision === null ? "not available" : ruleDecision.required ? "signature required" : "signature not required"}
                </Row>
                <Row label="Actually required (recorded)">
                  {shipment.signatureRequired ? "Required" : "Not required"} — source: {shipment.signatureRequiredSource}
                  {shipment.signatureRequiredSource === "staff_override"
                    ? ` (by ${shipment.signatureRequiredSetByActorRef} at ${shipment.signatureRequiredSetAt ? formatTimestamp(shipment.signatureRequiredSetAt) : ""})`
                    : ""}
                </Row>
                <Row label="Signature service actually used">{shipment.signatureServiceUsed ?? "(not recorded)"}</Row>
              </dl>

              {!shipment.signatureRequired || shipment.signatureRequiredSource !== "staff_override" ? (
                <Form method="post" style={{ marginTop: "0.75rem" }}>
                  <input type="hidden" name="intent" value="apply_signature_override" />
                  <Field id="signatureOverrideReason" name="reason" label="Reason for requiring a stricter signature (optional)" />
                  <button type="submit" disabled={busy}>
                    Require signature (staff override — can never waive one)
                  </button>
                </Form>
              ) : null}

              <Form method="post" style={{ marginTop: "0.75rem" }}>
                <input type="hidden" name="intent" value="record_signature_service_used" />
                <label htmlFor="serviceUsed" style={labelStyle}>
                  Record the signature service actually used
                </label>
                <select id="serviceUsed" name="serviceUsed" style={inputStyle} defaultValue={shipment.signatureServiceUsed ?? ""}>
                  <option value="" disabled>
                    Select…
                  </option>
                  <option value="none">None</option>
                  <option value="standard">Standard</option>
                  <option value="adult_signature_required">Adult signature required</option>
                </select>
                <button type="submit" disabled={busy}>
                  Save
                </button>
              </Form>
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Insurance</h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Insured value (recorded)">
                  {formatMoney(shipment.insuredValueMinorUnits, shipment.insuredValueCurrency)}
                  {insuredDivergesFromComputed(shipment) ? (
                    <span style={{ marginLeft: "0.5rem", color: "#b06a00" }}>
                      (differs from the computed merchandise value above)
                    </span>
                  ) : null}
                </Row>
                <Row label="Insurance reference">{shipment.insuranceReference ?? "(not recorded)"}</Row>
                <Row label="Provider">
                  {shipment.insuranceProviderId
                    ? insuranceProviders.find((p) => p.id === shipment.insuranceProviderId)?.displayName ?? shipment.insuranceProviderId
                    : "(none — bare declared value)"}
                </Row>
                <Row label="Coverage verified">
                  {shipment.insuranceCoverageVerifiedAt
                    ? `Yes — by ${shipment.insuranceCoverageVerifiedByActorRef} at ${formatTimestamp(shipment.insuranceCoverageVerifiedAt)}`
                    : "Not verified"}
                </Row>
              </dl>

              <Form method="post" style={{ marginTop: "0.75rem" }}>
                <input type="hidden" name="intent" value="record_insurance_purchase" />
                <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Record externally purchased coverage</h3>
                <label htmlFor="providerId" style={labelStyle}>
                  Provider
                </label>
                <select id="providerId" name="providerId" style={inputStyle} defaultValue="">
                  <option value="" disabled>
                    Select…
                  </option>
                  {insuranceProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
                <Field id="policyOrCertificateReference" name="policyOrCertificateReference" label="Policy/certificate reference" />
                <Field id="coveredValueAmount" name="coveredValueAmount" label="Covered value (dollars and cents)" />
                <Field id="coveredValueCurrency" name="coveredValueCurrency" label="Currency" defaultValue="USD" />
                <button type="submit" disabled={busy}>
                  Save coverage
                </button>
              </Form>

              {shipment.insuranceProviderId && shipment.insuranceReference && !shipment.insuranceCoverageVerifiedAt ? (
                <Form method="post" style={{ marginTop: "0.75rem" }}>
                  <input type="hidden" name="intent" value="verify_insurance_coverage" />
                  <button type="submit" disabled={busy}>
                    Mark coverage verified with provider
                  </button>
                </Form>
              ) : null}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Delivery</h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Delivered at">{shipment.deliveredAt ? formatTimestamp(shipment.deliveredAt) : "(not yet)"}</Row>
                <Row label="Delivery confirmation reference">{shipment.deliveryConfirmationReference ?? "(not recorded)"}</Row>
                <Row label="Proof of signature reference">{shipment.proofOfSignatureReference ?? "(not recorded)"}</Row>
              </dl>
              <Form method="post" style={{ marginTop: "0.75rem" }}>
                <input type="hidden" name="intent" value="record_delivery_confirmation" />
                <Field id="deliveredAt" name="deliveredAt" label="Delivered at" type="datetime-local" />
                <Field id="deliveryConfirmationReference" name="deliveryConfirmationReference" label="Delivery confirmation reference" />
                <Field id="proofOfSignatureReference" name="proofOfSignatureReference" label="Proof of signature reference" />
                <button type="submit" disabled={busy}>
                  Save delivery evidence
                </button>
              </Form>
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Address change</h2>
              {shipment.addressChanges.length === 0 ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#555" }}>No address changes recorded.</p>
              ) : (
                <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem", fontSize: "0.8rem" }}>
                  {shipment.addressChanges.map((change) => (
                    <li key={change.id} style={{ marginBottom: "0.35rem" }}>
                      {formatTimestamp(change.createdAt)} — {change.actorType}
                      {change.actorRef ? ` (${change.actorRef})` : ""}: {formatAddress(change.from)} &rarr;{" "}
                      {formatAddress(change.to)}
                      {change.reason ? ` — ${change.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <Form method="post">
                <input type="hidden" name="intent" value="record_address_change" />
                <Field id="changeAddressLine1" name="addressLine1" label="Address line 1" defaultValue={shipment.address.line1} />
                <Field id="changeAddressLine2" name="addressLine2" label="Address line 2" defaultValue={shipment.address.line2 ?? ""} />
                <Field id="changeAddressCity" name="addressCity" label="City" defaultValue={shipment.address.city} />
                <Field id="changeAddressRegion" name="addressRegion" label="Region/state" defaultValue={shipment.address.region ?? ""} />
                <Field id="changeAddressPostalCode" name="addressPostalCode" label="Postal code" defaultValue={shipment.address.postalCode} />
                <Field id="changeAddressCountry" name="addressCountry" label="Country" defaultValue={shipment.address.country} />
                <Field id="changeReason" name="reason" label="Reason (optional)" />
                <button type="submit" disabled={busy}>
                  Record address change
                </button>
              </Form>
            </section>
          </>
        )}
      </main>
    </AppProvider>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt style={{ display: "inline", fontWeight: 600 }}>{label}: </dt>
      <dd style={{ display: "inline", margin: 0 }}>{children}</dd>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
