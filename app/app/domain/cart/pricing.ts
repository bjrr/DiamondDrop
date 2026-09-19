import type {
  CartLineMerchandiseInput,
  CartPaymentMode,
  PricedCart,
  PricedCartLine,
} from "./types";

/**
 * The mode-aware cart pricing core (Stage 2B task 2B-1, L1).
 *
 * Pure, synchronous, no I/O. Every input is already-resolved server data —
 * see the header comment in ./types.ts for why this module never imports
 * `~/domain/pricing/regularCardPrice.ts` and never re-derives a tier.
 */

export class CartCurrencyMismatchError extends Error {
  constructor(expected: string, actual: string, lineId: string) {
    super(`Cart line "${lineId}" has currency "${actual}", expected "${expected}".`);
    this.name = "CartCurrencyMismatchError";
  }
}

export class InvalidCartLineQuantityError extends Error {
  constructor(lineId: string, quantity: bigint) {
    super(`Cart line "${lineId}" has invalid quantity ${quantity.toString()}; quantity must be a positive integer.`);
    this.name = "InvalidCartLineQuantityError";
  }
}

/**
 * Prices ONE cart line under the given mode. §5 steps 1-3, already performed
 * upstream for THIS line's own unit prices — this function's only job is
 * step "then": multiply by quantity, strictly after (never before or
 * instead of) tier derivation, which happened elsewhere.
 */
export function priceCartLine(mode: CartPaymentMode, line: CartLineMerchandiseInput): PricedCartLine {
  if (line.quantity <= 0n) {
    throw new InvalidCartLineQuantityError(line.lineId, line.quantity);
  }

  const lineCardBasisTotalMinorUnits = line.unitRegularCardPriceMinorUnits * line.quantity;

  // Owner §18: an ineligible line's Bank-mode basis is its Card basis,
  // unchanged — it never moves, in either mode.
  const lineBankBasisTotalMinorUnits = line.bankPaymentDiscountEligible
    ? line.unitBankPaymentPriceMinorUnits * line.quantity
    : lineCardBasisTotalMinorUnits;

  // Owner §19: Card mode always charges the Regular/Card Price. Bank mode
  // charges the Bank Payment Price only for an eligible line.
  const activeUnitPriceMinorUnits =
    mode === "bank" && line.bankPaymentDiscountEligible
      ? line.unitBankPaymentPriceMinorUnits
      : line.unitRegularCardPriceMinorUnits;

  const lineActiveTotalMinorUnits = activeUnitPriceMinorUnits * line.quantity;

  return {
    lineId: line.lineId,
    masterVariantId: line.masterVariantId,
    quantity: line.quantity,
    currency: line.currency,
    bankPaymentDiscountEligible: line.bankPaymentDiscountEligible,
    unitBankPaymentPriceMinorUnits: line.unitBankPaymentPriceMinorUnits,
    unitRegularCardPriceMinorUnits: line.unitRegularCardPriceMinorUnits,
    activeUnitPriceMinorUnits,
    lineCardBasisTotalMinorUnits,
    lineBankBasisTotalMinorUnits,
    lineActiveTotalMinorUnits,
  };
}

export interface PriceCartInput {
  readonly mode: CartPaymentMode;
  /** The cart's currency. Every line must match it (single-currency store; checked defensively rather than assumed). */
  readonly currency: string;
  readonly lines: readonly CartLineMerchandiseInput[];
}

/**
 * Prices an entire cart. Owner §5, "then": sums the already-priced lines. NO
 * re-tiering happens here, and there is no code path in this function that
 * could re-tier — it only ever adds bigints already produced by
 * `priceCartLine`. Line order never affects the result (plain commutative
 * bigint addition).
 */
export function priceCart(input: PriceCartInput): PricedCart {
  const { mode, currency, lines } = input;

  const priced: PricedCartLine[] = [];
  let cardMerchandiseTotalMinorUnits = 0n;
  let bankMerchandiseTotalMinorUnits = 0n;
  let activeMerchandiseTotalMinorUnits = 0n;

  for (const line of lines) {
    if (line.currency !== currency) {
      throw new CartCurrencyMismatchError(currency, line.currency, line.lineId);
    }
    const pricedLine = priceCartLine(mode, line);
    priced.push(pricedLine);
    cardMerchandiseTotalMinorUnits += pricedLine.lineCardBasisTotalMinorUnits;
    bankMerchandiseTotalMinorUnits += pricedLine.lineBankBasisTotalMinorUnits;
    activeMerchandiseTotalMinorUnits += pricedLine.lineActiveTotalMinorUnits;
  }

  return {
    mode,
    currency,
    lines: priced,
    cardMerchandiseTotalMinorUnits,
    bankMerchandiseTotalMinorUnits,
    // Owner §6: merchandise-only by construction — this module never
    // receives tax, shipping, insurance or duties to begin with.
    bankPaymentSavingsMinorUnits: cardMerchandiseTotalMinorUnits - bankMerchandiseTotalMinorUnits,
    activeMerchandiseTotalMinorUnits,
  };
}
