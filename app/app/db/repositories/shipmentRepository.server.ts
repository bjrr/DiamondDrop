import type { Prisma, Shipment, ShipmentAddressChangeEvent } from "@prisma/client";

import {
  computeShipmentMerchandiseValue,
  type ShipmentMerchandiseLine,
} from "~/domain/shipping/merchandiseValue";
import { validateInsuredValue } from "~/domain/shipping/insuredValue";
import {
  decideStandardSignatureRequirementByRule,
  isSignatureServiceUsed,
  resolveShipmentSignatureRequirement,
  type SignatureServiceUsed,
  type StaffSignatureOverride,
} from "~/domain/shipping/signatureRequirement";
import {
  validateShipmentAddressChange,
  type ShipmentAddress,
  type ShipmentAddressChangeActorType,
} from "~/domain/shipping/addressChange";
import { validatePurchasedCoverage } from "~/insurance/purchasedCoverage";
import type { InsuranceProviderId, PurchasedInsuranceCoverage } from "~/insurance/port";

import { prisma } from "../client.server";

/**
 * Shipment evidence persistence (D29-D31 wiring, docs/ARCHITECTURE-MVP1.md,
 * resolved 2026-09-25; app/app/domain/shipping/**, committed 7fc17f0).
 *
 * THIS MODULE NEVER RE-DERIVES THE RULE OR THE VALUE COMPUTATION. Every
 * write below computes the D29 merchandise value via
 * `computeShipmentMerchandiseValue`, decides the D31 baseline via
 * `decideStandardSignatureRequirementByRule`, and resolves the actual
 * requirement (rule vs. a recorded staff override) via
 * `resolveShipmentSignatureRequirement` — all three imported, none
 * reimplemented. This file's job is persistence and sequencing: turning a
 * validated domain decision into a committed row, in the right order,
 * inside a transaction where more than one row must agree.
 *
 * G2 IS STILL OPEN (docs/specs/SLICE-11-READINESS.md) — no insurance
 * provider is named for reaching full merchandise value on a high-value
 * piece. `createShipment` never forces `insuredValueMinorUnits` to equal
 * the computed `computedMerchandiseValueMinorUnits`; both are recorded and
 * may differ. See `Shipment.insuredValueMinorUnits`'s doc comment in
 * schema.prisma.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShipmentNotFoundError extends Error {
  constructor(readonly shipmentId: string) {
    super(`No shipment with id ${shipmentId}.`);
    this.name = "ShipmentNotFoundError";
  }
}

/** Mirrors `validateInsuredValue`'s refusal as a typed error — refused BEFORE any write is attempted. */
export class InvalidShipmentInsuredValueError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid shipment insured value: ${reason}`);
    this.name = "InvalidShipmentInsuredValueError";
  }
}

/** Mirrors `resolveShipmentSignatureRequirement`'s refusal as a typed error. */
export class InvalidSignatureOverrideError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid signature override: ${reason}`);
    this.name = "InvalidSignatureOverrideError";
  }
}

export class InvalidSignatureServiceUsedError extends Error {
  constructor(readonly value: string) {
    super(`"${value}" is not a recognized signature service — expected one of none/standard/adult_signature_required.`);
    this.name = "InvalidSignatureServiceUsedError";
  }
}

/** Mirrors `validateShipmentAddressChange`'s refusal as a typed error. */
export class InvalidShipmentAddressChangeError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid shipment address change: ${reason}`);
    this.name = "InvalidShipmentAddressChangeError";
  }
}

/** Mirrors `validatePurchasedCoverage`'s refusal as a typed error (D32) — refused BEFORE any write is attempted. */
export class InvalidShipmentInsurancePurchaseError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid shipment insurance purchase: ${reason}`);
    this.name = "InvalidShipmentInsurancePurchaseError";
  }
}

/** D32 — staff cannot attest to coverage that was never recorded. Mirrors the database's own `shipment_insurance_verification_requires_provider_and_reference` CHECK as a typed error, checked before the write is attempted. */
export class ShipmentInsuranceNotRecordedError extends Error {
  constructor(readonly shipmentId: string) {
    super(`Shipment ${shipmentId} has no recorded insurance provider/reference to verify.`);
    this.name = "ShipmentInsuranceNotRecordedError";
  }
}

// ---------------------------------------------------------------------------
// Create (M-shipment)
// ---------------------------------------------------------------------------

function addressToRow(address: ShipmentAddress) {
  return {
    addressLine1: address.line1,
    addressLine2: address.line2,
    addressCity: address.city,
    addressRegion: address.region,
    addressPostalCode: address.postalCode,
    addressCountry: address.country,
  };
}

function rowToAddress(row: {
  addressLine1: string;
  addressLine2: string | null;
  addressCity: string;
  addressRegion: string | null;
  addressPostalCode: string;
  addressCountry: string;
}): ShipmentAddress {
  return {
    line1: row.addressLine1,
    line2: row.addressLine2,
    city: row.addressCity,
    region: row.addressRegion,
    postalCode: row.addressPostalCode,
    country: row.addressCountry,
  };
}

export interface CreateShipmentInput {
  readonly orderRef: string;
  readonly carrier: string;
  readonly service?: string;
  readonly trackingNumber: string;
  readonly shipDate: Date;
  /** D29 — every line physically included in THIS shipment; required (criterion: a shipment must know its own contents to have a merchandise value). */
  readonly contents: readonly ShipmentMerchandiseLine[];
  readonly insuredValueMinorUnits?: bigint;
  readonly insuredValueCurrency?: string;
  readonly insuranceReference?: string;
  /** Recorded upfront if staff already knows the shipment needs a stricter service than the rule would produce. Optional — most shipments have none at creation. */
  readonly signatureOverride?: StaffSignatureOverride | null;
  readonly address: ShipmentAddress;
  readonly enteredByActorRef: string;
}

/**
 * Computes the D29 merchandise value and the D31 signature requirement
 * (rule, or a recorded override) from `input`, validates the insured-value
 * fields, and writes one `Shipment` row. Every domain refusal is surfaced
 * as a typed error BEFORE the insert is attempted — nothing partial is ever
 * written.
 */
export async function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  if (!input.enteredByActorRef.trim()) {
    throw new Error("createShipment requires enteredByActorRef — a shipment row is staff's record, never anonymous.");
  }

  // D29 — throws EmptyShipmentContentsError / InvalidShipmentMerchandiseLineError
  // / CurrencyMismatchError on refusal; none of those are caught here, since
  // this module does not decide what a refusal means, only that nothing
  // gets written when one occurs.
  const merchandiseValue = computeShipmentMerchandiseValue(input.contents);

  // Both-or-neither is exactly what validateInsuredValue's discriminated
  // union enforces at the type level; a caller-supplied pair that does not
  // fit either shape (an amount with no currency, or vice versa) is refused
  // directly, before ever reaching that function.
  const insuredValueMinorUnits = input.insuredValueMinorUnits ?? null;
  const insuredValueCurrency = input.insuredValueCurrency ?? null;
  if ((insuredValueMinorUnits === null) !== (insuredValueCurrency === null)) {
    throw new InvalidShipmentInsuredValueError(
      "insuredValueMinorUnits and insuredValueCurrency must be provided together or not at all"
    );
  }
  const insuredValueCheck =
    insuredValueMinorUnits === null
      ? validateInsuredValue({ insuredValueMinorUnits: null, currency: null })
      : validateInsuredValue({ insuredValueMinorUnits, currency: insuredValueCurrency! });
  if (!insuredValueCheck.ok) {
    throw new InvalidShipmentInsuredValueError(insuredValueCheck.reason);
  }

  // D31 — throws UnsupportedSignatureThresholdCurrencyError for a non-USD
  // merchandise value rather than inventing a conversion; not caught here.
  const ruleDecision = decideStandardSignatureRequirementByRule(merchandiseValue);
  const resolved = resolveShipmentSignatureRequirement(ruleDecision, input.signatureOverride ?? null);
  if (!resolved.ok) {
    throw new InvalidSignatureOverrideError(resolved.reason);
  }

  return prisma.shipment.create({
    data: {
      orderRef: input.orderRef,
      carrier: input.carrier,
      service: input.service ?? null,
      trackingNumber: input.trackingNumber,
      shipDate: input.shipDate,
      computedMerchandiseValueMinorUnits: merchandiseValue.amountMinorUnits,
      computedMerchandiseValueCurrency: merchandiseValue.currency,
      insuredValueMinorUnits: input.insuredValueMinorUnits ?? null,
      insuredValueCurrency: input.insuredValueCurrency ?? null,
      insuranceReference: input.insuranceReference ?? null,
      signatureRequired: resolved.value.required,
      signatureRequiredSource: resolved.value.source,
      signatureRequiredSetByActorRef: resolved.value.override?.overriddenByActorRef ?? null,
      signatureRequiredSetAt: resolved.value.override?.overriddenAt ?? null,
      enteredByActorRef: input.enteredByActorRef,
      ...addressToRow(input.address),
    },
  });
}

// ---------------------------------------------------------------------------
// Signature — a recorded override, and the service actually used
// ---------------------------------------------------------------------------

/**
 * Upgrades an existing shipment's signature requirement to a staff
 * override. `ruleDecision` is irrelevant to the outcome whenever `override`
 * is non-null (`resolveShipmentSignatureRequirement`'s own contract: an
 * override always wins) — passed as `{ required: false }` here rather than
 * re-fetching/recomputing the merchandise value for a result that would be
 * discarded either way.
 */
export async function applyShipmentSignatureOverride(
  shipmentId: string,
  override: StaffSignatureOverride
): Promise<Shipment> {
  const existing = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true } });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);

  const resolved = resolveShipmentSignatureRequirement({ required: false }, override);
  if (!resolved.ok) {
    throw new InvalidSignatureOverrideError(resolved.reason);
  }

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      signatureRequired: resolved.value.required,
      signatureRequiredSource: resolved.value.source,
      signatureRequiredSetByActorRef: override.overriddenByActorRef,
      signatureRequiredSetAt: override.overriddenAt,
    },
  });
}

/**
 * Records the signature service ACTUALLY USED — evidence, never derived
 * (see `signatureRequirement.ts`'s own header). May differ from
 * `signatureRequired`/`signatureRequiredSource`; this function does not
 * compare the two or refuse a mismatch, because a mismatch is exactly the
 * fact this column exists to capture.
 */
export async function recordShipmentSignatureServiceUsed(
  shipmentId: string,
  serviceUsed: string
): Promise<Shipment> {
  if (!isSignatureServiceUsed(serviceUsed)) {
    throw new InvalidSignatureServiceUsedError(serviceUsed);
  }
  const existing = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true } });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: { signatureServiceUsed: serviceUsed satisfies SignatureServiceUsed },
  });
}

// ---------------------------------------------------------------------------
// Address changes (criteria 176-178) — append-only history, current row updated
// ---------------------------------------------------------------------------

export interface RecordShipmentAddressChangeInput {
  readonly to: ShipmentAddress;
  readonly reason?: string | null;
  readonly actorType: ShipmentAddressChangeActorType;
  readonly actorRef: string | null;
}

/**
 * The "from" address is read from the shipment's OWN current row — never
 * supplied by the caller — so a caller cannot misrepresent what the address
 * was before the change. Validates via `validateShipmentAddressChange`
 * (both addresses complete, actually different, staff changes attributed)
 * BEFORE writing anything, then in one transaction: appends the
 * `ShipmentAddressChangeEvent` row and updates the shipment's current
 * address fields to `to`. The event is append-only at the database level
 * (migration 20260925020000); nothing here relies on application discipline
 * alone for that guarantee.
 */
export async function recordShipmentAddressChange(
  shipmentId: string,
  input: RecordShipmentAddressChangeInput
): Promise<{ shipment: Shipment; event: ShipmentAddressChangeEvent }> {
  const existing = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);

  const from = rowToAddress(existing);
  const validation = validateShipmentAddressChange({
    from,
    to: input.to,
    reason: input.reason ?? null,
    actorType: input.actorType,
    actorRef: input.actorRef,
  });
  if (!validation.ok) {
    throw new InvalidShipmentAddressChangeError(validation.reason);
  }

  return prisma.$transaction(async (tx) => {
    const event = await tx.shipmentAddressChangeEvent.create({
      data: {
        shipmentId,
        fromAddressLine1: from.line1,
        fromAddressLine2: from.line2,
        fromAddressCity: from.city,
        fromAddressRegion: from.region,
        fromAddressPostalCode: from.postalCode,
        fromAddressCountry: from.country,
        toAddressLine1: input.to.line1,
        toAddressLine2: input.to.line2,
        toAddressCity: input.to.city,
        toAddressRegion: input.to.region,
        toAddressPostalCode: input.to.postalCode,
        toAddressCountry: input.to.country,
        reason: input.reason ?? null,
        actorType: input.actorType,
        actorRef: input.actorRef,
      },
    });
    const shipment = await tx.shipment.update({
      where: { id: shipmentId },
      data: addressToRow(input.to),
    });
    return { shipment, event };
  });
}

// ---------------------------------------------------------------------------
// Delivery evidence (criterion 171 "delivery evidence") — what the carrier
// confirmed, recorded by staff. Mutable in place, same as every other
// evidence field on `Shipment` itself (see this table's own doc comment in
// schema.prisma) — the append-only guarantee applies to
// `ShipmentAddressChangeEvent`, not to this row.
// ---------------------------------------------------------------------------

export interface RecordShipmentDeliveryConfirmationInput {
  readonly deliveredAt: Date;
  readonly deliveryConfirmationReference?: string;
  /** What the carrier actually captured as proof of signature, if any — evidence, independent of `signatureRequired`/`signatureServiceUsed`. */
  readonly proofOfSignatureReference?: string;
}

export async function recordShipmentDeliveryConfirmation(
  shipmentId: string,
  input: RecordShipmentDeliveryConfirmationInput
): Promise<Shipment> {
  const existing = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true } });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      deliveredAt: input.deliveredAt,
      deliveryConfirmationReference: input.deliveryConfirmationReference ?? null,
      proofOfSignatureReference: input.proofOfSignatureReference ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Insurance — D32 provider-adapter seam. THIS MODULE NEVER RE-DERIVES the
// provider/reference/money validation: every write below goes through
// `validatePurchasedCoverage` (app/app/insurance/**), which is the only code
// in this call path that knows what a provider or a well-formed reference
// is. Recording a NEW purchase clears any prior verification — an
// attestation about a reference/value that just changed is stale evidence,
// never carried forward silently.
// ---------------------------------------------------------------------------

export interface RecordShipmentInsurancePurchaseInput {
  readonly providerId: InsuranceProviderId;
  readonly policyOrCertificateReference: string;
  readonly coveredValueMinorUnits: bigint;
  readonly coveredValueCurrency: string;
}

export async function recordShipmentInsurancePurchase(
  shipmentId: string,
  input: RecordShipmentInsurancePurchaseInput
): Promise<Shipment> {
  const existing = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true } });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);

  const coverage: PurchasedInsuranceCoverage = {
    providerId: input.providerId,
    policyOrCertificateReference: input.policyOrCertificateReference,
    coveredValueMinorUnits: input.coveredValueMinorUnits,
    coveredValueCurrency: input.coveredValueCurrency,
  };
  const validation = validatePurchasedCoverage(coverage);
  if (!validation.ok) {
    throw new InvalidShipmentInsurancePurchaseError(validation.reason);
  }

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      insuranceProviderId: input.providerId,
      insuranceReference: input.policyOrCertificateReference,
      insuredValueMinorUnits: input.coveredValueMinorUnits,
      insuredValueCurrency: input.coveredValueCurrency,
      // A new purchase invalidates any earlier attestation — see header.
      insuranceCoverageVerifiedAt: null,
      insuranceCoverageVerifiedByActorRef: null,
    },
  });
}

export interface VerifyShipmentInsuranceCoverageInput {
  readonly verifiedByActorRef: string;
  readonly verifiedAt: Date;
}

/**
 * Records staff's attestation that they confirmed, with the provider, that
 * the recorded reference actually covers the recorded insured value (D32 —
 * "MVP1 may record and verify externally purchased coverage"). Refuses
 * BEFORE writing when no provider/reference is on record at all — mirrors
 * `shipment_insurance_verification_requires_provider_and_reference` at the
 * application layer, same discipline as `validateInsuredValue`'s mirroring
 * of its own CHECK constraint.
 */
export async function verifyShipmentInsuranceCoverage(
  shipmentId: string,
  input: VerifyShipmentInsuranceCoverageInput
): Promise<Shipment> {
  const existing = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, insuranceProviderId: true, insuranceReference: true },
  });
  if (!existing) throw new ShipmentNotFoundError(shipmentId);
  if (!existing.insuranceProviderId || !existing.insuranceReference) {
    throw new ShipmentInsuranceNotRecordedError(shipmentId);
  }
  if (input.verifiedByActorRef.trim().length === 0) {
    throw new Error("verifyShipmentInsuranceCoverage requires verifiedByActorRef — an attestation is staff's, never anonymous.");
  }

  return prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      insuranceCoverageVerifiedAt: input.verifiedAt,
      insuranceCoverageVerifiedByActorRef: input.verifiedByActorRef,
    },
  });
}

// ---------------------------------------------------------------------------
// Read — one shipment, with its full address-change history, for staff
// ---------------------------------------------------------------------------

export interface ShipmentForStaff extends Shipment {
  readonly addressChanges: readonly ShipmentAddressChangeEvent[];
}

/** Criterion 170-equivalent for shipments: the complete record — every column plus the full address-change history — in one query. */
export async function getShipmentForStaff(shipmentId: string): Promise<ShipmentForStaff | null> {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { addressChanges: { orderBy: { createdAt: "asc" } } },
  }) as Promise<ShipmentForStaff | null>;
}

// ---------------------------------------------------------------------------
// Search/list — staff triage surface. Explicit `select`, never a raw spread
// or `include` of the full row: `Shipment` carries no cost/margin data
// today, but a list route should not depend on that staying true forever —
// same discipline as `warrantyClaimRepository.server.ts`'s
// `searchWarrantyClaimsForStaff`.
// ---------------------------------------------------------------------------

const SHIPMENT_STAFF_LIST_DEFAULT_PAGE_SIZE = 25;
const SHIPMENT_STAFF_LIST_MAX_PAGE_SIZE = 100;

const SHIPMENT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SearchShipmentsForStaffInput {
  /** Matched (case-insensitive, substring) against order ref, tracking number, and carrier; matched exactly against `id` when it looks like a UUID. */
  readonly query?: string;
  /** 1-based. Defaults to 1. */
  readonly page?: number;
  /** Defaults to 25, capped at 100 regardless of what is requested. */
  readonly pageSize?: number;
}

const STAFF_SHIPMENT_LIST_SELECT = {
  id: true,
  orderRef: true,
  carrier: true,
  trackingNumber: true,
  shipDate: true,
  signatureRequired: true,
  signatureRequiredSource: true,
  computedMerchandiseValueMinorUnits: true,
  computedMerchandiseValueCurrency: true,
  insuredValueMinorUnits: true,
  insuredValueCurrency: true,
  insuranceProviderId: true,
  insuranceCoverageVerifiedAt: true,
  deliveredAt: true,
} satisfies Prisma.ShipmentSelect;

export type ShipmentStaffListRow = Prisma.ShipmentGetPayload<{ select: typeof STAFF_SHIPMENT_LIST_SELECT }>;

export interface SearchShipmentsForStaffResult {
  readonly rows: readonly ShipmentStaffListRow[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** Ordered most-recently-shipped-first — the staff triage list's natural order. */
export async function searchShipmentsForStaff(
  input: SearchShipmentsForStaffInput = {}
): Promise<SearchShipmentsForStaffResult> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(SHIPMENT_STAFF_LIST_MAX_PAGE_SIZE, Math.max(1, input.pageSize ?? SHIPMENT_STAFF_LIST_DEFAULT_PAGE_SIZE));

  const where: Prisma.ShipmentWhereInput = {};
  const trimmedQuery = input.query?.trim();
  if (trimmedQuery) {
    const orConditions: Prisma.ShipmentWhereInput[] = [
      { orderRef: { contains: trimmedQuery, mode: "insensitive" } },
      { trackingNumber: { contains: trimmedQuery, mode: "insensitive" } },
      { carrier: { contains: trimmedQuery, mode: "insensitive" } },
    ];
    if (SHIPMENT_UUID_PATTERN.test(trimmedQuery)) {
      orConditions.push({ id: trimmedQuery });
    }
    where.OR = orConditions;
  }

  const [rows, totalCount] = await Promise.all([
    prisma.shipment.findMany({
      where,
      select: STAFF_SHIPMENT_LIST_SELECT,
      orderBy: [{ shipDate: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.shipment.count({ where }),
  ]);

  return { rows, totalCount, page, pageSize };
}

// Re-exported so a caller building `contents`/`address`/`override` inputs
// does not need to import from app/domain/shipping directly just to get the
// types this module's own function signatures already reference.
export type { ShipmentMerchandiseLine, ShipmentAddress, StaffSignatureOverride, SignatureServiceUsed };
