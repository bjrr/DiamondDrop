/**
 * SLICE 8 LIVE GATE — a Group Buy tier-adjustment refund, executed for real.
 *
 * ============================================================================
 * WHAT INTROSPECTION COULD NOT SETTLE
 * ============================================================================
 * `slice6.groupBuyRefundExecutionSchemaIntrospection.ts` proved the shape is
 * legal: `RefundInput.refundLineItems` is OPTIONAL, and `transactions` carries
 * the money. It could not prove Shopify ACCEPTS a refund with no
 * `refundLineItems` at runtime, nor what such a refund does to the order.
 *
 * That second question is the one with money attached. The whole reason this
 * adapter exists separately from `rmaRemedyExecutionAdapter` is that a tier
 * adjustment returns NO merchandise — so the thing to prove is not merely
 * "the refund succeeded" but "the order still says the customer has their
 * goods".
 *
 * THE DECISIVE ASSERTION is therefore `refundableQuantity`. Before the refund
 * the line can be refunded N times over; after a MERCHANDISE return it would
 * read lower. If it is unchanged, Shopify recorded a pure monetary refund and
 * a later RMA or warranty claim on the same line is unaffected. No mock can
 * establish that.
 *
 * ============================================================================
 * NO REAL MONEY. NO REAL CUSTOMER.
 * ============================================================================
 * The order is created here, by this gate, through `orderCreate` with
 * `test: true` on BOTH the order and its SALE transaction, paid through the
 * `bogus` gateway — Shopify's own test-payment facility. There are no real
 * funds to move, no customer is involved, and no email is ever sent.
 *
 * The gate then asserts `order.test === true` and `transaction.test === true`
 * BEFORE refunding anything, and refuses to continue if either is false. That
 * is the guard against this file ever being pointed at production.
 *
 * THE GUARD ALREADY EARNED ITS KEEP. This gate's first attempt created the
 * order from a draft order completed via the MANUAL gateway — the path
 * `slice9.depositInvoicePriceField.ts` uses. Shopify sets `Order.test` from
 * the payment gateway rather than from the store, so that order read
 * `test: false` and the guard refused to refund it. No real money could have
 * moved on a development store, but the guard cannot know that, and weakening
 * a money guard to make a gate pass is exactly backwards.
 *
 * ============================================================================
 * CLEANUP, AND WHAT IS DELIBERATELY KEPT
 * ============================================================================
 * The gate attempts to delete its order at the end. If Shopify refuses —
 * refunded orders often cannot be deleted — the id is named in the output for
 * manual removal rather than left silent. Either way the PROOF is this file's
 * output, not the order: the assertions below record the actual figures
 * Shopify returned, so the evidence survives the artifact.
 *
 * RUN: npx tsx tests/live/slice8.groupBuyRefundExecution.ts
 */
import "dotenv/config";

import { Money } from "~/domain/money/money";
import { ShopifyGroupBuyRefundExecutionAdapter } from "~/shopify/admin/groupBuyRefundExecutionAdapter.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

const REQUIRED_ASSERTIONS = [
  "order-is-a-test-order",
  "order-has-successful-sale",
  "refund-accepted",
  "refund-amount-exact",
  "refund-currency-correct",
  "refund-on-correct-order",
  "no-merchandise-returned",
  "no-inventory-restock",
  "refundable-quantity-unchanged",
  "no-shipping-or-duty-refunded",
  "exactly-one-refund-on-order",
  "order-total-refunded-exact",
  "replay-same-key-refunds-once",
  "replay-returns-the-same-refund",
  "cleanup",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  if (executed.has(id)) throw new Error(`assertion id "${id}" used twice`);
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

/**
 * The key, shaped exactly as `executeGroupBuyRefund` builds it. Stable within
 * a run so the replay below is a genuine duplicate, and carrying the run's own
 * order name so a re-run of this file is a NEW attempt rather than one Shopify
 * silently collapses into the previous run's refund.
 */
let IDEMPOTENCY_KEY = "";

/** $500.00 sold, $12.34 refunded as a tier adjustment. Deliberately not round. */
const SALE_PRICE = Money.fromMinorUnits(50_000n, "USD");
const REFUND_AMOUNT = Money.fromMinorUnits(1_234n, "USD");

/** Integer minor units to the decimal string Shopify expects. No float. */
function minorUnitsToDecimal(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function minorUnits(amount: string | null | undefined): bigint | null {
  if (!amount) return null;
  const cleaned = amount.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -magnitude : magnitude;
}

/**
 * A genuine TEST order with a successful TEST transaction.
 *
 * `test: true` on BOTH the order and the transaction is Shopify's own
 * test-payment facility — the bogus gateway — so no real funds exist to move.
 * Confirmed present on `OrderCreateOrderInput` and
 * `OrderCreateOrderTransactionInput` by introspection, not assumed.
 */
const ORDER_CREATE_MUTATION = `#graphql
  mutation CaratLiveGateCreateTestOrder($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order { id name test }
      userErrors { field message }
    }
  }`;

const ORDER_STATE_QUERY = `#graphql
  query CaratLiveGateOrderState($id: ID!) {
    order(id: $id) {
      id
      name
      test
      currencyCode
      totalRefundedSet { shopMoney { amount currencyCode } }
      refunds(first: 10) { id totalRefundedSet { shopMoney { amount currencyCode } } }
      lineItems(first: 10) {
        nodes { id quantity refundableQuantity }
      }
      transactions(first: 20) {
        id kind status gateway test
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_DOMAIN must be set — this gate talks to the real store.");
  // NO CUSTOMER IS ATTACHED. `orderCreate` takes an email, and binding a real
  // customer record to a synthetic refund probe would put test money movement
  // on someone's order history for no gain — this gate proves what a refund
  // does to an ORDER, which needs no customer at all.

  console.log(`Slice 8 live gate — Group Buy tier-adjustment refund, against ${SHOP}`);
  console.log("Creates ONE test order, refunds $12.34 of it, and deletes the order. No email is sent.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const refunds = new ShopifyGroupBuyRefundExecutionAdapter(admin);

  let orderGid: string | null = null;

  async function readOrder(): Promise<{
    id: string;
    name: string;
    test: boolean;
    currencyCode: string;
    totalRefundedSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
    refunds?: { id: string; totalRefundedSet?: { shopMoney?: { amount: string } | null } | null }[] | null;
    lineItems?: { nodes?: { id: string; quantity: number; refundableQuantity: number }[] } | null;
    transactions?: {
      id: string;
      kind: string;
      status: string;
      gateway: string | null;
      test: boolean;
      amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
    }[] | null;
  }> {
    const response = await admin.graphql(ORDER_STATE_QUERY, { variables: { id: orderGid! } });
    const body = (await response.json()) as { data?: { order?: unknown }; errors?: unknown };
    if (body.errors) throw new Error(`order read failed: ${JSON.stringify(body.errors)}`);
    if (!body.data?.order) throw new Error(`order ${orderGid} not found`);
    return body.data.order as never;
  }

  try {
    // ======================================================================
    // 1. A paid TEST order to refund against
    // ======================================================================
    console.log("1. creating a genuine TEST order, paid through the bogus test gateway");
    // ======================================================================
    // WHY NOT A DRAFT ORDER COMPLETED VIA THE MANUAL GATEWAY
    // ======================================================================
    // That was this gate's first attempt, and the safety guard below REFUSED
    // it. Shopify sets `Order.test` from the PAYMENT GATEWAY, not from the
    // store, so a manual-gateway completion on a development store reads
    // `test: false`. No real money could have moved — a dev store has no
    // processor — but the guard cannot know that, and weakening a money guard
    // to make a gate pass is exactly backwards.
    //
    // `orderCreate` accepts `test: true` on both the order and its
    // transaction, which is Shopify's actual test-payment facility.
    const createResponse = await admin.graphql(ORDER_CREATE_MUTATION, {
      variables: {
        order: {
          test: true,
          currency: "USD",
          email: "carat-live-gate-slice8@example.com",
          tags: ["carat-live-gate-slice8"],
          note: "carat-live-gate-slice8 — refund execution verification. Safe to delete.",
          financialStatus: "PAID",
          lineItems: [
            {
              title: "Group Buy live-gate probe — tier adjustment refund test",
              quantity: 1,
              requiresShipping: false,
              taxable: false,
              priceSet: {
                shopMoney: {
                  amount: minorUnitsToDecimal(SALE_PRICE.amountMinorUnits),
                  currencyCode: "USD",
                },
              },
            },
          ],
          transactions: [
            {
              kind: "SALE",
              status: "SUCCESS",
              gateway: "bogus",
              test: true,
              // A FIXTURE REQUIREMENT, NOT AN ADAPTER CONCERN. Shopify rejects
              // a refund whose parent payment has no gateway reference
              // ("Reference can't be blank"), and a SALE minted by
              // `orderCreate` has none unless one is supplied. Every real
              // CaratForUs order carries one — the manual-gateway orders on
              // this store all have a `paymentId` — so this line makes the
              // synthetic order resemble a real payment rather than relaxing
              // anything the adapter does. Proved by probing both candidate
              // fields against the live store; `authorizationCode` alone is
              // sufficient and `receiptJson` is not needed.
              authorizationCode: "carat-live-gate-slice8",
              amountSet: {
                shopMoney: {
                  amount: minorUnitsToDecimal(SALE_PRICE.amountMinorUnits),
                  currencyCode: "USD",
                },
              },
            },
          ],
        },
      },
    });
    const createBody = (await createResponse.json()) as {
      data?: {
        orderCreate?: { order?: { id: string; name: string } | null; userErrors?: { message: string }[] };
      };
      errors?: { message: string }[];
    };
    if (createBody.errors?.length) {
      throw new Error(`orderCreate failed: ${createBody.errors.map((e) => e.message).join("; ")}`);
    }
    if (createBody.data?.orderCreate?.userErrors?.length) {
      throw new Error(
        `orderCreate rejected: ${createBody.data.orderCreate.userErrors.map((e) => e.message).join("; ")}`
      );
    }
    const createdOrder = createBody.data?.orderCreate?.order;
    if (!createdOrder) throw new Error("orderCreate returned no order");
    orderGid = createdOrder.id;
    // Derived from the order Shopify just minted, so it is unique per run.
    IDEMPOTENCY_KEY = `groupbuy_refund_issue:live-gate-slice8:${orderGid}`;
    console.log(`     order ${createdOrder.name} (${orderGid})`);
    console.log(`     idempotency key: ${IDEMPOTENCY_KEY}`);

    const before = await readOrder();

    // THE GUARD AGAINST THIS FILE EVER RUNNING IN PRODUCTION.
    check(
      "order-is-a-test-order",
      before.test === true,
      `order.test is ${before.test} — a false here means real money and this gate must not continue`
    );
    if (before.test !== true) {
      throw new Error("refusing to refund a non-test order");
    }

    const sale = (before.transactions ?? []).find(
      (t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS"
    );
    check(
      "order-has-successful-sale",
      Boolean(sale) && sale?.test === true,
      sale
        ? `${sale.kind}/${sale.status} via ${sale.gateway ?? "?"} for ${sale.amountSet?.shopMoney?.amount}, test=${sale.test}`
        : `no successful SALE/CAPTURE: ${(before.transactions ?? []).map((t) => `${t.kind}/${t.status}`).join(", ") || "(none)"}`
    );

    const lineBefore = before.lineItems?.nodes?.[0];
    const refundableBefore = lineBefore?.refundableQuantity ?? null;
    console.log(
      `     line ${lineBefore?.id ?? "?"}: quantity ${lineBefore?.quantity ?? "?"}, refundableQuantity ${refundableBefore ?? "?"}`
    );

    // ======================================================================
    // 2. The refund, through the real adapter
    // ======================================================================
    console.log("\n2. executing a $12.34 tier-adjustment refund through the production adapter");
    // The adapter runs its OWN echo verification internally and throws if
    // anything disagrees. Reaching the next line is therefore already
    // meaningful; the assertions below re-establish each property
    // independently, from the ORDER rather than from the refund.
    const result = await refunds.createTierAdjustmentRefund({
      orderGid,
      lineItemGid: lineBefore?.id ?? "gid://shopify/LineItem/unknown",
      totalAmountMinorUnits: REFUND_AMOUNT.amountMinorUnits,
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    check("refund-accepted", Boolean(result.reference), `Shopify accepted it (${result.reference})`);

    // ======================================================================
    // 3. What the ORDER says afterwards
    // ======================================================================
    console.log("\n3. reading the ORDER back — not the refund — to see what actually happened to it");
    const after = await readOrder();

    const totalRefunded = after.totalRefundedSet?.shopMoney;
    const totalRefundedMinorUnits = minorUnits(totalRefunded?.amount);
    check(
      "refund-amount-exact",
      totalRefundedMinorUnits === REFUND_AMOUNT.amountMinorUnits,
      `order total refunded ${totalRefunded?.amount ?? "MISSING"} = ${totalRefundedMinorUnits ?? "unreadable"} minor units ` +
        `(approved ${REFUND_AMOUNT.amountMinorUnits})`
    );
    check(
      "refund-currency-correct",
      (totalRefunded?.currencyCode ?? "").toUpperCase() === "USD",
      `refunded in ${totalRefunded?.currencyCode ?? "MISSING"}`
    );
    check("refund-on-correct-order", after.id === orderGid, `refund recorded on ${after.id}`);

    // ======================================================================
    // 4. THE DECISIVE CHECKS — nothing was returned
    // ======================================================================
    console.log("\n4. the decisive part: the customer still has their goods");
    const refundNodes = after.refunds ?? [];
    check(
      "exactly-one-refund-on-order",
      refundNodes.length === 1,
      `the order carries ${refundNodes.length} refund(s): ` +
        refundNodes.map((r) => `${r.id} ${r.totalRefundedSet?.shopMoney?.amount ?? "?"}`).join(", ")
    );
    check(
      "order-total-refunded-exact",
      totalRefundedMinorUnits === REFUND_AMOUNT.amountMinorUnits,
      `no more and no less than the approved figure reached the order`
    );

    // Read the refund itself for the line-item and shipping/duty checks.
    const refundDetail = await admin.graphql(
      `#graphql
        query CaratLiveGateRefundDetail($id: ID!) {
          refund(id: $id) {
            id
            refundLineItems(first: 10) { nodes { quantity restocked restockType } }
            refundShippingLines(first: 10) { nodes { id } }
            duties { amountSet { shopMoney { amount } } }
          }
        }`,
      { variables: { id: result.reference } }
    );
    const refundBody = (await refundDetail.json()) as {
      data?: {
        refund?: {
          refundLineItems?: { nodes?: { quantity: number; restocked: boolean; restockType: string }[] };
          refundShippingLines?: { nodes?: { id: string }[] };
          duties?: { amountSet?: { shopMoney?: { amount: string } | null } | null }[];
        } | null;
      };
    };
    const refundLineItems = refundBody.data?.refund?.refundLineItems?.nodes ?? [];
    const shippingLines = refundBody.data?.refund?.refundShippingLines?.nodes ?? [];
    const duties = refundBody.data?.refund?.duties ?? [];

    check(
      "no-merchandise-returned",
      refundLineItems.length === 0,
      refundLineItems.length === 0
        ? "the refund records ZERO returned line items — a pure monetary adjustment"
        : `the refund records ${refundLineItems.length} returned line item(s): ` +
          refundLineItems.map((l) => `qty ${l.quantity} restocked=${l.restocked}`).join(", ")
    );
    check(
      "no-inventory-restock",
      refundLineItems.every((l) => !l.restocked),
      refundLineItems.length === 0
        ? "nothing was restocked, because no line item was refunded at all"
        : `restock flags: ${refundLineItems.map((l) => `${l.restockType}/${l.restocked}`).join(", ")}`
    );

    // THE ASSERTION THIS GATE EXISTS FOR. A merchandise return would lower
    // this; an unchanged value proves a later RMA or warranty claim on the
    // same line is unaffected by the tier adjustment.
    const lineAfter = after.lineItems?.nodes?.[0];
    check(
      "refundable-quantity-unchanged",
      lineAfter?.refundableQuantity === refundableBefore,
      `refundableQuantity ${refundableBefore ?? "?"} before -> ${lineAfter?.refundableQuantity ?? "?"} after. ` +
        `Unchanged means Shopify recorded NO merchandise return, so the line is still fully claimable.`
    );

    check(
      "no-shipping-or-duty-refunded",
      shippingLines.length === 0 && duties.length === 0,
      `${shippingLines.length} shipping line(s) and ${duties.length} duty refund(s) — the approved settlement ` +
        `covers merchandise only`
    );

    // ======================================================================
    // 5. THE REPLAY — "the same approved settlement must never refund twice"
    // ======================================================================
    // The owner's idempotency list includes a retry AFTER a confirmed success
    // and two concurrent attempts. Both reduce to one question: what does
    // Shopify do when the same key arrives again? Our `idempotency_key` table
    // answers it for our own job, but a lost row, a replayed webhook or a
    // second process bypasses that row — so the question worth proving is
    // whether SHOPIFY refuses, and no mock can answer it.
    //
    // The order still has $487.66 refundable, so nothing but the key stops a
    // second $12.34 from leaving. If this assertion fails, a real duplicate
    // refund will have been created — on a test order, with test money — and
    // that failure is exactly what the gate is for.
    console.log("\n5. replaying the IDENTICAL call with the SAME key — Shopify must refund only once");
    const replay = await refunds.createTierAdjustmentRefund({
      orderGid,
      lineItemGid: lineBefore?.id ?? "gid://shopify/LineItem/unknown",
      totalAmountMinorUnits: REFUND_AMOUNT.amountMinorUnits,
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const afterReplay = await readOrder();
    const replayRefunds = afterReplay.refunds ?? [];
    const replayTotal = minorUnits(afterReplay.totalRefundedSet?.shopMoney?.amount);
    check(
      "replay-same-key-refunds-once",
      replayRefunds.length === 1 && replayTotal === REFUND_AMOUNT.amountMinorUnits,
      `after the replay the order carries ${replayRefunds.length} refund(s) totalling ` +
        `${afterReplay.totalRefundedSet?.shopMoney?.amount ?? "?"} — ` +
        (replayRefunds.length === 1 && replayTotal === REFUND_AMOUNT.amountMinorUnits
          ? "Shopify collapsed the duplicate"
          : "A DUPLICATE REFUND WAS CREATED. The key did not protect the customer's money.")
    );
    check(
      "replay-returns-the-same-refund",
      replay.reference === result.reference,
      `the replay returned ${replay.reference} and the original returned ${result.reference} — ` +
        `identical means the caller can safely retry and still record one processor reference`
    );
  } finally {
    // ======================================================================
    // CLEANUP. The PROOF is this output, not the artifact.
    // ======================================================================
    if (!orderGid) {
      check("cleanup", true, "nothing was created, so nothing to clean up");
    } else {
      let deleted = false;
      let reason = "";
      try {
        const response = await admin.graphql(
          `#graphql
            mutation CaratLiveGateDeleteOrder($orderId: ID!) {
              orderDelete(orderId: $orderId) { deletedId userErrors { field message } }
            }`,
          { variables: { orderId: orderGid } }
        );
        const body = (await response.json()) as {
          data?: { orderDelete?: { deletedId?: string | null; userErrors?: { message: string }[] } };
          errors?: { message: string }[];
        };
        if (body.errors?.length) reason = body.errors.map((e) => e.message).join("; ");
        else if (body.data?.orderDelete?.userErrors?.length) {
          reason = body.data.orderDelete.userErrors.map((e) => e.message).join("; ");
        } else deleted = Boolean(body.data?.orderDelete?.deletedId);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      // A REFUNDED ORDER THAT SHOPIFY WILL NOT DELETE IS NOT A FAILURE. It is
      // a test order on a development store, tagged, and the figures proving
      // this gate are in the output above rather than in the order. Reported
      // rather than silently swallowed, so it can be removed by hand.
      check(
        "cleanup",
        true,
        deleted
          ? `deleted the probe order ${orderGid}`
          : `could NOT delete ${orderGid} (${reason || "no reason given"}) — a test order on the dev store, ` +
            `tagged carat-live-gate-slice8. Remove it by hand if you want it gone; the proof is this output.`
      );
    }
  }
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    const missing = REQUIRED_ASSERTIONS.filter((id) => !executed.has(id));
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required assertion(s) NEVER RAN: ${missing.join(", ")}. ` +
          "NOT a pass, however many PASS lines appear above."
      );
      process.exit(1);
    }
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
