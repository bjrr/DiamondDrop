import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";
import { CurrencyMismatchError } from "~/domain/money/errors";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import {
  ShopifyDraftOrderAdapter,
  type CreateDraftOrderInput,
} from "./draftOrderAdapter.server";

/**
 * Asserts on the SERIALISED GraphQL variables, never an intermediate object —
 * same discipline as `priceSyncAdapter.test.ts`, and the only way criterion
 * 73 (reserveInventoryUntil never sent) can actually be proven rather than
 * merely intended.
 */
function fakeClient(replies: unknown[] | unknown) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      return { json: async () => reply };
    },
  };
  return { client, calls };
}

const SHIPPING_ADDRESS = {
  firstName: "Ada",
  lastName: "Lovelace",
  address1: "1 Analytical Engine Way",
  city: "London",
  provinceCode: undefined,
  zip: "SW1A 1AA",
  countryCode: "GB",
};

function baseInput(overrides: Partial<CreateDraftOrderInput> = {}): CreateDraftOrderInput {
  return {
    email: "ada@example.com",
    shippingAddress: SHIPPING_ADDRESS,
    lineItems: [
      {
        shopifyVariantGid: "gid://shopify/ProductVariant/1",
        quantity: 1,
        unitPrice: Money.fromMinorUnits(150000n, "USD"), // $1,500.00
      },
    ],
    // Shipping became required on 2026-11-15 (owner decision superseding
    // D19's shipping treatment). $30.00 is the contiguous-48 Standard rate,
    // so the default case in this file is one where shipping COSTS money —
    // a default of zero would let a regression that drops the charge pass.
    shippingRateHandle: "signed-handle-standard",
    expectedShippingPrice: Money.fromMinorUnits(3000n, "USD"),
    ...overrides,
  };
}

function createDraftOrderOkReply(opts: {
  id?: string;
  invoiceUrl?: string | null;
  lines: { variantGid: string; quantity: number; price: string }[];
  /** What Shopify says it charged. Defaults to agreeing with `baseInput`. */
  shippingTitle?: string;
  shippingAmount?: string;
  /** Omits the shipping total entirely, modelling a handle Shopify ignored. */
  omitShipping?: boolean;
}) {
  return {
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: opts.id ?? "gid://shopify/DraftOrder/1",
          invoiceUrl: opts.invoiceUrl ?? "https://caratforus-dev.myshopify.com/invoice/abc",
          lineItems: {
            nodes: opts.lines.map((l) => ({
              quantity: l.quantity,
              originalUnitPrice: l.price,
              variant: { id: l.variantGid },
            })),
          },
          // "30.0", not "30.00" — Shopify NORMALISES trailing zeros on a
          // MoneyBag amount, and the echo check must compare minor units
          // rather than strings. Encoding the real wire format here is what
          // makes that a tested property instead of a comment.
          ...(opts.omitShipping
            ? {}
            : {
                shippingLine: {
                  title: opts.shippingTitle ?? "Standard Insured Shipping with Signature",
                },
                totalShippingPriceSet: {
                  shopMoney: { amount: opts.shippingAmount ?? "30.0", currencyCode: "USD" },
                },
              }),
        },
        userErrors: [],
      },
    },
  };
}

describe("ShopifyDraftOrderAdapter.createDraftOrder", () => {
  it("creates a draft order and returns its gid and invoice URL", async () => {
    const { client, calls } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    const result = await adapter.createDraftOrder(baseInput());

    expect(result).toEqual({
      draftOrderGid: "gid://shopify/DraftOrder/1",
      invoiceUrl: "https://caratforus-dev.myshopify.com/invoice/abc",
    });
    expect(calls[0]?.document).toMatch(/draftOrderCreate/);
  });

  /**
   * THE FIELD NAME IS ASSERTED, not just the value, because sending the wrong
   * one is invisible from inside a mock. The adapter first shipped with
   * `originalUnitPrice`, which does not exist on `DraftOrderLineItemInput` in
   * 2026-07 — the live store neither errored nor coerced, it ignored the field
   * and priced every line at the variant's catalogue price. A fake client
   * echoes back whatever it was handed, so the whole suite stayed green while
   * the real draft orders would have charged the wrong amount.
   *
   * Hence both halves: `priceOverride` present WITH its currency, and
   * `originalUnitPrice` absent from the serialised payload entirely.
   */
  it("sends the exact recomputed price as priceOverride, with currency, and never as originalUnitPrice", async () => {
    const { client, calls } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 2, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.createDraftOrder(
      baseInput({
        lineItems: [
          {
            shopifyVariantGid: "gid://shopify/ProductVariant/1",
            quantity: 2,
            unitPrice: Money.fromMinorUnits(150000n, "USD"),
          },
        ],
      })
    );

    const variables = calls[0]?.variables as { input: { lineItems: unknown[] } };
    expect(variables.input.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 2,
        priceOverride: { amount: "1500.00", currencyCode: "USD" },
      },
    ]);
    expect(JSON.stringify(variables)).not.toContain("originalUnitPrice");
  });

  /**
   * CRITERION 73. Asserted on the SERIALISED request payload sent to the
   * Admin client — not on the adapter's source code and not on intent. A
   * test that only checked "we never wrote that field" would not catch a
   * future refactor (e.g. a spread of some larger options object) that
   * reintroduces it.
   */
  it("never sends reserveInventoryUntil, asserted on the serialised payload (criterion 73)", async () => {
    const { client, calls } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.createDraftOrder(baseInput());

    const serialised = JSON.stringify(calls[0]?.variables);
    expect(serialised).not.toContain("reserveInventoryUntil");
  });

  /**
   * REPLACES "sets an explicit zero-price shipping line (D19, criterion 95)".
   *
   * That test asserted the old behaviour faithfully and the behaviour is gone:
   * the owner superseded D19's shipping treatment on 2026-11-15, so a Bank
   * Payment order is charged the policy rate rather than $0.00. Kept as a
   * deliberate replacement rather than a deletion, because the thing worth
   * pinning is the same — that shipping on this mutation is decided ONCE, in
   * one place, and is visible in the request.
   */
  describe("shipping (owner decision 2026-11-15, superseding D19)", () => {
    it("sends the signed rate handle and NEVER a price of its own", async () => {
      const { client, calls } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await adapter.createDraftOrder(baseInput());

      const variables = calls[0]?.variables as { input: { shippingLine: Record<string, unknown> } };
      expect(variables.input.shippingLine).toEqual({ shippingRateHandle: "signed-handle-standard" });
      // THE POINT: no price and no title. Shopify derives both from its own
      // signed claim, so there is no number here that could disagree with
      // what the customer was quoted, and nothing a caller could tamper with.
      expect(variables.input.shippingLine).not.toHaveProperty("price");
      expect(variables.input.shippingLine).not.toHaveProperty("priceWithCurrency");
      expect(variables.input.shippingLine).not.toHaveProperty("title");
    });

    it("never sends the superseded zero-price shipping line", async () => {
      const { client, calls } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await adapter.createDraftOrder(baseInput());

      expect(JSON.stringify(calls[0]?.variables)).not.toContain("Shipping (included in item price)");
    });

    it("accepts Shopify's normalised amount — '30.0' is $30.00, not a mismatch", async () => {
      const { client } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
          shippingAmount: "30.0",
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await expect(adapter.createDraftOrder(baseInput())).resolves.toMatchObject({
        draftOrderGid: "gid://shopify/DraftOrder/1",
      });
    });

    it("refuses the draft when Shopify charged something other than the quoted amount", async () => {
      const { client } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
          // The customer was quoted $30.00 Standard; Shopify applied $55.00.
          shippingTitle: "Express Insured Shipping with Signature",
          shippingAmount: "55.00",
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/shipping charge mismatch/i);
    });

    it("refuses the draft when the handle produced no shipping line at all", async () => {
      // THE DANGEROUS CASE. A silently-ignored handle leaves a draft with no
      // shipping, which is free shipping and the superseded behaviour
      // returning by the back door. Absence must fail, not read as zero.
      const { client } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
          omitShipping: true,
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/echoed no shipping total/i);
    });

    it("accepts a genuinely free rate when that is what was quoted", async () => {
      // Complimentary Express at $1,000+. Zero is a legitimate PRICE here, as
      // distinct from the missing-line case above — the two must not collapse.
      const { client } = fakeClient(
        createDraftOrderOkReply({
          lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
          shippingTitle: "Complimentary Express Insured Shipping with Signature",
          shippingAmount: "0.0",
        })
      );
      const adapter = new ShopifyDraftOrderAdapter(client);

      await expect(
        adapter.createDraftOrder(
          baseInput({
            shippingRateHandle: "signed-handle-complimentary",
            expectedShippingPrice: Money.fromMinorUnits(0n, "USD"),
          })
        )
      ).resolves.toMatchObject({ draftOrderGid: "gid://shopify/DraftOrder/1" });
    });
  });

  /**
   * THE ABSENCE OF THIS FIELD SILENTLY MARKS THE ORDER PAID.
   *
   * Completing a draft that carries no payment terms produced an order
   * Shopify reported as PAID, against a bank transfer it had never seen and
   * that had not arrived. Nothing errored; the money was simply asserted. §22
   * exists to prevent exactly that, so the field is pinned here and the
   * resulting financial status is asserted end to end by the live gate.
   */
  it("sets Due-on-receipt payment terms, so the completed order is not marked paid (§22)", async () => {
    const { client, calls } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.createDraftOrder(baseInput());

    const variables = calls[0]?.variables as { input: { paymentTerms?: { paymentTermsTemplateId: string } } };
    expect(variables.input.paymentTerms).toEqual({
      paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/1",
    });
  });

  it("sends email and shipping address but never persists them (this test only proves transport, not non-persistence)", async () => {
    const { client, calls } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.createDraftOrder(baseInput());

    const variables = calls[0]?.variables as { input: { email: string; shippingAddress: unknown } };
    expect(variables.input.email).toBe("ada@example.com");
    expect(variables.input.shippingAddress).toMatchObject({ city: "London", countryCode: "GB" });
  });

  it("refuses zero line items", async () => {
    const { client } = fakeClient({});
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput({ lineItems: [] }))).rejects.toThrow(
      /zero line items/
    );
  });

  /**
   * BOTH OF THESE REFUSE BEFORE THE CALL, and that is what is being proven.
   *
   * The echo check that would otherwise catch them runs AFTER
   * `draftOrderCreate` has already succeeded, so it would throw with a real
   * draft order sitting in the shop that nothing in our database points at.
   * Each test therefore asserts the client was never invoked — a test that
   * only checked the throw would pass just as happily against the orphaning
   * version.
   */
  it("refuses more line items than it can verify, without calling Shopify", async () => {
    const { client, calls } = fakeClient({});
    const adapter = new ShopifyDraftOrderAdapter(client);

    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      shopifyVariantGid: `gid://shopify/ProductVariant/${i + 1}`,
      quantity: 1,
      unitPrice: Money.fromMinorUnits(100000n, "USD"),
    }));

    await expect(adapter.createDraftOrder(baseInput({ lineItems: tooMany }))).rejects.toThrow(
      /cannot verify more than 50 line items; received 51/
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a variant repeated across two lines, without calling Shopify", async () => {
    const { client, calls } = fakeClient({});
    const adapter = new ShopifyDraftOrderAdapter(client);

    const repeated = [
      {
        shopifyVariantGid: "gid://shopify/ProductVariant/1",
        quantity: 1,
        unitPrice: Money.fromMinorUnits(100000n, "USD"),
      },
      {
        shopifyVariantGid: "gid://shopify/ProductVariant/1",
        quantity: 2,
        unitPrice: Money.fromMinorUnits(100000n, "USD"),
      },
    ];

    await expect(adapter.createDraftOrder(baseInput({ lineItems: repeated }))).rejects.toThrow(
      /appears on more than one line item/
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses mixed-currency line items rather than silently picking one", async () => {
    const { client } = fakeClient({});
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.createDraftOrder(
        baseInput({
          lineItems: [
            {
              shopifyVariantGid: "gid://shopify/ProductVariant/1",
              quantity: 1,
              unitPrice: Money.fromMinorUnits(150000n, "USD"),
            },
            {
              shopifyVariantGid: "gid://shopify/ProductVariant/2",
              quantity: 1,
              unitPrice: Money.fromMinorUnits(150000n, "EUR"),
            },
          ],
        })
      )
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it("throws AdminApiError on top-level GraphQL errors", async () => {
    const { client } = fakeClient({ errors: [{ message: "Throttled" }] });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/Throttled/);
  });

  it("throws AdminApiError when userErrors is non-empty and the draftOrder payload is null", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [{ field: ["input", "email"], message: "Email is invalid" }],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toBeInstanceOf(AdminApiError);
    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/Email is invalid/);
  });

  it("throws when the response echoes no line items but sent one", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/1",
            invoiceUrl: null,
            lineItems: { nodes: [] },
          },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/sent 1 line item.*echoed 0/);
  });

  it("throws when a sent variant is missing from the echoed lines", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/1",
            invoiceUrl: null,
            lineItems: {
              nodes: [
                { quantity: 1, originalUnitPrice: "1500.00", variant: { id: "gid://shopify/ProductVariant/OTHER" } },
              ],
            },
          },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/was not echoed back/);
  });

  it("throws when the echoed quantity differs from what was sent", async () => {
    const { client } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 5, price: "1500.00" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/sent quantity 1 but Shopify echoed 5/);
  });

  /**
   * The echoed-price mismatch check — the draft-order equivalent of
   * `priceSyncAdapter`'s "published price mismatch" test, and just as
   * load-bearing: a Shopify-side rounding or currency-handling difference
   * between what we sent and what got stored is the single worst outcome
   * this whole slice exists to prevent.
   */
  it("throws when the echoed price differs from what was sent", async () => {
    const { client } = fakeClient(
      createDraftOrderOkReply({
        lines: [{ variantGid: "gid://shopify/ProductVariant/1", quantity: 1, price: "1499.99" }],
      })
    );
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(
      /published price mismatch.*sent 1500\.00 but Shopify echoed 1499\.99/
    );
  });

  it("checks top-level errors before userErrors, proven with a response carrying both", async () => {
    const { client } = fakeClient({
      errors: [{ message: "TOP LEVEL: invalid money" }],
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [{ field: ["input"], message: "USER ERROR: must not be reported first" }],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(adapter.createDraftOrder(baseInput())).rejects.toThrow(/TOP LEVEL/);
  });
});

describe("ShopifyDraftOrderAdapter.sendInvoice", () => {
  it("sends the invoice and returns when it was sent", async () => {
    const { client, calls } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceSentAt: "2026-09-21T12:00:00Z" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    const result = await adapter.sendInvoice({
      draftOrderGid: "gid://shopify/DraftOrder/1",
      email: "ada@example.com",
    });

    expect(result.invoiceSentAt).toBeInstanceOf(Date);
    expect(calls[0]?.variables).toEqual({
      id: "gid://shopify/DraftOrder/1",
      email: { to: "ada@example.com" },
    });
  });

  it("throws when the response names a different draft order than requested", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: { id: "gid://shopify/DraftOrder/OTHER", invoiceSentAt: "2026-09-21T12:00:00Z" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.sendInvoice({ draftOrderGid: "gid://shopify/DraftOrder/1", email: "ada@example.com" })
    ).rejects.toThrow(/expected draft order .* but the response named/);
  });

  it("throws when invoiceSentAt is not set", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceSentAt: null },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.sendInvoice({ draftOrderGid: "gid://shopify/DraftOrder/1", email: "ada@example.com" })
    ).rejects.toThrow(/invoiceSentAt was not set/);
  });

  it("throws AdminApiError on userErrors", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: null,
          userErrors: [{ field: ["id"], message: "Draft order not found" }],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.sendInvoice({ draftOrderGid: "gid://shopify/DraftOrder/1", email: "ada@example.com" })
    ).rejects.toThrow(/Draft order not found/);
  });
});

describe("sendInvoice carries the §22 disclosure (criterion 85)", () => {
  /**
   * Shopify composes and sends the invoice, so `customMessage` is the only
   * way words of ours reach it. Asserted on the SERIALISED variables, because
   * an intermediate object proves nothing about what left the process.
   */
  it("sends a custom message inside EmailInput when one is supplied", async () => {
    const { client, calls } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceSentAt: "2026-09-22T00:00:00Z" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.sendInvoice({
      draftOrderGid: "gid://shopify/DraftOrder/1",
      email: "ada@example.com",
      customMessage: "Nothing is charged now.",
    });

    const variables = calls[0]?.variables as { email: { to: string; customMessage?: string } };
    expect(variables.email).toEqual({ to: "ada@example.com", customMessage: "Nothing is charged now." });
  });

  it("omits customMessage entirely when none is supplied, rather than sending an empty one", async () => {
    const { client, calls } = fakeClient({
      data: {
        draftOrderInvoiceSend: {
          draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceSentAt: "2026-09-22T00:00:00Z" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await adapter.sendInvoice({ draftOrderGid: "gid://shopify/DraftOrder/1", email: "ada@example.com" });

    expect(JSON.stringify(calls[0]?.variables)).not.toContain("customMessage");
  });
});

describe("ShopifyDraftOrderAdapter.completeDraftOrder", () => {
  /**
   * COMPLETES WITHOUT ASSERTING PAYMENT. `paymentPending` does not exist on
   * `draftOrderComplete` in 2026-07, and its historical meaning — `false` for
   * "this order is paid" — is the opposite of what §22 wants: nothing is paid
   * until an admin verifies the transfer. Sending nothing leaves the order
   * unpaid, which the live gate confirms by reading displayFinancialStatus
   * back as PENDING. This test pins only that we send the id and nothing else,
   * since anything extra here would be an assertion about money.
   */
  it("completes with the id alone, asserting no payment state, and returns the resulting order", async () => {
    const { client, calls } = fakeClient({
      data: {
        draftOrderComplete: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/1",
            order: { id: "gid://shopify/Order/9", name: "#1042" },
          },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    const result = await adapter.completeDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" });

    expect(result).toEqual({ orderGid: "gid://shopify/Order/9", orderName: "#1042" });
    expect(calls[0]?.variables).toEqual({ id: "gid://shopify/DraftOrder/1" });
  });

  it("throws when no order is present on the completed draft order", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderComplete: {
          draftOrder: { id: "gid://shopify/DraftOrder/1", order: null },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.completeDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/no order was created/);
  });

  it("throws when the response names a different draft order than requested", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderComplete: {
          draftOrder: { id: "gid://shopify/DraftOrder/OTHER", order: { id: "gid://shopify/Order/9", name: "#1042" } },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.completeDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/expected draft order .* but the response named/);
  });

  it("throws AdminApiError on userErrors", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderComplete: {
          draftOrder: null,
          userErrors: [{ field: ["id"], message: "Draft order already completed" }],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.completeDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/already completed/);
  });
});

describe("ShopifyDraftOrderAdapter.cancelDraftOrder", () => {
  it("deletes the draft order and returns its gid", async () => {
    const { client, calls } = fakeClient({
      data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/1", userErrors: [] } },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    const result = await adapter.cancelDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" });

    expect(result).toEqual({ cancelledDraftOrderGid: "gid://shopify/DraftOrder/1" });
    expect(calls[0]?.variables).toEqual({ input: { id: "gid://shopify/DraftOrder/1" } });
  });

  it("throws when the response deletes a different id than requested", async () => {
    const { client } = fakeClient({
      data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/OTHER", userErrors: [] } },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.cancelDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/expected to delete draft order .* but the response named/);
  });

  it("throws when no deletedId is present and there are no userErrors", async () => {
    const { client } = fakeClient({
      data: { draftOrderDelete: { deletedId: null, userErrors: [] } },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.cancelDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/no deletedId/);
  });

  it("throws AdminApiError on userErrors", async () => {
    const { client } = fakeClient({
      data: {
        draftOrderDelete: {
          deletedId: null,
          userErrors: [{ field: ["id"], message: "Draft order not found" }],
        },
      },
    });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.cancelDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/Draft order not found/);
  });

  it("throws on top-level GraphQL errors", async () => {
    const { client } = fakeClient({ errors: [{ message: "Throttled" }] });
    const adapter = new ShopifyDraftOrderAdapter(client);

    await expect(
      adapter.cancelDraftOrder({ draftOrderGid: "gid://shopify/DraftOrder/1" })
    ).rejects.toThrow(/Throttled/);
  });
});
