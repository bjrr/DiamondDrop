/**
 * Line coalescing for Bank Payment Checkout (Slice 2C task 2C-3,
 * docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md criterion 72, adapter comment
 * in app/shopify/admin/draftOrderAdapter.server.ts).
 *
 * WHY THIS EXISTS, AND WHY IT LIVES HERE RATHER THAN IN THE ADAPTER.
 * `ShopifyDraftOrderAdapter.createDraftOrder` REFUSES a request that
 * repeats a variant across two line items — it does not merge them itself,
 * because the adapter's own doc comment is explicit: "summing quantities
 * is a decision about what the customer is buying, and criterion 72 puts
 * every such decision in the caller, before this class is reached." This
 * module is that caller-side decision, pulled out pure and unit-tested
 * rather than inlined in the route.
 *
 * Pure, synchronous, no I/O — operates on already-normalized identifiers
 * (the route resolves `shopifyVariantId` -> `masterVariantId` BEFORE
 * calling this, so coalescing never has to guess whether two differently
 * spelled ids name the same variant).
 */

export interface RawCheckoutLine {
  readonly masterVariantId: string;
  /** Carried through unchanged for the coalesced line — the normalized gid form, not the caller's raw input. */
  readonly shopifyVariantGid: string;
  readonly quantity: number;
}

export class CoalescedQuantityOverflowError extends Error {
  constructor(masterVariantId: string, total: number) {
    super(
      `Coalescing variant ${masterVariantId} produced a combined quantity of ${total}, which is not a safe integer.`
    );
    this.name = "CoalescedQuantityOverflowError";
  }
}

/**
 * Merges duplicate `masterVariantId` entries into one, summing quantity.
 * Preserves first-seen order — deterministic, and irrelevant to correctness
 * (the draft order does not care about line order), but deterministic
 * output makes this trivial to assert against in a test.
 */
export function coalesceCheckoutLines(lines: readonly RawCheckoutLine[]): RawCheckoutLine[] {
  const order: string[] = [];
  const gidByVariant = new Map<string, string>();
  const totalByVariant = new Map<string, number>();

  for (const line of lines) {
    if (!totalByVariant.has(line.masterVariantId)) {
      order.push(line.masterVariantId);
      gidByVariant.set(line.masterVariantId, line.shopifyVariantGid);
      totalByVariant.set(line.masterVariantId, 0);
    }
    const runningTotal = totalByVariant.get(line.masterVariantId)! + line.quantity;
    if (!Number.isSafeInteger(runningTotal)) {
      throw new CoalescedQuantityOverflowError(line.masterVariantId, runningTotal);
    }
    totalByVariant.set(line.masterVariantId, runningTotal);
  }

  return order.map((masterVariantId) => ({
    masterVariantId,
    shopifyVariantGid: gidByVariant.get(masterVariantId)!,
    quantity: totalByVariant.get(masterVariantId)!,
  }));
}
