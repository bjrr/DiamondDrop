/**
 * SLICE 9 LIVE GATE — the custom-line price field, against the real Shopify
 * store.
 *
 * ============================================================================
 * THIS GATE EXISTS BECAUSE A MOCK CANNOT CATCH THE BUG IT GUARDS
 * ============================================================================
 * `createServiceDraftOrder` prices its line with
 * `originalUnitPriceWithCurrency`, not the `priceOverride` the variant-line
 * path uses. That distinction has already cost one live defect in this
 * adapter: it originally sent `originalUnitPrice` on variant lines, Shopify
 * neither errored nor coerced — it silently IGNORED the field and priced the
 * line from the catalogue — and no unit test could ever have found it, because
 * a mocked client echoes back whatever it was handed.
 *
 * So the field name is a claim about Shopify's schema that only Shopify can
 * settle. A deposit invoice priced at $0, or at some catalogue default, is a
 * customer charged the wrong amount; that is worth one real API call to rule
 * out.
 *
 * ============================================================================
 * WHAT IT CREATES, AND WHY THAT IS ACCEPTABLE
 * ============================================================================
 * ONE Shopify DRAFT order, tagged `carat-live-gate-slice9`, which it DELETES
 * before exiting — including on failure, via a finally block. A draft order is
 * unpaid, reserves nothing, and no invoice email is sent (this gate never
 * calls `draftOrderInvoiceSend`), so nothing reaches a customer at any point.
 *
 * It touches NO CaratForUs record: it calls the adapter directly rather than
 * going through `issueCustomJewelryDepositInvoice`, precisely so it cannot
 * write an append-only acceptance or invoice row that could never be removed.
 *
 * If the cleanup fails, the surviving draft order is named in the output for
 * manual deletion rather than left silent.
 *
 * RUN: npx tsx tests/live/slice9.depositInvoicePriceField.ts
 */
import "dotenv/config";

import { Money } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";
import { depositInvoiceLineTitle, depositInvoiceTags } from "~/domain/customjewelry/depositInvoice";
import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS, CUSTOM_JEWELRY_DEPOSIT_CURRENCY } from "~/domain/customjewelry/designDepositAcknowledgmentText";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

const REQUIRED_ASSERTIONS = [
  "custom-line-accepted",
  "price-echoed-exactly",
  "no-variant-attached",
  "draft-order-unpaid",
  "cleanup",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  if (executed.has(id)) throw new Error(`assertion id "${id}" used twice — ids must be unique or results mask each other`);
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_DOMAIN must be set — this gate talks to the real store.");
  const customerRaw = process.env.CARAT_LIVE_GATE_CUSTOMER_A?.trim();
  if (!customerRaw) throw new Error("CARAT_LIVE_GATE_CUSTOMER_A is not set — see .env.example.");
  const customerGid = customerRaw.startsWith("gid://")
    ? customerRaw
    : `gid://shopify/Customer/${customerRaw}`;

  console.log(`Slice 9 live gate — custom-line price field against ${SHOP}`);
  console.log("Creates ONE unpaid draft order and deletes it. No email is ever sent.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const adapter = new ShopifyDraftOrderAdapter(admin);

  const amount = Money.fromMinorUnits(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS, CUSTOM_JEWELRY_DEPOSIT_CURRENCY);
  const reference = "CJ-LIVEGATE";
  let draftOrderGid: string | null = null;

  try {
    console.log("1. a custom line with no variant is accepted, and priced as sent");
    // The adapter's own step-5 echo check does the real work here: it THROWS
    // if Shopify returns a price different from the one sent. So reaching the
    // next line at all is the proof, and the assertions below record which
    // specific properties held.
    const created = await adapter.createServiceDraftOrder({
      customerGid,
      // The test customer's own address is not needed — a service order has no
      // shipping — and the email only has to be well-formed; no invoice is sent.
      email: "carat-live-gate-slice9@example.com",
      title: depositInvoiceLineTitle(reference),
      unitPrice: amount,
      note: "carat-live-gate-slice9 — custom-line price field verification. Safe to delete.",
      tags: [...depositInvoiceTags(reference), "carat-live-gate-slice9"],
    });
    draftOrderGid = created.draftOrderGid;

    check(
      "custom-line-accepted",
      Boolean(created.draftOrderGid),
      `Shopify accepted a draft order with ONE custom line and no variantId (${created.draftOrderGid})`
    );

    // Read the order back INDEPENDENTLY of the create response. The adapter
    // already compared the echo, but that echo came from the same mutation;
    // a separate query is what proves the price was persisted rather than
    // merely reflected.
    const response = await admin.graphql(
      `#graphql
        query CaratLiveGateDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            id
            status
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 5) {
              nodes { title quantity originalUnitPrice variant { id } }
            }
          }
        }`,
      { variables: { id: created.draftOrderGid } }
    );
    const body = (await response.json()) as {
      data?: {
        draftOrder?: {
          status: string;
          totalPriceSet?: { shopMoney?: { amount: string; currencyCode: string } };
          lineItems?: { nodes?: { title: string; quantity: number; originalUnitPrice: string; variant?: { id: string } | null }[] };
        } | null;
      };
      errors?: unknown;
    };
    // EVERY Shopify Admin failure arrives on HTTP 200 — checking the body, not
    // response.ok.
    if (body.errors) throw new Error(`GraphQL errors reading the draft order back: ${JSON.stringify(body.errors)}`);
    const readBack = body.data?.draftOrder;
    if (!readBack) throw new Error("the draft order could not be read back");

    const line = readBack.lineItems?.nodes?.[0];
    const sentPriceString = "49.00";
    const total = readBack.totalPriceSet?.shopMoney;

    /**
     * The TOTAL is compared in minor units, not as a string — and that is a
     * real distinction rather than a loosened assertion.
     *
     * The LINE price is a value we send, so it is compared as the exact string
     * we sent: that is the field the ignored-price defect would corrupt, and
     * string equality is the strictest check available. The TOTAL is composed
     * by Shopify from the lines; its decimal formatting is Shopify's
     * (it returns "49.0", not "49.00") and is not something we control. A
     * first version of this gate demanded "49.00" for both and failed on that
     * formatting difference while the price it exists to verify was correct.
     * Comparing the total by VALUE keeps the check exact without asserting
     * something we never claimed.
     */
    const totalMinorUnits =
      total && /^\d+(\.\d{1,2})?$/.test(total.amount)
        ? Money.fromDecimalMajorUnits(total.amount, total.currencyCode, DEFAULT_ROUNDING_RULE_ID).amountMinorUnits
        : null;

    console.log("\n2. the price PERSISTED, read back in a separate query");
    check(
      "price-echoed-exactly",
      line?.originalUnitPrice === sentPriceString &&
        totalMinorUnits === CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS &&
        total?.currencyCode === CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
      `line price ${line?.originalUnitPrice ?? "MISSING"} (sent ${sentPriceString}) and order total ` +
        `${total?.amount ?? "MISSING"} ${total?.currencyCode ?? ""} = ${totalMinorUnits ?? "unparseable"} minor units ` +
        `(expected ${CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS}) — not 0 and not a catalogue default`
    );

    console.log("\n3. the line really is custom — no variant was attached");
    check(
      "no-variant-attached",
      !line?.variant?.id,
      line?.variant?.id
        ? `Shopify attached variant ${line.variant.id} — the line was priced from a catalogue entry, not from what we sent`
        : `no variant on the line, so the price came from originalUnitPriceWithCurrency as intended`
    );

    console.log("\n4. the draft order is unpaid and nothing was sent to anyone");
    check(
      "draft-order-unpaid",
      readBack.status === "OPEN",
      `status ${readBack.status} — a draft order, not a completed or paid one. This gate never calls draftOrderInvoiceSend.`
    );
  } finally {
    // CLEANUP IS AN ASSERTION, not a best effort. A surviving draft order on
    // the production store is a real artifact, so a failure to remove it is
    // reported as a failure rather than swallowed.
    if (draftOrderGid) {
      try {
        await adapter.cancelDraftOrder({ draftOrderGid });
        check("cleanup", true, `deleted the probe draft order ${draftOrderGid}`);
      } catch (error) {
        check(
          "cleanup",
          false,
          `COULD NOT DELETE ${draftOrderGid} — delete it by hand (tagged carat-live-gate-slice9): ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      check("cleanup", true, "nothing was created, so nothing to clean up");
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
    }
    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nLIVE GATE PASSED — all ${REQUIRED_ASSERTIONS.length} required assertions executed and passed against the real store.`
        : `\n${failures} FAILURE(S) — the custom-line price field is NOT proven. Do not issue deposit invoices.`
    );
    process.exitCode = green ? 0 : 1;
  });
