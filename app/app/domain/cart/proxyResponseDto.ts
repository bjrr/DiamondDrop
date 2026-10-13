import type { CartPaymentMode, PricedCart, PricedCartLine } from "./types";

/**
 * The App Proxy response shape — ruling R10
 * (docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md).
 *
 * THE HAZARD THIS CLOSES. `PublishedVariantPrice`
 * (`~/db/repositories/publishedPriceRepository.server.ts`) carries
 * `appliedUpliftRate` and `appliedTierLabel`, both marked INTERNAL ONLY —
 * audit/admin fields, never customer-facing. `PricedCart`/`PricedCartLine`
 * in ./types.ts never carry those two fields at all (this module's own
 * domain layer has no tier rate or tier label anywhere on it), but a caller
 * one route away from `getPublishedVariantPrice` is exactly the kind of code
 * that gets edited later by someone who reaches for `...published` out of
 * habit. This module is the fence: every field that reaches an App Proxy
 * response is named explicitly, by hand, below. There is no spread operator
 * anywhere in this file.
 *
 * STRUCTURALLY ABSENT, NOT DELETED. `CartProxyLineDto`'s `purchasable: false`
 * branch has NO price fields in its TYPE — not fields set to `undefined`,
 * fields that DO NOT EXIST on that branch. A future edit that tries to add a
 * price to an unpurchasable line fails to compile rather than silently
 * serializing one.
 *
 * MONEY AS STRINGS, QUANTITY AS A STRING TOO. Every bigint in this module
 * crosses to JSON as a decimal string via `.toString()` — `JSON.stringify`
 * cannot serialize a bigint at all (it throws), and this module deliberately
 * has no `Number(...)` call anywhere (money-safety scan, Tier 2 discipline
 * extended to this directory even though quantity itself is a count, not
 * money — see the Stage 2B task brief). The theme parses the decimal string
 * client-side; that parse is display-only and does not re-derive a price.
 */

export interface CartProxyPricedLineDto {
  readonly lineId: string;
  readonly shopifyVariantId: string;
  readonly quantity: string;
  readonly purchasable: true;
  readonly bankPaymentDiscountEligible: boolean;
  readonly unitBankPaymentPriceMinorUnits: string;
  readonly unitRegularCardPriceMinorUnits: string;
  readonly activeUnitPriceMinorUnits: string;
  readonly lineActiveTotalMinorUnits: string;
  /** unitRegularCardPriceMinorUnits x quantity — this line's Card-mode basis total, regardless of the cart's actual mode. */
  readonly lineCardBasisTotalMinorUnits: string;
  /** This line's Bank-mode basis total, regardless of the cart's actual mode. Equal to lineCardBasisTotalMinorUnits for an ineligible line (owner §18). */
  readonly lineBankBasisTotalMinorUnits: string;
  /** Owner §3 "Cart": this line's Bank Payment saving, quantity-extended. Zero (not absent) for an ineligible line. */
  readonly lineBankPaymentSavingsMinorUnits: string;
}

export interface CartProxyUnpurchasableLineDto {
  readonly lineId: string;
  readonly shopifyVariantId: string;
  readonly quantity: string;
  readonly purchasable: false;
  /** Human-safe reason only — never a rule id, cost or internal code. */
  readonly reason: "unknown_variant" | "unsynced";
}

export type CartProxyLineDto = CartProxyPricedLineDto | CartProxyUnpurchasableLineDto;

export interface CartProxyResponseDto {
  readonly mode: CartPaymentMode;
  readonly currency: string;
  readonly lines: readonly CartProxyLineDto[];
  readonly cardMerchandiseTotalMinorUnits: string;
  readonly bankMerchandiseTotalMinorUnits: string;
  readonly bankPaymentSavingsMinorUnits: string;
  readonly activeMerchandiseTotalMinorUnits: string;
}

/** Builds exactly one priced line's DTO. Every field is copied by name — no spread. */
export function buildPricedLineDto(line: PricedCartLine, shopifyVariantId: string): CartProxyPricedLineDto {
  return {
    lineId: line.lineId,
    shopifyVariantId,
    quantity: line.quantity.toString(),
    purchasable: true,
    bankPaymentDiscountEligible: line.bankPaymentDiscountEligible,
    unitBankPaymentPriceMinorUnits: line.unitBankPaymentPriceMinorUnits.toString(),
    unitRegularCardPriceMinorUnits: line.unitRegularCardPriceMinorUnits.toString(),
    activeUnitPriceMinorUnits: line.activeUnitPriceMinorUnits.toString(),
    lineActiveTotalMinorUnits: line.lineActiveTotalMinorUnits.toString(),
    lineCardBasisTotalMinorUnits: line.lineCardBasisTotalMinorUnits.toString(),
    lineBankBasisTotalMinorUnits: line.lineBankBasisTotalMinorUnits.toString(),
    lineBankPaymentSavingsMinorUnits: line.lineBankPaymentSavingsMinorUnits.toString(),
  };
}

export interface UnpurchasableCartLine {
  readonly lineId: string;
  readonly shopifyVariantId: string;
  readonly quantity: bigint;
  readonly reason: "unknown_variant" | "unsynced";
}

export function buildUnpurchasableLineDto(line: UnpurchasableCartLine): CartProxyUnpurchasableLineDto {
  return {
    lineId: line.lineId,
    shopifyVariantId: line.shopifyVariantId,
    quantity: line.quantity.toString(),
    purchasable: false,
    reason: line.reason,
  };
}

/**
 * Assembles the full response DTO. `shopifyVariantIdByLineId` maps each
 * priced line back to the identifier the client sent — the domain layer
 * never carries a Shopify id, only the internal `masterVariantId`, so it is
 * supplied here rather than read off `PricedCartLine`.
 *
 * THE ONLY WAY A PROXY RESPONSE BODY MAY BE PRODUCED for this route. The
 * route must pass this function's return value directly to `Response.json`,
 * with no additional property added afterward.
 */
export function buildCartProxyResponseDto(
  priced: PricedCart,
  shopifyVariantIdByLineId: ReadonlyMap<string, string>,
  unpurchasable: readonly UnpurchasableCartLine[]
): CartProxyResponseDto {
  const pricedLineDtos: CartProxyLineDto[] = priced.lines.map((line) => {
    const shopifyVariantId = shopifyVariantIdByLineId.get(line.lineId);
    if (!shopifyVariantId) {
      // A programmer error in the caller, not a customer-triggerable state:
      // every priced line must have been resolved from a request line that
      // supplied a shopifyVariantId. Failing loudly here is better than
      // emitting a line with an empty id.
      throw new Error(`buildCartProxyResponseDto: no shopifyVariantId supplied for line "${line.lineId}".`);
    }
    return buildPricedLineDto(line, shopifyVariantId);
  });
  const unpurchasableDtos = unpurchasable.map(buildUnpurchasableLineDto);

  return {
    mode: priced.mode,
    currency: priced.currency,
    lines: [...pricedLineDtos, ...unpurchasableDtos],
    cardMerchandiseTotalMinorUnits: priced.cardMerchandiseTotalMinorUnits.toString(),
    bankMerchandiseTotalMinorUnits: priced.bankMerchandiseTotalMinorUnits.toString(),
    bankPaymentSavingsMinorUnits: priced.bankPaymentSavingsMinorUnits.toString(),
    activeMerchandiseTotalMinorUnits: priced.activeMerchandiseTotalMinorUnits.toString(),
  };
}
