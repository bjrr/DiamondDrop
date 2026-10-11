import { describe, expect, it } from "vitest";

import { CurrencyMismatchError } from "~/domain/money/errors";
import { Money } from "~/domain/money/money";

import {
  ShopifyDraftOrderAdapter,
  type CreateRedemptionDraftOrderInput,
} from "./draftOrderAdapter.server";
import { minorUnitsToDecimalString } from "./priceSyncAdapter.server";
import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * `createRedemptionDraftOrder` — the Let Us Beat Your Quote fallback benefit
 * carried as an exact fixed amount.
 *
 * ============================================================================
 * WHAT A MOCKED CLIENT CAN AND CANNOT PROVE HERE
 * ============================================================================
 * It cannot prove Shopify honours `appliedDiscount` or
 * `allowDiscountCodesInCheckout`. A fake echoes back whatever the test hands
 * it, which is exactly how `originalUnitPrice` once passed every unit test in
 * this directory while silently charging catalogue price in production. That
 * those fields exist and are legal to send is established instead by
 * `tests/live/slice10.redemptionDiscountSchemaIntrospection.ts` against the
 * real store (2026-10-10, all checks passed).
 *
 * What these tests DO prove is the half that guards production at runtime: that
 * the adapter sends the right shape, and that it REFUSES every response in
 * which the discount did not come back exactly as sent. The echo check is the
 * guard; these are the tests that it fires.
 *
 * A SEPARATE FILE FROM `draftOrderAdapter.test.ts` deliberately. That file
 * covers the live-proven Bank Payment and deposit paths; this one covers a
 * method whose live verification is schema-level only, and the distinction is
 * worth being able to see at a glance.
 */

function fakeClient(replies: unknown[] | unknown) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      return { json: async () => reply } as Response;
    },
  };
  return { client, calls };
}

const SHIPPING_ADDRESS = {
  firstName: "Ada",
  lastName: "Lovelace",
  address1: "1 Analytical Engine Way",
  city: "London",
  zip: "SW1A 1AA",
  countryCode: "GB",
};

const VARIANT = "gid://shopify/ProductVariant/1";

function redemptionReply(opts: {
  lines: { variantGid: string; quantity: number; price: string }[];
  discountAmount?: string;
  discountCurrency?: string;
  valueType?: string;
  allowDiscountCodesInCheckout?: boolean;
  noAppliedDiscount?: boolean;
}) {
  return {
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: "gid://shopify/DraftOrder/redeem-1",
          invoiceUrl: "https://caratforus-dev.myshopify.com/invoice/redeem",
          allowDiscountCodesInCheckout: opts.allowDiscountCodesInCheckout ?? false,
          appliedDiscount: opts.noAppliedDiscount
            ? null
            : {
                valueType: opts.valueType ?? "FIXED_AMOUNT",
                amountSet: {
                  shopMoney: {
                    amount: opts.discountAmount ?? "50.00",
                    currencyCode: opts.discountCurrency ?? "USD",
                  },
                },
              },
          lineItems: {
            nodes: opts.lines.map((l) => ({
              quantity: l.quantity,
              originalUnitPrice: l.price,
              variant: { id: l.variantGid },
            })),
          },
        },
        userErrors: [],
      },
    },
  };
}

function redemptionInput(
  overrides: Partial<CreateRedemptionDraftOrderInput> = {}
): CreateRedemptionDraftOrderInput {
  return {
    customerGid: "gid://shopify/Customer/4242",
    email: "ada@example.com",
    shippingAddress: SHIPPING_ADDRESS,
    lineItems: [{ shopifyVariantGid: VARIANT, quantity: 1, unitPrice: Money.fromMinorUnits(50_000n, "USD") }],
    discount: Money.fromMinorUnits(5_000n, "USD"),
    discountTitle: "Let Us Beat Your Quote — 10% off",
    redemptionIntentId: "11111111-2222-3333-4444-555555555555",
    ...overrides,
  };
}

/** One eligible $500 line, echoed back at the price it was sent. */
const OK_LINES = [{ variantGid: VARIANT, quantity: 1, price: "500.00" }];

/** Asserts on the SERIALISED variables, never an intermediate object. */
function sentInput(calls: { variables?: Record<string, unknown> }[]): Record<string, unknown> {
  return (JSON.parse(JSON.stringify(calls[0]?.variables)) as { input: Record<string, unknown> }).input;
}

describe("what it sends", () => {
  it("sends the discount as a FIXED_AMOUNT with the currency attached", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));

    const result = await new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(redemptionInput());

    expect(result.draftOrderGid).toBe("gid://shopify/DraftOrder/redeem-1");
    const input = sentInput(calls) as {
      appliedDiscount: { valueType: string; value: number; amountWithCurrency: { amount: string; currencyCode: string } };
      customerId: string;
    };
    // PERCENTAGE would let Shopify compute its own figure, ignoring the $100
    // cap and the merchandise-only exclusions — a different benefit from the
    // one promised.
    expect(input.appliedDiscount.valueType).toBe("FIXED_AMOUNT");
    expect(input.appliedDiscount.amountWithCurrency).toEqual({ amount: "50.00", currencyCode: "USD" });
    expect(input.appliedDiscount.value).toBe(50);
    // Without customerId, Shopify matches or CREATES a customer from the email.
    // Order-time verification compares the order's customer against the
    // reserving one, so an email-derived twin would send a legitimate
    // redemption to staff review.
    expect(input.customerId).toBe("gid://shopify/Customer/4242");
  });

  it("sends allowDiscountCodesInCheckout:false — the benefit is not stackable", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(redemptionInput());
    // Explicitly false, not merely absent: Shopify's default permits codes, so
    // omitting the field would leave the policy enforced on our side only.
    expect(sentInput(calls).allowDiscountCodesInCheckout).toBe(false);
  });

  it("never sends reserveInventoryUntil", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(redemptionInput());
    expect(JSON.stringify(calls[0]?.variables)).not.toContain("reserveInventoryUntil");
  });

  it("names the reservation in the discount description, for cross-reference", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(redemptionInput());
    const input = sentInput(calls) as { appliedDiscount: { description: string } };
    expect(input.appliedDiscount.description).toContain("11111111-2222-3333-4444-555555555555");
  });
});

describe("the echo check — every way the discount can come back wrong", () => {
  const adapter = (reply: unknown) => new ShopifyDraftOrderAdapter(fakeClient(reply).client);

  it("REFUSES a response where Shopify stored a different amount", async () => {
    // The defect this exists for: a discount applied at the wrong figure, on an
    // order our database then records as a redeemed benefit.
    await expect(
      adapter(redemptionReply({ lines: OK_LINES, discountAmount: "5.00" })).createRedemptionDraftOrder(
        redemptionInput()
      )
    ).rejects.toThrow(/discount mismatch — sent 50\.00 but Shopify stored 5\.00/);
  });

  it("REFUSES a response carrying no discount at all", async () => {
    // An ignored `appliedDiscount` produces a full-price draft order: the
    // customer pays everything AND loses the benefit.
    await expect(
      adapter(redemptionReply({ lines: OK_LINES, noAppliedDiscount: true })).createRedemptionDraftOrder(
        redemptionInput()
      )
    ).rejects.toThrow(/came back with none/);
  });

  it("REFUSES a response where the discount became a PERCENTAGE", async () => {
    await expect(
      adapter(redemptionReply({ lines: OK_LINES, valueType: "PERCENTAGE" })).createRedemptionDraftOrder(
        redemptionInput()
      )
    ).rejects.toThrow(/a percentage would compute its own figure/);
  });

  it("REFUSES a discount stored in another currency", async () => {
    await expect(
      adapter(redemptionReply({ lines: OK_LINES, discountCurrency: "CAD" })).createRedemptionDraftOrder(
        redemptionInput()
      )
    ).rejects.toThrow(/discount currency mismatch/);
  });

  it("REFUSES a response where discount codes remained allowed", async () => {
    // A write-only flag is a promise nobody checks.
    await expect(
      adapter(
        redemptionReply({ lines: OK_LINES, allowDiscountCodesInCheckout: true })
      ).createRedemptionDraftOrder(redemptionInput())
    ).rejects.toThrow(/must not be combinable at checkout/);
  });

  it("REFUSES a response where that flag was not returned at all", async () => {
    // `Boolean!` on the output type, so a missing field is a failure rather
    // than something to read as false.
    const reply = redemptionReply({ lines: OK_LINES });
    delete (reply.data.draftOrderCreate.draftOrder as Record<string, unknown>).allowDiscountCodesInCheckout;
    await expect(adapter(reply).createRedemptionDraftOrder(redemptionInput())).rejects.toThrow(
      /allowDiscountCodesInCheckout/
    );
  });

  it("REFUSES a line echoed at a different price", async () => {
    await expect(
      adapter(
        redemptionReply({ lines: [{ variantGid: VARIANT, quantity: 1, price: "999.00" }] })
      ).createRedemptionDraftOrder(redemptionInput())
    ).rejects.toThrow(/price mismatch/);
  });

  it("REFUSES a line echoed at a different quantity", async () => {
    await expect(
      adapter(
        redemptionReply({ lines: [{ variantGid: VARIANT, quantity: 7, price: "500.00" }] })
      ).createRedemptionDraftOrder(redemptionInput())
    ).rejects.toThrow(/sent quantity 1 but Shopify echoed 7/);
  });

  it("REFUSES a userErrors response without creating anything", async () => {
    await expect(
      adapter({
        data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ["input"], message: "nope" }] } },
      }).createRedemptionDraftOrder(redemptionInput())
    ).rejects.toThrow(AdminApiError);
  });

  it("REFUSES a top-level GraphQL error even on an HTTP 200", async () => {
    // Shopify reports coercion and authorization failures on a 200 with
    // `errors`, never `userErrors` — so checking userErrors alone lets them
    // through unreported.
    await expect(
      adapter({ errors: [{ message: "Variable $input of type DraftOrderInput! was provided invalid value" }] })
        .createRedemptionDraftOrder(redemptionInput())
    ).rejects.toThrow(/invalid value/);
  });
});

describe("what it refuses before sending anything", () => {
  it("refuses a zero discount", async () => {
    // Would spend the customer's single use on nothing. `quoteRedemption`
    // already refuses this; refused again here so the adapter does not depend
    // on its caller having done so.
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
        redemptionInput({ discount: Money.fromMinorUnits(0n, "USD") })
      )
    ).rejects.toThrow(AdminApiError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a negative discount", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
        redemptionInput({ discount: Money.fromMinorUnits(-5_000n, "USD") })
      )
    ).rejects.toThrow(AdminApiError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a discount in a different currency from the lines", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
        redemptionInput({ discount: Money.fromMinorUnits(5_000n, "CAD") })
      )
    ).rejects.toThrow(CurrencyMismatchError);
    expect(calls).toHaveLength(0);
  });

  it("refuses zero line items", async () => {
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(redemptionInput({ lineItems: [] }))
    ).rejects.toThrow(AdminApiError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a repeated variant rather than merging it", async () => {
    // Merging is a decision about what the customer is buying, and the echo
    // check keys by variant gid — two lines would collapse to one entry and
    // the count check would then fail AFTER the order already exists.
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
        redemptionInput({
          lineItems: [
            { shopifyVariantGid: VARIANT, quantity: 1, unitPrice: Money.fromMinorUnits(50_000n, "USD") },
            { shopifyVariantGid: VARIANT, quantity: 2, unitPrice: Money.fromMinorUnits(50_000n, "USD") },
          ],
        })
      )
    ).rejects.toThrow(/appears on more than one line item/);
    expect(calls).toHaveLength(0);
  });

  it("refuses more lines than the echo check can verify", async () => {
    // Refused before the call, where refusing costs nothing: discovering it
    // afterwards would leave an orphaned draft order with live prices on it.
    const { client, calls } = fakeClient(redemptionReply({ lines: OK_LINES }));
    await expect(
      new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
        redemptionInput({
          lineItems: Array.from({ length: 51 }, (_unused, i) => ({
            shopifyVariantGid: `gid://shopify/ProductVariant/${i}`,
            quantity: 1,
            unitPrice: Money.fromMinorUnits(1_000n, "USD"),
          })),
        })
      )
    ).rejects.toThrow(/cannot verify more than 50 line items/);
    expect(calls).toHaveLength(0);
  });
});

describe("the Float the schema forces on us", () => {
  it("renders exact cents through the required Float field", async () => {
    // $73.49 — a value with a non-trivial binary expansion, so this asserts
    // the round-trip guard passes for a real amount and not only round dollars.
    const { client, calls } = fakeClient(
      redemptionReply({
        lines: [{ variantGid: VARIANT, quantity: 1, price: "734.90" }],
        discountAmount: "73.49",
      })
    );
    await new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
      redemptionInput({
        lineItems: [{ shopifyVariantGid: VARIANT, quantity: 1, unitPrice: Money.fromMinorUnits(73_490n, "USD") }],
        discount: Money.fromMinorUnits(7_349n, "USD"),
      })
    );
    const input = sentInput(calls) as {
      appliedDiscount: { value: number; amountWithCurrency: { amount: string } };
    };
    expect(input.appliedDiscount.value).toBe(73.49);
    // The authoritative figure travels as a decimal string beside it, rendered
    // from the same source, so the two fields cannot disagree.
    expect(input.appliedDiscount.amountWithCurrency.amount).toBe("73.49");
  });

  it("sweeps every cent of a dollar through the round-trip guard", async () => {
    // The guard refuses any amount that does not survive conversion to the
    // Float the schema requires. Proving none of them fails is cheaper, and
    // more durable, than reasoning about doubles in a comment.
    for (let cents = 1n; cents <= 100n; cents += 1n) {
      // Rendered by the same integer-only function the adapter uses, not by
      // dividing by 100 — a test that reaches for float arithmetic to check
      // float safety is checking the wrong thing.
      const amount = minorUnitsToDecimalString(cents);
      const { client } = fakeClient(redemptionReply({ lines: OK_LINES, discountAmount: amount }));
      await expect(
        new ShopifyDraftOrderAdapter(client).createRedemptionDraftOrder(
          redemptionInput({ discount: Money.fromMinorUnits(cents, "USD") })
        )
      ).resolves.toMatchObject({ draftOrderGid: "gid://shopify/DraftOrder/redeem-1" });
    }
  });
});
