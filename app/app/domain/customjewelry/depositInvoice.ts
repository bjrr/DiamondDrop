import { Money } from "~/domain/money/money";

import {
  CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
  CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
} from "./designDepositAcknowledgmentText";

/**
 * Pure decisions about a Design Deposit invoice — no database, no Shopify.
 *
 * The one rule worth isolating here is that the invoice amount must equal
 * what the customer actually authorized, and that this is checked against the
 * ACCEPTANCE ROW rather than against the current constant. Those are
 * different questions: the constant is what we charge today, the acceptance
 * is what this customer agreed to. If the deposit price ever changes, every
 * outstanding acceptance was made at the old figure, and invoicing it at the
 * new one would charge a sum nobody agreed to.
 */

/** Raised when an invoice would ask for an amount the customer never authorized. */
export class DepositAmountMismatchError extends Error {
  constructor(
    readonly authorized: { amountMinorUnits: bigint; currency: string },
    readonly attempted: { amountMinorUnits: bigint; currency: string }
  ) {
    super(
      `refusing to invoice ${attempted.amountMinorUnits} ${attempted.currency} against an acceptance for ` +
        `${authorized.amountMinorUnits} ${authorized.currency} — a deposit invoice must ask for exactly what the ` +
        `customer authorized`
    );
    this.name = "DepositAmountMismatchError";
  }
}

export interface AuthorizedDeposit {
  readonly amountMinorUnits: bigint;
  readonly currency: string;
}

/**
 * The amount to invoice, taken FROM THE ACCEPTANCE.
 *
 * Deliberately returns the acceptance's own figure rather than the current
 * constant — see this module's header. The comparison against the constant
 * still happens, but as a MISMATCH CHECK rather than as the source: if the
 * two have diverged, that is a price change that needs a fresh acceptance,
 * not an invoice quietly issued at either figure.
 */
export function resolveDepositInvoiceAmount(acceptance: AuthorizedDeposit): Money {
  const current = {
    amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
    currency: CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
  };

  if (
    acceptance.amountMinorUnits !== current.amountMinorUnits ||
    acceptance.currency !== current.currency
  ) {
    // Refuses in BOTH directions on purpose. Invoicing more than was
    // authorized is obviously wrong; invoicing less is also wrong, because it
    // means the record of what the customer agreed to no longer describes
    // what we are doing to them. Either way a human needs to look.
    throw new DepositAmountMismatchError(acceptance, current);
  }

  return Money.fromMinorUnits(acceptance.amountMinorUnits, acceptance.currency);
}

/**
 * The line title the customer sees on the Shopify invoice.
 *
 * Carries the project reference so a customer with more than one enquiry can
 * tell which deposit they are paying, and so a payment can be reconciled by
 * eye from the Shopify admin without opening this app.
 */
export function depositInvoiceLineTitle(projectReference: string): string {
  return `Custom Jewelry Design Deposit — ${projectReference}`;
}

/**
 * The tag that marks an order as a Design Deposit. It is what makes these
 * orders findable as a class in the Shopify admin and distinguishable from
 * Buy Now, Group Buy and Luxury Steals orders by anything reading the order
 * stream.
 *
 * EXPORTED because the `orders/paid` handler keys on it: a literal in two
 * places is two places that can drift, and the handler silently ignoring every
 * deposit order is exactly the failure that would cause.
 */
export const CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG = "carat-design-deposit";

/** The per-project tag prefix. Same reasoning as the class tag. */
export const CUSTOM_JEWELRY_DEPOSIT_PROJECT_TAG_PREFIX = "carat-project-";

export function depositInvoiceTags(projectReference: string): readonly string[] {
  return [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `${CUSTOM_JEWELRY_DEPOSIT_PROJECT_TAG_PREFIX}${projectReference}`];
}
