import { describe, expect, it } from "vitest";

import {
  GroupBuyRefundEchoMismatchError,
  ShopifyGroupBuyRefundExecutionAdapter,
} from "./groupBuyRefundExecutionAdapter.server";
import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * The Group Buy tier-adjustment refund adapter.
 *
 * ============================================================================
 * THE TWO PROPERTIES WORTH MOST
 * ============================================================================
 * NO MERCHANDISE IS EVER RECORDED AS RETURNED. The customer keeps everything;
 * only a price difference moves. Sending `refundLineItems` would tell Shopify
 * otherwise, corrupting inventory, the order's refundable quantity and any
 * later RMA or warranty claim on the same line.
 *
 * A POST-SUCCESS FAILURE IS NEVER RETRYABLE. `executeGroupBuyRefund`'s
 * classifier reads `AdminApiError` as `failed`, which is retryable. The echo
 * check runs after money has moved, so every failure there must be a
 * `GroupBuyRefundEchoMismatchError` — not an `AdminApiError` — or a mismatch
 * would become a second refund.
 *
 * WHAT A MOCKED CLIENT CANNOT PROVE: that Shopify honours an input with
 * `refundLineItems` omitted. Introspection established the field is OPTIONAL
 * (`tests/live/slice6.groupBuyRefundExecutionSchemaIntrospection.ts`, passed
 * 2026-10-12), and the live gate proves the runtime behaviour. These tests
 * prove the half that guards production: what is sent, and what is refused.
 */

const ORDER = "gid://shopify/Order/555";
const LINE = "gid://shopify/LineItem/777";
const PARENT = "gid://shopify/OrderTransaction/111";
const REFUND = "gid://shopify/Refund/999";

interface Replies {
  order?: unknown;
  mutation?: unknown;
  readBack?: unknown;
}

/**
 * Answers each of the adapter's three calls by matching the document, so a
 * test does not depend on call ORDER — which would make a failure read as a
 * wrong assertion rather than a wrong sequence.
 */
function fakeClient(replies: Replies) {
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      const reply = document.includes("CaratGroupBuyRefundContext")
        ? replies.order
        : document.includes("CaratGroupBuyTierAdjustmentRefund")
          ? replies.mutation
          : replies.readBack;
      return { json: async () => reply } as Response;
    },
  };
  return { client, calls };
}

function orderReply(
  overrides: {
    currencyCode?: string;
    transactions?: {
      id?: string;
      kind?: string;
      status?: string;
      gateway?: string;
      maximumRefundable?: string;
    }[];
  } = {}
) {
  return {
    data: {
      order: {
        id: ORDER,
        name: "#1042",
        test: true,
        currencyCode: overrides.currencyCode ?? "USD",
        totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
        transactions: (
          overrides.transactions ?? [
            { id: PARENT, kind: "SALE", status: "SUCCESS", gateway: "bogus", maximumRefundable: "500.00" },
          ]
        ).map((t) => ({
          id: t.id ?? PARENT,
          kind: t.kind ?? "SALE",
          status: t.status ?? "SUCCESS",
          gateway: t.gateway ?? "bogus",
          test: true,
          amountSet: { shopMoney: { amount: "500.00", currencyCode: "USD" } },
          maximumRefundableV2: { amount: t.maximumRefundable ?? "500.00", currencyCode: "USD" },
        })),
      },
    },
  };
}

function mutationReply(overrides: { refundId?: string | null; userErrors?: { message: string }[] } = {}) {
  return {
    data: {
      refundCreate: {
        refund:
          overrides.refundId === null
            ? null
            : {
                id: overrides.refundId ?? REFUND,
                totalRefundedSet: { shopMoney: { amount: "12.34", currencyCode: "USD" } },
              },
        userErrors: overrides.userErrors ?? [],
      },
    },
  };
}

function readBackReply(
  overrides: {
    amount?: string;
    currencyCode?: string;
    orderId?: string;
    refundLineItems?: { quantity: number; restocked: boolean; restockType: string }[];
    shippingLines?: { id: string }[];
    duties?: { amountSet: { shopMoney: { amount: string } } }[];
    transactions?: { kind: string; status: string; amount: string }[];
    missing?: boolean;
  } = {}
) {
  if (overrides.missing) return { data: { refund: null } };
  return {
    data: {
      refund: {
        id: REFUND,
        note: "CaratForUs Group Buy tier adjustment",
        order: { id: overrides.orderId ?? ORDER },
        totalRefundedSet: {
          shopMoney: {
            amount: overrides.amount ?? "12.34",
            currencyCode: overrides.currencyCode ?? "USD",
          },
        },
        refundLineItems: {
          nodes: (overrides.refundLineItems ?? []).map((l) => ({
            quantity: l.quantity,
            restocked: l.restocked,
            restockType: l.restockType,
            lineItem: { id: LINE },
          })),
        },
        refundShippingLines: { nodes: overrides.shippingLines ?? [] },
        duties: overrides.duties ?? [],
        transactions: {
          nodes: (overrides.transactions ?? [{ kind: "REFUND", status: "SUCCESS", amount: "12.34" }]).map(
            (t, i) => ({
              id: `gid://shopify/OrderTransaction/refund-${i}`,
              kind: t.kind,
              status: t.status,
              gateway: "bogus",
              test: true,
              amountSet: { shopMoney: { amount: t.amount, currencyCode: "USD" } },
            })
          ),
        },
      },
    },
  };
}

/** $12.34 — the approved tier adjustment. */
const APPROVED = 1_234n;

/** The caller's key, verbatim — shaped exactly like `executeGroupBuyRefund`'s. */
const IDEMPOTENCY_KEY = "groupbuy_refund_issue:cl9refund0001:2026-10-11T04:40:55.000Z";

function refund(
  client: AdminGraphqlClient,
  overrides: { totalAmountMinorUnits?: bigint; currency?: string; idempotencyKey?: string } = {}
) {
  return new ShopifyGroupBuyRefundExecutionAdapter(client).createTierAdjustmentRefund({
    orderGid: ORDER,
    lineItemGid: LINE,
    totalAmountMinorUnits: overrides.totalAmountMinorUnits ?? APPROVED,
    currency: overrides.currency ?? "USD",
    idempotencyKey: overrides.idempotencyKey ?? IDEMPOTENCY_KEY,
  });
}

describe("what it sends — a price adjustment, not a return", () => {
  it("sends NO refundLineItems, no shipping and no duties AT ALL", async () => {
    // THE CENTRAL ASSERTION OF THIS FILE. Not "empty" — ABSENT, so no code
    // path can populate them and Shopify is never told merchandise came back.
    const { client, calls } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    await refund(client);

    const mutation = calls.find((c) => c.document.includes("CaratGroupBuyTierAdjustmentRefund"))!;
    const serialised = JSON.stringify(mutation.variables);
    expect(serialised).not.toContain("refundLineItems");
    expect(serialised).not.toContain("shipping");
    expect(serialised).not.toContain("refundDuties");
    // And the mutation document itself never mentions them either, so a future
    // edit cannot reintroduce one invisibly through the query text.
    expect(mutation.document).not.toContain("refundLineItems");
  });

  it("sends the money as a REFUND transaction against the parent payment", async () => {
    const { client, calls } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    await refund(client);

    const input = (
      JSON.parse(
        JSON.stringify(calls.find((c) => c.document.includes("CaratGroupBuyTierAdjustmentRefund"))!.variables)
      ) as { input: Record<string, unknown> }
    ).input;
    expect(input.orderId).toBe(ORDER);
    expect(input.currency).toBe("USD");
    // Customer communication about a settlement is ours; a Shopify-composed
    // refund email is wording nobody approved.
    expect(input.notify).toBe(false);
    // Nothing was restocked, damaged, or the customer's doing.
    expect(input.discrepancyReason).toBe("OTHER");

    const transactions = input.transactions as {
      orderId: string;
      parentId: string;
      gateway: string;
      kind: string;
      amount: string;
    }[];
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.kind).toBe("REFUND");
    expect(transactions[0]!.parentId).toBe(PARENT);
    // The parent's OWN gateway — refunding against a different tender would
    // return money to something that never paid.
    expect(transactions[0]!.gateway).toBe("bogus");
    expect(transactions[0]!.amount).toBe("12.34");
  });

  it("names the line in the note, so the reason is recoverable from the order", async () => {
    const { client, calls } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    await refund(client);
    const input = (
      JSON.parse(
        JSON.stringify(calls.find((c) => c.document.includes("CaratGroupBuyTierAdjustmentRefund"))!.variables)
      ) as { input: { note: string } }
    ).input;
    expect(input.note).toContain(LINE);
    expect(input.note).toContain("No merchandise returned");
  });

  it("returns the refund id as the processor reference", async () => {
    const { client } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    expect(await refund(client)).toEqual({ reference: REFUND });
  });
});

describe("@idempotent — Shopify's own no-double-refund guard", () => {
  /**
   * REQUIRED BY SHOPIFY as of API 2026-04: `refundCreate` without
   * `@idempotent(key:)` is rejected outright. This slice's live gate found
   * that the hard way, so these tests exist to keep it found — a future edit
   * that drops the directive fails here rather than in production.
   */
  it("sends the directive, keyed by the CALLER's key verbatim", async () => {
    const { client, calls } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    await refund(client);

    const mutation = calls.find((c) => c.document.includes("CaratGroupBuyTierAdjustmentRefund"))!;
    expect(mutation.document).toContain("@idempotent(key: $idempotencyKey)");
    // VERBATIM, not derived. A key this adapter invented per call would
    // deduplicate nothing: the whole guarantee is that one approved
    // settlement produces one key however many times it is attempted.
    expect(mutation.variables?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  it("REFUSES to refund at all without a key, rather than sending an undeduplicatable refund", async () => {
    for (const key of ["", "   ", "\t\n"]) {
      const { client, calls } = fakeClient({ order: orderReply() });
      await expect(refund(client, { idempotencyKey: key })).rejects.toThrow(AdminApiError);
      await expect(refund(client, { idempotencyKey: key })).rejects.toThrow(/idempotency key/i);
      // Checked before the order is even loaded, so nothing was sent anywhere.
      expect(calls).toHaveLength(0);
    }
  });
});

describe("refused BEFORE the mutation — definitively failed, safe to retry", () => {
  /** Every refusal here must be an AdminApiError, so the job classifies `failed`. */
  async function expectPreMutationRefusal(
    replies: Replies,
    overrides: Parameters<typeof refund>[1],
    pattern: RegExp
  ) {
    const { client, calls } = fakeClient(replies);
    await expect(refund(client, overrides)).rejects.toThrow(AdminApiError);
    await expect(refund(client, overrides)).rejects.toThrow(pattern);
    // AND NOTHING WAS SENT. A refusal that still called the mutation would
    // have moved money.
    expect(calls.filter((c) => c.document.includes("CaratGroupBuyTierAdjustmentRefund"))).toHaveLength(0);
  }

  it("refuses a zero refund", async () => {
    await expectPreMutationRefusal({ order: orderReply() }, { totalAmountMinorUnits: 0n }, /must be positive/i);
  });

  it("refuses a negative refund", async () => {
    await expectPreMutationRefusal(
      { order: orderReply() },
      { totalAmountMinorUnits: -1_234n },
      /must be positive/i
    );
  });

  it("refuses when the approved currency differs from the order's", async () => {
    // Converting a figure staff approved is not this adapter's business.
    await expectPreMutationRefusal(
      { order: orderReply({ currencyCode: "CAD" }) },
      { currency: "USD" },
      /refusing rather than converting/i
    );
  });

  it("refuses when the order has no successful SALE or CAPTURE to refund against", async () => {
    // An AUTHORIZATION was never captured; a PENDING sale has given nothing.
    await expectPreMutationRefusal(
      {
        order: orderReply({
          transactions: [
            { kind: "AUTHORIZATION", status: "SUCCESS" },
            { kind: "SALE", status: "PENDING" },
            { kind: "REFUND", status: "SUCCESS" },
          ],
        }),
      },
      {},
      /no successful SALE or CAPTURE/i
    );
  });

  it("RESPECTS A PREVIOUSLY REFUNDED AMOUNT", async () => {
    // `maximumRefundableV2` is Shopify's own answer to what is still
    // refundable, so it already accounts for earlier refunds. Exceeding it is
    // refused before the call rather than discovered from an error string.
    await expectPreMutationRefusal(
      { order: orderReply({ transactions: [{ maximumRefundable: "10.00" }] }) },
      { totalAmountMinorUnits: 1_234n },
      /exceeds the 1000 still refundable/i
    );
  });

  it("allows a refund exactly equal to what remains refundable", async () => {
    // The boundary. Refusing this would block a legitimate final settlement.
    const { client } = fakeClient({
      order: orderReply({ transactions: [{ maximumRefundable: "12.34" }] }),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    expect(await refund(client)).toEqual({ reference: REFUND });
  });

  it("refuses a missing order", async () => {
    await expectPreMutationRefusal({ order: { data: { order: null } } }, {}, /was not found/i);
  });

  it("treats userErrors as a definitive rejection", async () => {
    const { client } = fakeClient({
      order: orderReply(),
      mutation: mutationReply({ userErrors: [{ message: "Refund amount exceeds the refundable amount" }] }),
    });
    await expect(refund(client)).rejects.toThrow(AdminApiError);
    await expect(refund(client)).rejects.toThrow(/exceeds the refundable amount/);
  });

  it("treats a top-level GraphQL error as a definitive rejection", async () => {
    // Shopify reports coercion and authorization failures on a 200 with
    // `errors` and no `userErrors`, so checking userErrors alone would let one
    // through unreported.
    const { client } = fakeClient({
      order: orderReply(),
      mutation: { errors: [{ message: "Variable $input of type RefundInput! was provided invalid value" }] },
    });
    await expect(refund(client)).rejects.toThrow(AdminApiError);
    await expect(refund(client)).rejects.toThrow(/invalid value/);
  });
});

describe("the echo check — and why none of it is an AdminApiError", () => {
  /**
   * EVERY failure here happens after Shopify accepted the refund. Each case
   * asserts BOTH that it throws and that it is NOT an `AdminApiError`, because
   * the second half is what stops a mismatch becoming a duplicate refund.
   */
  async function expectEchoFailure(readBack: unknown, pattern: RegExp) {
    const { client } = fakeClient({ order: orderReply(), mutation: mutationReply(), readBack });
    const error = await refund(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GroupBuyRefundEchoMismatchError);
    expect(error).not.toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toMatch(pattern);
    // And the message tells a human not to retry, because money may have moved.
    expect((error as Error).message).toMatch(/Do NOT retry/);
  }

  it("FAILS CLOSED when merchandise was recorded as returned", async () => {
    // The defect this whole adapter exists to prevent, caught even if Shopify
    // somehow attached a line we never sent.
    await expectEchoFailure(
      readBackReply({ refundLineItems: [{ quantity: 1, restocked: false, restockType: "NO_RESTOCK" }] }),
      /recorded as RETURNED/i
    );
  });

  it("FAILS CLOSED when inventory was restocked", async () => {
    await expectEchoFailure(
      readBackReply({ refundLineItems: [{ quantity: 1, restocked: true, restockType: "RETURN" }] }),
      /restocked=true/
    );
  });

  it("FAILS CLOSED on a zero-quantity line item too", async () => {
    // "Empty enough" is not empty. A future Shopify behaviour attaching a
    // zero-quantity line must not slip through.
    await expectEchoFailure(
      readBackReply({ refundLineItems: [{ quantity: 0, restocked: false, restockType: "NO_RESTOCK" }] }),
      /recorded as RETURNED/i
    );
  });

  it("FAILS CLOSED when the amount differs from the approved figure", async () => {
    await expectEchoFailure(readBackReply({ amount: "12.35" }), /1235 minor units, but 1234 was approved/);
  });

  it("ACCEPTS a whole-number amount written without decimals", async () => {
    // A MoneyBag is composed by Shopify and normalises trailing zeros, which
    // is why the comparison is by VALUE. Comparing as a string refused
    // correct draft orders elsewhere in this codebase, and the same mistake
    // here would send every clean refund to staff review.
    // BOTH figures are overridden. The first version of this test set only
    // the total, leaving the transaction at the default 12.34 — and the
    // adapter correctly reported the disagreement between them. That is the
    // cross-check doing its job on a fixture that described an impossible
    // refund.
    const { client } = fakeClient({
      order: orderReply({ transactions: [{ maximumRefundable: "500.00" }] }),
      mutation: mutationReply(),
      readBack: readBackReply({
        amount: "50",
        transactions: [{ kind: "REFUND", status: "SUCCESS", amount: "50" }],
      }),
    });
    expect(await refund(client, { totalAmountMinorUnits: 5_000n })).toEqual({ reference: REFUND });
  });

  it("FAILS CLOSED on a genuinely different value, however it is written", async () => {
    // The fix must not become "accept anything that parses". $12.30 is not
    // $12.34.
    await expectEchoFailure(readBackReply({ amount: "12.3" }), /1230 minor units, but 1234 was approved/);
  });

  it("FAILS CLOSED on an amount it cannot read as money", async () => {
    // Not silently treated as zero or as a match. Three decimals is not a
    // currency amount this adapter will accept as equal to anything.
    await expectEchoFailure(readBackReply({ amount: "12.340" }), /could not be read as an amount/);
  });

  it("FAILS CLOSED on a wrong currency", async () => {
    await expectEchoFailure(readBackReply({ currencyCode: "CAD" }), /refunded in CAD but USD was approved/);
  });

  it("FAILS CLOSED on the wrong order", async () => {
    await expectEchoFailure(
      readBackReply({ orderId: "gid://shopify/Order/999999" }),
      /belongs to order gid:\/\/shopify\/Order\/999999/
    );
  });

  it("FAILS CLOSED when shipping was refunded", async () => {
    await expectEchoFailure(
      readBackReply({ shippingLines: [{ id: "gid://shopify/RefundShippingLine/1" }] }),
      /shipping line\(s\) were refunded/
    );
  });

  it("FAILS CLOSED when duties were refunded", async () => {
    await expectEchoFailure(
      readBackReply({ duties: [{ amountSet: { shopMoney: { amount: "4.00" } } }] }),
      /duty refund\(s\) were recorded/
    );
  });

  it("FAILS CLOSED when no REFUND transaction exists", async () => {
    await expectEchoFailure(
      readBackReply({ transactions: [{ kind: "SALE", status: "SUCCESS", amount: "12.34" }] }),
      /carries no REFUND transaction/
    );
  });

  it("FAILS CLOSED on a DUPLICATE refund transaction", async () => {
    await expectEchoFailure(
      readBackReply({
        transactions: [
          { kind: "REFUND", status: "SUCCESS", amount: "12.34" },
          { kind: "REFUND", status: "SUCCESS", amount: "12.34" },
        ],
      }),
      /carries 2 REFUND transactions/
    );
  });

  it("FAILS CLOSED when the refund transaction moved a different amount", async () => {
    await expectEchoFailure(
      readBackReply({ transactions: [{ kind: "REFUND", status: "SUCCESS", amount: "1.00" }] }),
      /moved 1\.00 = 100 minor units, not the approved 1234/
    );
  });

  it("FAILS CLOSED when the refund transaction failed", async () => {
    await expectEchoFailure(
      readBackReply({ transactions: [{ kind: "REFUND", status: "FAILURE", amount: "12.34" }] }),
      /status is FAILURE/
    );
  });

  it("ACCEPTS a PENDING refund transaction", async () => {
    // Some gateways settle asynchronously. Pending is money on its way, not a
    // failure — and refusing it would send every such refund to staff review.
    const { client } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply({ transactions: [{ kind: "REFUND", status: "PENDING", amount: "12.34" }] }),
    });
    expect(await refund(client)).toEqual({ reference: REFUND });
  });

  it("FAILS CLOSED when the refund cannot be read back at all", async () => {
    await expectEchoFailure(readBackReply({ missing: true }), /could not be read back at all/);
  });

  it("FAILS CLOSED when the read-back query itself errors", async () => {
    await expectEchoFailure({ errors: [{ message: "Throttled" }] }, /read-back error: Throttled/);
  });

  it("FAILS CLOSED when Shopify reports success but names no refund", async () => {
    // Ambiguous rather than definitive: no userErrors means it was not
    // rejected, so a refund may exist that we cannot name or verify.
    const { client } = fakeClient({
      order: orderReply(),
      mutation: mutationReply({ refundId: null }),
    });
    const error = await refund(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GroupBuyRefundEchoMismatchError);
    expect(error).not.toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toMatch(/returned no refund id/);
  });

  it("reports EVERY mismatch, not just the first", async () => {
    // A reviewer needs the whole picture. Fixing one problem and rediscovering
    // the next is how a reconciliation takes three passes.
    const { client } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply({
        amount: "99.99",
        currencyCode: "CAD",
        orderId: "gid://shopify/Order/other",
        refundLineItems: [{ quantity: 2, restocked: true, restockType: "RETURN" }],
      }),
    });
    const error = (await refund(client).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/9999 minor units/);
    expect(error.message).toMatch(/refunded in CAD/);
    expect(error.message).toMatch(/belongs to order/);
    expect(error.message).toMatch(/recorded as RETURNED/);
  });
});

describe("the read-back is independent of the mutation", () => {
  it("re-reads in a SEPARATE query rather than trusting the mutation's echo", async () => {
    // The mutation response carries a `totalRefundedSet` too. Trusting it
    // would prove only that Shopify received the request — not that the result
    // persisted. Asserted structurally: a third call happens, and it is the
    // read-back document.
    const { client, calls } = fakeClient({
      order: orderReply(),
      mutation: mutationReply(),
      readBack: readBackReply(),
    });
    await refund(client);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.document).toContain("CaratGroupBuyRefundReadBack");
    expect(calls[2]!.variables).toEqual({ id: REFUND });
  });

  it("a mutation echo that disagrees with the read-back does NOT save it", async () => {
    // The mutation says 12.34; the stored refund says 50.00. The read-back
    // wins, because it is the one that describes what persisted.
    await expect(
      refund(
        fakeClient({
          order: orderReply(),
          mutation: mutationReply(),
          readBack: readBackReply({ amount: "50.00" }),
        }).client
      )
    ).rejects.toThrow(/5000 minor units, but 1234 was approved/);
  });
});
