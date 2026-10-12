/**
 * CUSTOM JEWELRY FINAL PURCHASE LIVE GATE — the one combination no mock and no
 * introspection can settle.
 *
 * ============================================================================
 * WHY THIS GATE EXISTS WHEN EVERY INDIVIDUAL FIELD IS ALREADY LIVE-VERIFIED
 * ============================================================================
 * `createCustomJewelryDraftOrder` sends four things, and each one separately is
 * already proven against the real store:
 *
 *   originalUnitPriceWithCurrency   proven by
 *                                   `slice9.depositInvoicePriceField.ts` — a
 *                                   custom line really is priced from it
 *   appliedDiscount (FIXED_AMOUNT)  schema-confirmed by
 *                                   `slice10.redemptionDiscountSchemaIntrospection.ts`
 *   allowDiscountCodesInCheckout    same introspection; readable, so
 *                                   echo-verifiable
 *   paymentTerms (Due on receipt)   proven by the Slice 2C bank payment gate —
 *                                   it is what keeps a completed order UNPAID
 *
 * WHAT IS UNPROVEN IS THE COMBINATION. No existing path sends a CUSTOM line
 * AND an order-level discount AND payment terms together. Introspection proves
 * fields exist and are legal to send; it cannot prove Shopify honours all four
 * on one mutation. And a mocked client echoes back whatever it is handed, so no
 * unit test can either.
 *
 * THE FAILURE THIS RULES OUT IS SPECIFIC AND EXPENSIVE. This adapter has
 * already shipped one defect of exactly this shape: it sent `originalUnitPrice`
 * on variant lines, Shopify neither errored nor coerced — it silently IGNORED
 * the field and charged the catalogue price — and only a live read-back found
 * it. Here, an ignored `appliedDiscount` would invoice a customer the FULL
 * approved price having already taken their $49 deposit and any Let Us Beat
 * Your Quote benefit. On a bespoke piece that is a four-figure overcharge, and
 * our own record would say the balance was correct.
 *
 * ============================================================================
 * WHAT IT CREATES, AND WHY THAT IS ACCEPTABLE
 * ============================================================================
 * TWO Shopify DRAFT orders — one per payment basis, because the payment-terms
 * branch is the thing that differs and a gate that tested one would leave the
 * other unproven — both tagged `carat-live-gate-cj-final`, and both DELETED
 * before exiting, including on failure, via a finally block.
 *
 * A draft order is unpaid, reserves nothing, and no invoice email is ever sent:
 * this gate never calls `draftOrderInvoiceSend`. Nothing reaches a customer at
 * any point.
 *
 * It touches NO CaratForUs record. It calls the adapter DIRECTLY rather than
 * going through `createCustomJewelryFinalPurchase`, precisely so it cannot
 * write an approval package, a final purchase or a bank payment order — rows
 * that are append-only or immutable and could never be removed afterwards.
 *
 * If a cleanup fails, the surviving draft order is named in the output for
 * manual deletion rather than left silent.
 *
 * ============================================================================
 * NOT YET RUN — NEEDS THE OWNER'S GO-AHEAD
 * ============================================================================
 * It creates real objects on the dev store, so it is written and ready rather
 * than executed. Same posture as
 * `slice6.groupBuyRefundExecutionSchemaIntrospection.ts`, which was committed
 * stating plainly that it had not been run.
 *
 * RUN: npx tsx tests/live/customJewelryFinalPurchaseDraftOrder.ts
 */
import "dotenv/config";

import { Money } from "~/domain/money/money";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

/**
 * Every assertion that MUST run for this gate to be a pass.
 *
 * Registered up front and checked at the end, so a gate that threw halfway
 * reports INCOMPLETE rather than counting the PASS lines it managed to print.
 * That distinction is the whole reason the sibling gates have this mechanism:
 * a partial run reads exactly like a clean one in a scrollback.
 */
const REQUIRED_ASSERTIONS = [
  "card-accepted",
  "card-gross-price-persisted",
  "card-discount-persisted",
  "card-no-variant",
  "card-codes-disabled",
  "card-no-payment-terms",
  "bank-accepted",
  "bank-gross-price-persisted",
  "bank-discount-persisted",
  "bank-payment-terms-attached",
  "cleanup",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  if (executed.has(id)) {
    throw new Error(`assertion id "${id}" used twice — ids must be unique or results mask each other`);
  }
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

/** The figures. Deliberately NOT round, so a catalogue default or a dropped discount is unmistakable. */
const GROSS = Money.fromMinorUnits(517_537n, "USD"); // $5,175.37
const CREDIT = Money.fromMinorUnits(14_900n, "USD"); // $49 deposit + $100 benefit
const EXPECTED_BALANCE_MINOR_UNITS = 502_637n; // $5,026.37

const READ_BACK_QUERY = `#graphql
  query CaratLiveGateCustomJewelryDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      allowDiscountCodesInCheckout
      appliedDiscount {
        valueType
        amountSet { shopMoney { amount currencyCode } }
      }
      paymentTerms { paymentTermsName }
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 5) {
        nodes {
          quantity
          originalUnitPrice
          variant { id }
        }
      }
    }
  }`;

interface ReadBack {
  id: string;
  status: string;
  allowDiscountCodesInCheckout: boolean | null;
  appliedDiscount: {
    valueType: string;
    amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
  } | null;
  paymentTerms: { paymentTermsName: string | null } | null;
  totalPriceSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
  lineItems?: { nodes?: { quantity: number; originalUnitPrice: string; variant?: { id: string } | null }[] };
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_DOMAIN must be set — this gate talks to the real store.");
  const customerRaw = process.env.CARAT_LIVE_GATE_CUSTOMER_A?.trim();
  if (!customerRaw) throw new Error("CARAT_LIVE_GATE_CUSTOMER_A is not set — see .env.example.");
  const customerGid = customerRaw.startsWith("gid://")
    ? customerRaw
    : `gid://shopify/Customer/${customerRaw}`;

  console.log(`Custom Jewelry final purchase live gate — against ${SHOP}`);
  console.log("Creates TWO unpaid draft orders and deletes both. No email is ever sent.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const adapter = new ShopifyDraftOrderAdapter(admin);

  const created: string[] = [];

  /** Reads the order back INDEPENDENTLY of the create response. */
  async function readBack(draftOrderGid: string): Promise<ReadBack> {
    const response = await admin.graphql(READ_BACK_QUERY, { variables: { id: draftOrderGid } });
    const body = (await response.json()) as { data?: { draftOrder?: ReadBack | null }; errors?: unknown };
    if (body.errors) throw new Error(`read-back failed: ${JSON.stringify(body.errors)}`);
    const row = body.data?.draftOrder;
    if (!row) throw new Error(`read-back returned no draft order for ${draftOrderGid}`);
    return row;
  }

  try {
    // ======================================================================
    // THE CARD BASIS — custom line + discount, and NO payment terms
    // ======================================================================
    console.log("1. CARD basis: a custom line at the gross price, less a fixed credit");
    // The adapter's own step-5 echo check does the real work: it THROWS if
    // Shopify returns a price, a discount, a valueType or a codes flag
    // different from what was sent. Reaching the next line at all is the
    // proof; the assertions below record which specific properties held after
    // a SEPARATE read.
    const card = await adapter.createCustomJewelryDraftOrder({
      customerGid,
      email: "carat-live-gate-cj-final@example.com",
      shippingAddress: {
        firstName: "Carat",
        lastName: "LiveGate",
        address1: "1 Live Gate Way",
        city: "Austin",
        provinceCode: "TX",
        zip: "78701",
        countryCode: "US",
      },
      title: "Custom Jewelry — live gate probe (CJ-LIVEGATE, approved design v1)",
      grossPrice: GROSS,
      totalCredit: CREDIT,
      creditTitle: "Design Deposit credit + Let Us Beat Your Quote benefit",
      paymentBasis: "card",
      note: "carat-live-gate-cj-final — custom line + discount verification. Safe to delete.",
      tags: ["carat-live-gate-cj-final"],
    });
    created.push(card.draftOrderGid);
    check("card-accepted", Boolean(card.draftOrderGid), `Shopify accepted it (${card.draftOrderGid})`);

    const cardRow = await readBack(card.draftOrderGid);
    const cardLine = cardRow.lineItems?.nodes?.[0];

    console.log("\n2. the GROSS price persisted — not the balance, not a catalogue default");
    check(
      "card-gross-price-persisted",
      cardLine?.originalUnitPrice === "5175.37",
      `line price ${cardLine?.originalUnitPrice ?? "MISSING"} (sent 5175.37). The gross price must reach ` +
        `Shopify so the sale is recorded at what the piece sold for.`
    );

    console.log("\n3. the CREDIT persisted as an exact fixed amount");
    const cardDiscount = cardRow.appliedDiscount?.amountSet?.shopMoney;
    const cardTotal = cardRow.totalPriceSet?.shopMoney;
    // THE ASSERTION THIS GATE EXISTS FOR. An ignored appliedDiscount invoices
    // the full price having already taken the deposit and the benefit.
    //
    // The TOTAL is compared by VALUE rather than as a string: Shopify composes
    // it and its decimal formatting is Shopify's, not ours. The sibling gate
    // learned that the hard way — it demanded "49.00" and failed on Shopify
    // returning "49.0" while the price it existed to verify was correct.
    const cardTotalMinorUnits =
      cardTotal && /^\d+(\.\d{1,2})?$/.test(cardTotal.amount)
        ? BigInt(cardTotal.amount.split(".")[0]!) * 100n +
          BigInt((cardTotal.amount.split(".")[1] ?? "").padEnd(2, "0"))
        : null;
    check(
      "card-discount-persisted",
      cardRow.appliedDiscount?.valueType === "FIXED_AMOUNT" &&
        cardDiscount?.amount === "149.00" &&
        cardDiscount?.currencyCode === "USD" &&
        cardTotalMinorUnits === EXPECTED_BALANCE_MINOR_UNITS,
      `valueType ${cardRow.appliedDiscount?.valueType ?? "MISSING"}, discount ` +
        `${cardDiscount?.amount ?? "MISSING"} ${cardDiscount?.currencyCode ?? ""} (sent 149.00 USD), total ` +
        `${cardTotal?.amount ?? "MISSING"} = ${cardTotalMinorUnits ?? "unparseable"} minor units ` +
        `(expected ${EXPECTED_BALANCE_MINOR_UNITS} — the balance after a $49 deposit and a $100 benefit)`
    );

    console.log("\n4. the line really is custom — no variant was attached");
    check(
      "card-no-variant",
      !cardLine?.variant?.id,
      cardLine?.variant?.id
        ? `Shopify attached variant ${cardLine.variant.id} — the line was priced from a catalogue entry`
        : "no variant, so the price came from originalUnitPriceWithCurrency as intended"
    );

    console.log("\n5. further discount codes are refused at checkout");
    check(
      "card-codes-disabled",
      cardRow.allowDiscountCodesInCheckout === false,
      `allowDiscountCodesInCheckout ${String(cardRow.allowDiscountCodesInCheckout)} — a code typed here ` +
        `would reduce an approved custom price`
    );

    console.log("\n6. the CARD order carries NO payment terms");
    // The opposite of the bank case, for the opposite reason: a card purchase
    // is paid THROUGH Shopify's checkout, so it should become paid exactly
    // when the customer pays. Terms here would leave it owed instead.
    check(
      "card-no-payment-terms",
      cardRow.paymentTerms === null,
      `paymentTerms ${cardRow.paymentTerms?.paymentTermsName ?? "null"} — a card order must have none, so ` +
        `it becomes paid when the customer pays`
    );

    // ======================================================================
    // THE BANK BASIS — the same, PLUS payment terms
    // ======================================================================
    console.log("\n7. BANK basis: the same line and credit, plus Due-on-receipt terms");
    const bank = await adapter.createCustomJewelryDraftOrder({
      customerGid,
      email: "carat-live-gate-cj-final@example.com",
      shippingAddress: {
        firstName: "Carat",
        lastName: "LiveGate",
        address1: "1 Live Gate Way",
        city: "Austin",
        provinceCode: "TX",
        zip: "78701",
        countryCode: "US",
      },
      title: "Custom Jewelry — live gate probe (CJ-LIVEGATE, approved design v1)",
      grossPrice: GROSS,
      totalCredit: CREDIT,
      creditTitle: "Design Deposit credit + Let Us Beat Your Quote benefit",
      paymentBasis: "bank_payment",
      note: "carat-live-gate-cj-final — bank basis. Safe to delete.",
      tags: ["carat-live-gate-cj-final"],
    });
    created.push(bank.draftOrderGid);
    check("bank-accepted", Boolean(bank.draftOrderGid), `Shopify accepted it (${bank.draftOrderGid})`);

    const bankRow = await readBack(bank.draftOrderGid);
    const bankLine = bankRow.lineItems?.nodes?.[0];
    const bankDiscount = bankRow.appliedDiscount?.amountSet?.shopMoney;

    check(
      "bank-gross-price-persisted",
      bankLine?.originalUnitPrice === "5175.37",
      `line price ${bankLine?.originalUnitPrice ?? "MISSING"} (sent 5175.37)`
    );

    // THE COMBINATION THIS GATE IS REALLY FOR: does the discount still hold
    // when payment terms are also attached? Nothing else in this codebase
    // sends both.
    check(
      "bank-discount-persisted",
      bankRow.appliedDiscount?.valueType === "FIXED_AMOUNT" && bankDiscount?.amount === "149.00",
      `valueType ${bankRow.appliedDiscount?.valueType ?? "MISSING"}, discount ` +
        `${bankDiscount?.amount ?? "MISSING"} — the discount must survive alongside payment terms, which no ` +
        `other path in this codebase sends together`
    );

    console.log("\n8. the BANK order is owed, not paid — §22");
    check(
      "bank-payment-terms-attached",
      bankRow.paymentTerms !== null,
      `paymentTerms ${bankRow.paymentTerms?.paymentTermsName ?? "MISSING"} — without them, completing this ` +
        `draft produces an order Shopify marks PAID, asserting a receipt nobody has seen`
    );
  } finally {
    // CLEANUP IS AN ASSERTION, not a best effort. A surviving draft order on
    // the dev store is a real artifact, so a failure to remove one is reported
    // as a failure rather than swallowed.
    const survivors: string[] = [];
    for (const draftOrderGid of created) {
      try {
        await adapter.cancelDraftOrder({ draftOrderGid });
      } catch {
        survivors.push(draftOrderGid);
      }
    }
    check(
      "cleanup",
      survivors.length === 0,
      survivors.length === 0
        ? `deleted ${created.length} probe draft order(s)`
        : `COULD NOT DELETE ${survivors.join(", ")} — delete by hand (tagged carat-live-gate-cj-final)`
    );
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
    if (failures > 0) {
      console.log(
        "Do NOT treat `createCustomJewelryDraftOrder` as live-proven. An ignored discount field invoices a\n" +
          "customer the full approved price having already taken their deposit — the same silent-ignore\n" +
          "failure mode that once charged catalogue price on every Bank Payment line."
      );
    }
    process.exit(failures === 0 ? 0 : 1);
  });
