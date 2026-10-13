/**
 * Mode-aware cart pricing domain types (Stage 2B task 2B-1).
 *
 * Grounded in docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md L1 and
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §5, §6, §18, §19.
 *
 * WHY THIS MODULE TAKES ALREADY-DERIVED UNIT PRICES, NOT RAW INPUTS. Tier
 * selection and the $5-ceiling derivation happen exactly once, per variant,
 * in `~/domain/pricing/regularCardPrice.ts`, called from
 * `~/db/repositories/publishedPriceRepository.server.ts`
 * (`getPublishedVariantPrice`). That resolver is closed to this task. This
 * module receives its OUTPUT — one already-tiered Bank Payment Price and one
 * already-tiered Regular/Card Price per line — and does nothing but multiply
 * by quantity and sum. It never re-derives a tier and never imports
 * `regularCardPrice.ts`, so "never re-tiered from the combined subtotal"
 * (owner §5) is true structurally, not just by convention: there is no tier
 * table anywhere in this file to accidentally apply to a sum.
 *
 * Every money-shaped field is a `bigint` minor-units amount. Quantity is also
 * a `bigint` here (not a JS `number`) so multiplying it against a money
 * amount can never cross the bigint/number boundary the money-safety scan
 * exists to catch — see the header comment in scripts/check-money-safety.mjs.
 */

export type CartPaymentMode = "card" | "bank";

/**
 * One cart line's already-resolved merchandise pricing, as looked up by the
 * caller (the App Proxy route) via `getPublishedVariantPrice` plus the
 * variant's own `bankPaymentDiscountEligible` flag. Nothing here is trusted
 * client input — a caller must populate this ONLY from server-resolved data,
 * never from a client-supplied price (criterion 43).
 */
export interface CartLineMerchandiseInput {
  /** Opaque caller-supplied identifier, echoed back so results can be zipped to the request. Never interpreted. */
  readonly lineId: string;
  readonly masterVariantId: string;
  readonly quantity: bigint;
  readonly currency: string;
  /** Owner §18: default ON. An ineligible line stays at Regular/Card Price even in Bank mode. */
  readonly bankPaymentDiscountEligible: boolean;
  /** This line's OWN unit Bank Payment Price, already resolved and tiered upstream. Never a quantity-extended amount. */
  readonly unitBankPaymentPriceMinorUnits: bigint;
  /** This line's OWN unit Regular/Card Price, already derived upstream from the SAME unit Bank Payment Price. */
  readonly unitRegularCardPriceMinorUnits: bigint;
}

export interface PricedCartLine {
  readonly lineId: string;
  readonly masterVariantId: string;
  readonly quantity: bigint;
  readonly currency: string;
  readonly bankPaymentDiscountEligible: boolean;
  readonly unitBankPaymentPriceMinorUnits: bigint;
  readonly unitRegularCardPriceMinorUnits: bigint;
  /**
   * The unit price actually charged in the cart's current mode (owner §19):
   * Card mode -> always the Regular/Card Price.
   * Bank mode -> the Bank Payment Price for an eligible line, otherwise the
   *              Regular/Card Price (owner §18 — ineligible lines never move).
   */
  readonly activeUnitPriceMinorUnits: bigint;
  /** unitRegularCardPriceMinorUnits x quantity — this line's basis under Card mode, regardless of the cart's actual mode. */
  readonly lineCardBasisTotalMinorUnits: bigint;
  /**
   * This line's basis under Bank mode, regardless of the cart's actual mode:
   * eligible -> unitBankPaymentPriceMinorUnits x quantity; ineligible -> equal
   * to lineCardBasisTotalMinorUnits (owner §18, "ineligible lines remain at
   * Regular/Card Price"). Keeping BOTH bases on every line, always, is what
   * lets the cart-level savings figure fall out of a plain subtraction with
   * no separate eligibility branch at the aggregate level.
   */
  readonly lineBankBasisTotalMinorUnits: bigint;
  /** activeUnitPriceMinorUnits x quantity — what this line actually contributes to the cart total right now. */
  readonly lineActiveTotalMinorUnits: bigint;
  /**
   * This line's Bank Payment saving (owner §3 "Cart", §6, §18):
   * lineCardBasisTotalMinorUnits - lineBankBasisTotalMinorUnits, i.e. the
   * line total already extended by quantity. For an ineligible line the two
   * bases are equal by construction (owner §18), so this is exactly zero —
   * never null/absent, because zero is itself the fact a customer comparing
   * lines needs. Summing this field across all lines must equal the cart's
   * own `bankPaymentSavingsMinorUnits`; `pricing.test.ts` asserts that
   * agreement rather than assuming it from the shared arithmetic.
   */
  readonly lineBankPaymentSavingsMinorUnits: bigint;
}

export interface PricedCart {
  readonly mode: CartPaymentMode;
  readonly currency: string;
  readonly lines: readonly PricedCartLine[];
  /** Owner §5: sum of Regular/Card line totals — the Cart Regular/Card Merchandise Total. */
  readonly cardMerchandiseTotalMinorUnits: bigint;
  /** Owner §5: sum of Bank Payment line totals (ineligible lines counted at their Card basis, owner §18) — the Cart Bank Payment Merchandise Total. */
  readonly bankMerchandiseTotalMinorUnits: bigint;
  /**
   * cardMerchandiseTotalMinorUnits - bankMerchandiseTotalMinorUnits.
   * Owner §6: merchandise only — never tax, shipping, insurance or duties,
   * because nothing in this module ever sees those figures to begin with.
   * Owner §18: effectively eligible-lines-only, because an ineligible line's
   * two bases are equal by construction and contributes zero to this figure.
   */
  readonly bankPaymentSavingsMinorUnits: bigint;
  /** Sum of each line's lineActiveTotalMinorUnits — what the cart actually charges in its current mode. */
  readonly activeMerchandiseTotalMinorUnits: bigint;
}
