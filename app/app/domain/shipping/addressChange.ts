/**
 * Shipment address change — always audited, unconditionally (D-none;
 * README.md "Shipping, Insurance & Signature — MVP1 Locked Direction",
 * docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criteria 176-178).
 *
 * PURE — no database access, no I/O, no ambient clock (`occurredAt` is
 * supplied by the caller, same discipline as
 * `app/domain/warranty/claimStatus.ts`). Unlike the warranty status machine,
 * there is no multi-state graph here: README's rule is unconditional — "any
 * later change is explicitly reviewed/documented," with no threshold, no
 * exception, no amount involved anywhere. So this module only checks that a
 * proposed change record carries what criterion 177 requires (both
 * addresses, in full, and who made the change) before it is persisted to
 * the append-only `ShipmentAddressChangeEvent` table — it does not decide
 * WHETHER a change is allowed, because README never makes that conditional.
 */

export interface ShipmentAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string;
  readonly country: string;
}

export type ShipmentAddressChangeActorType = "staff" | "system" | "customer";

export interface ShipmentAddressChangeInput {
  readonly from: ShipmentAddress;
  readonly to: ShipmentAddress;
  /** Optional — criterion 177 mirrors `AuditEvent.reason`'s own optionality. */
  readonly reason: string | null;
  readonly actorType: ShipmentAddressChangeActorType;
  readonly actorRef: string | null;
}

export type ShipmentAddressChangeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function requiredFieldsPresent(address: ShipmentAddress): boolean {
  return !isBlank(address.line1) && !isBlank(address.city) && !isBlank(address.postalCode) && !isBlank(address.country);
}

function addressesIdentical(a: ShipmentAddress, b: ShipmentAddress): boolean {
  return (
    a.line1 === b.line1 &&
    a.line2 === b.line2 &&
    a.city === b.city &&
    a.region === b.region &&
    a.postalCode === b.postalCode &&
    a.country === b.country
  );
}

/**
 * Validates a proposed address-change record before it is appended.
 * Criterion 177: both the before and after address must be complete (not
 * merely "changed somehow"), and a change must actually change something —
 * recording a no-op "change" would misrepresent the evidence as an event
 * that never occurred.
 */
export function validateShipmentAddressChange(input: ShipmentAddressChangeInput): ShipmentAddressChangeValidationResult {
  if (!requiredFieldsPresent(input.from)) {
    return { ok: false, reason: "the from-address must include line1, city, postalCode, and country" };
  }
  if (!requiredFieldsPresent(input.to)) {
    return { ok: false, reason: "the to-address must include line1, city, postalCode, and country" };
  }
  if (addressesIdentical(input.from, input.to)) {
    return { ok: false, reason: "a shipment address change must actually change the address" };
  }
  if (input.actorType === "staff" && (input.actorRef === null || isBlank(input.actorRef))) {
    return { ok: false, reason: "a staff-attributed address change must record which staff member made it" };
  }
  return { ok: true };
}
