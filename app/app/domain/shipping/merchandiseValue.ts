/**
 * Shipment merchandise value — D29 (docs/ARCHITECTURE-MVP1.md, resolved
 * 2026-09-25), docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criteria 171-173.
 *
 * PURE — no database access, no I/O, no ambient clock. This is the ONE
 * function that answers "order value" for shipping/insurance/signature
 * purposes, now that D29 has defined it: the merchandise selling value of
 * the items and quantities IN THIS SPECIFIC OUTBOUND SHIPMENT, after
 * merchandise discounts, excluding tax, duties, shipping charges, tips and
 * every other non-merchandise charge.
 *
 * TENDER IS NOT VALUE — the clause D29 was most emphatic about, and the one
 * this module's TYPE is built to make hard to violate. Paying with a gift
 * card, store credit, or Bank Payment instead of a card does not make a
 * ring cheaper to replace if it is lost in transit, and a figure that
 * netted the payment method off would under-insure exactly the shipments
 * most worth insuring. `ShipmentMerchandiseLine` below has no field for an
 * amount paid, a discount applied at checkout for choosing a payment
 * method, a tip, or a balance due — there is nothing to pass one to. If you
 * find yourself reaching for an order's charged/paid total to construct
 * this input, you are computing the wrong thing; go back to the order's
 * LINE ITEMS (unit selling price x quantity, net of merchandise discounts
 * only) instead.
 *
 * SPLIT SHIPMENTS ARE VALUED INDEPENDENTLY, STRUCTURALLY. There is no field
 * anywhere in this module for "the whole order" — the caller passes only
 * the lines/quantities physically included in ONE shipment, so a
 * three-package order naturally produces three independent merchandise
 * values with no way to accidentally value one package at the whole
 * order's total. This is what makes `decideStandardSignatureRequirementByRule`
 * (`signatureRequirement.ts`) and any future per-shipment insurance
 * decision correct for split orders without either of those functions
 * needing to know anything about splitting themselves.
 */

import { Money } from "~/domain/money/money";

/**
 * One line's contribution to a SPECIFIC shipment's merchandise value.
 * `merchandiseValueMinorUnits` is already the net selling value for
 * `quantity` units of this line — i.e. (unit selling price x quantity)
 * minus any MERCHANDISE discount, and nothing else. Resolving that number
 * from an order's raw line-item/discount-allocation data is the caller's
 * job (a future repository/route task); this module only sums already-
 * resolved, already-correct figures.
 */
export interface ShipmentMerchandiseLine {
  /** Units of this line physically included in THIS shipment — informational/evidentiary; not used in the arithmetic below, since `merchandiseValueMinorUnits` is already the total for this quantity. Must be a positive integer. */
  readonly quantity: number;
  /** Net merchandise selling value for `quantity` units of this line, in minor units. Never reduced by payment method, gift card, store credit, or tip — see module header. */
  readonly merchandiseValueMinorUnits: bigint;
  readonly currency: string;
}

export class EmptyShipmentContentsError extends Error {
  constructor() {
    super("A shipment's merchandise value requires at least one content line — an empty shipment has no merchandise value to compute.");
    this.name = "EmptyShipmentContentsError";
  }
}

export class InvalidShipmentMerchandiseLineError extends Error {
  constructor(reason: string) {
    super(`Invalid shipment merchandise line: ${reason}`);
    this.name = "InvalidShipmentMerchandiseLineError";
  }
}

/**
 * Sums the merchandise value of every line included in one shipment.
 * Currency mismatches across lines are refused by `Money.add`'s own
 * currency check (`CurrencyMismatchError`) — reused, not reimplemented.
 *
 * Criterion (D29): "integer money arithmetic only" — every input here is
 * already a `bigint` minor-unit amount; this function performs no decimal
 * or floating-point arithmetic anywhere.
 */
export function computeShipmentMerchandiseValue(lines: readonly ShipmentMerchandiseLine[]): Money {
  if (lines.length === 0) {
    throw new EmptyShipmentContentsError();
  }

  let total = Money.zero(lines[0]!.currency);
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InvalidShipmentMerchandiseLineError(`quantity must be a positive integer, got ${line.quantity}`);
    }
    if (line.merchandiseValueMinorUnits < 0n) {
      throw new InvalidShipmentMerchandiseLineError(
        `merchandiseValueMinorUnits must not be negative, got ${line.merchandiseValueMinorUnits}`
      );
    }
    total = total.add(Money.fromMinorUnits(line.merchandiseValueMinorUnits, line.currency));
  }
  return total;
}
