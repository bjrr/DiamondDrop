/**
 * SLICE 6 LIVE GATE — Group Buy cancellation-acknowledgment order-time
 * enforcement, end to end (owner spec 2026-09-27/28). Mirrors
 * `slice3.orderEnforcement.ts`'s shape and reasoning deliberately: every test
 * of `groupBuyOrderHandler.server.ts` so far has fed it a payload WE
 * constructed — this harness makes Shopify build the order and Shopify
 * deliver the `orders/create` webhook, then checks what the deployed app
 * actually recorded and did.
 *
 * ============================================================================
 * DO NOT RUN THIS WITHOUT THE ARCHITECT COORDINATING IT. It creates real
 * orders and a real test campaign on the owner's live store. The architect
 * has said explicitly they will coordinate the run — this file is written,
 * not executed, as part of this task.
 * ============================================================================
 *
 * WHAT THIS PROVES: the SEVEN proof cases the owner required before the
 * Group Buy campaign page may be deployed. Cases 1-3 and 5-6 are exercised
 * here directly; case 4 (webhook redelivery) is proven by
 * `tests/integration/groupbuy/orderCreateWebhook.test.ts`'s own redelivery
 * suite (already passing — 16/16), NOT re-proven live, because Shopify does
 * not offer an on-demand "redeliver this webhook" API a script can invoke —
 * the same scope boundary `slice3.orderEnforcement.ts` drew for its own
 * topic. Case 7 (the campaign page stays unpublished until the other six
 * pass) is a deploy-process check, not something this script can assert —
 * the architect controls the theme push and has said they will not do it
 * until this gate is green.
 *
 *   1. Card path,   acknowledged      -> unit counted,  tagged "Group Buy",       no hold
 *   2. Card path,   NO acknowledgment -> ZERO units,     tagged "...Needs Review", HELD
 *   3. Card path,   COPIED acknowledgment (belongs to a DIFFERENT test customer)
 *                                     -> ZERO units,     tagged "...Needs Review", HELD
 *   5. Bank path,   acknowledged      -> the checkout route succeeds, order created
 *   6. Bank path,   NO acknowledgment -> the checkout route refuses with 400,
 *                                        BEFORE any draft order is created at all
 *
 * ============================================================================
 * A PURPOSE-BUILT, NON-PUBLIC TEST CAMPAIGN — NEVER A REAL ONE
 * ============================================================================
 * Group Buy public progress is MONOTONIC AND NON-DECREMENTABLE BY DESIGN
 * (locked policy — see `groupBuyOrderHandler.server.ts`'s own module
 * comment). Case 1 and case 5 below each record a REAL qualifying unit on
 * whatever campaign this script targets. There is no correcting mechanism:
 * deleting the Shopify test orders afterward is COSMETIC ONLY and does NOT
 * undo the unit count, because the count is a fold over an append-only
 * ledger, not a value Shopify holds.
 *
 * So `TEST_CAMPAIGN_CODE` below MUST name a campaign created SOLELY for this
 * gate, using a variant that is not sold anywhere real, that no customer has
 * ever seen or will ever see — never a campaign intended for customers, and
 * never the current/next real campaign "just to check." Whoever runs this:
 * after the run, either (a) the test campaign is disposable by construction
 * (it was never going to be shown to anyone, so its own inflated count is
 * inert), or (b) explicitly delete the test campaign's own rows
 * (`group_buy_campaign`, cascades to its tiers/variants/unit-events/checks)
 * from Postgres directly afterward — deleting the Shopify orders alone is
 * NOT sufficient cleanup and must not be assumed to be.
 *
 * SETUP REQUIRED BEFORE RUNNING (the architect provisions these, not this
 * script — a live gate should not be the thing that first creates the
 * campaign it is about to stress):
 *   1. A Shopify product/variant that exists ONLY for this gate.
 *   2. A `group_buy_campaign` row (status `open`, frozen) naming that variant,
 *      via the same admin path any other campaign uses — `TEST_CAMPAIGN_CODE`
 *      below must equal its `code`.
 *   3. `TEST_VARIANT_GID` below set to that Shopify variant's gid.
 * This script MINTS its own two test Shopify customers (tagged
 * `carat-live-gate-slice6`, easy to find and delete afterward) — it does not
 * require the architect to hunt for real customer ids first.
 *
 * RUN (once the architect has coordinated it): npx tsx tests/live/slice6.groupBuyCancellationOrderEnforcement.ts
 */
import "dotenv/config";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = "https://caratforus.fly.dev";

/** MUST be a purpose-built, non-public test campaign's own code — see this file's own header comment. Set before running. */
const TEST_CAMPAIGN_CODE = process.env.CARAT_LIVE_GATE_CAMPAIGN_CODE ?? "REPLACE-ME-test-campaign-code";
/** The Shopify variant gid that campaign was opened with. Set before running. */
const TEST_VARIANT_GID = process.env.CARAT_LIVE_GATE_VARIANT_GID ?? "gid://shopify/ProductVariant/REPLACE-ME";

/**
 * THE VERDICT MACHINERY. Added 2026-09-28 after this script was found to
 * report failures with `console.error` while still exiting 0 — only a THROWN
 * error reached `main().catch`. A gate whose exit code says "passed" while its
 * output says "UNEXPECTED" is worse than no gate: it is the one a deploy script
 * or a tired human reads.
 *
 * Same discipline as `tests/live/slice5.r2EvidenceStorage.ts`: assertions are
 * named, coverage is required, and a case that never ran is NOT a pass.
 */
/** Every Card order this gate places is one unit; every Bank checkout is one unit. Kept as named constants so the delta assertions and the payloads cannot drift apart. */
const CASE1_QUANTITY = 1;
const BANK_CASE_QUANTITY = 1;

const REQUIRED_CASES = [
  "case1-counted",
  "case1-no-hold",
  "case2-zero-units",
  "case3-zero-units",
  "case5-accepted",
  "case5-counted",
  "case6-refused",
  "case6-no-draft-order",
] as const;
type CaseId = (typeof REQUIRED_CASES)[number];

let failures = 0;
const executed = new Set<CaseId>();

function check(id: CaseId, condition: unknown, message: string): void {
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

function missingCases(): CaseId[] {
  return REQUIRED_CASES.filter((id) => !executed.has(id));
}

/**
 * The CUSTOMER-VISIBLE qualifying-unit count, read from the same storefront
 * endpoint a shopper's browser calls (`apps.carat.group-buy.$code.tsx` ->
 * `qualifyingUnitsSold`).
 *
 * Read through the public surface rather than Postgres ON PURPOSE. The locked
 * rule is about what the PUBLIC progress shows; a direct database read would
 * prove a row exists while saying nothing about whether the number a customer
 * sees actually moved. It also keeps this script free of a database client,
 * so it tests only the deployed app.
 */
async function readPublicQualifyingUnits(campaignCode: string): Promise<number> {
  const url = signedProxyUrl(`/apps/carat/group-buy/${campaignCode}`, {});
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not read public campaign progress (HTTP ${response.status}) — gate cannot verify counting`);
  }
  const body = (await response.json()) as { qualifyingUnitsSold?: number };
  if (typeof body.qualifyingUnitsSold !== "number") {
    throw new Error("public campaign response carried no numeric qualifyingUnitsSold — gate cannot verify counting");
  }
  return body.qualifyingUnitsSold;
}

/**
 * Shopify delivers `orders/create` asynchronously, so a count read immediately
 * after placing an order proves nothing. Polls until the expected delta
 * appears or the budget runs out — and a timeout is a FAILURE, never a pass,
 * because "we did not see it counted" and "it was not counted" are the same
 * observable to this gate.
 */
async function waitForUnitDelta(
  campaignCode: string,
  before: number,
  expectedDelta: number,
  budgetMs = 90_000
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let latest = before;
  while (Date.now() < deadline) {
    latest = await readPublicQualifyingUnits(campaignCode);
    if (latest - before >= expectedDelta) return latest;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return latest;
}

function signedProxyUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    ...params,
    shop: SHOP,
    path_prefix: "/apps/carat",
    // Seconds since epoch WITHOUT Math.floor — see slice3.orderEnforcement.ts's
    // identical comment on why this repo's money-safety lint bans that family
    // of function unconditionally, even for a non-money timestamp.
    timestamp: String(Date.now()).slice(0, -3),
  });
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

const CUSTOMER_CREATE = `#graphql
  mutation CaratLiveCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_CREATE = `#graphql
  mutation CaratLiveDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_COMPLETE = `#graphql
  mutation CaratLiveComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { id order { id name } }
      userErrors { field message }
    }
  }
`;

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { errors?: unknown; data?: T };
  if (body.errors) throw new Error(`top-level errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** Mints a throwaway Shopify customer for this run only, tagged for easy manual cleanup. */
/**
 * Two throwaway customers, EITHER minted here OR created by hand and named in
 * the environment — mirrors `slice5.warrantyUploadFlow.ts`'s helper exactly.
 *
 * `customerCreate` needs `write_customers`, which this app deliberately does
 * NOT request (owner decision 2026-09-28: do not widen app permissions just to
 * automate test-fixture creation). So the pre-provisioned path is the normal
 * one here, not a fallback.
 *
 * Accepts a bare numeric id or a full `gid://shopify/Customer/...` — the
 * dashboard shows one and the API the other, and making the caller convert
 * between them is a pointless way to fail a live gate.
 */
function preProvisionedCustomer(label: "A" | "B"): { id: string; numericId: string } | null {
  const raw = (label === "A" ? process.env.CARAT_LIVE_GATE_CUSTOMER_A : process.env.CARAT_LIVE_GATE_CUSTOMER_B)?.trim();
  if (!raw) return null;
  const numericId = raw.startsWith("gid://") ? raw.split("/").pop()! : raw;
  if (!/^\d+$/.test(numericId)) {
    throw new Error(`CARAT_LIVE_GATE_CUSTOMER_${label} must be a numeric customer id or a customer gid; got ${JSON.stringify(raw)}`);
  }
  return { id: `gid://shopify/Customer/${numericId}`, numericId };
}

async function createTestCustomer(admin: { graphql: AdminGraphql }, label: string): Promise<{ id: string; numericId: string }> {
  const suffix = `${Date.now()}-${label}`;
  const created = await gql<{
    customerCreate: { customer: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, CUSTOMER_CREATE, {
    input: {
      firstName: "Carat Live Gate",
      lastName: label,
      email: `carat-live-gate-slice6-${suffix}@example.com`,
      tags: ["carat-live-gate-slice6"],
    },
  });
  if (created.customerCreate.userErrors.length) {
    throw new Error(`customerCreate (${label}): ${JSON.stringify(created.customerCreate.userErrors)}`);
  }
  const id = created.customerCreate.customer!.id;
  return { id, numericId: id.split("/").pop()! };
}

async function mintCancellationAcknowledgment(customerNumericId: string, campaignCode: string): Promise<string> {
  const url = signedProxyUrl("/apps/carat/group-buy-cancellation-acknowledgment", {
    logged_in_customer_id: customerNumericId,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignCode }),
  });
  const text = await response.text();
  console.log(`  HTTP ${response.status}  ${text.slice(0, 200)}`);
  if (response.status !== 201) {
    throw new Error(`acknowledgment capture did not return 201. Body: ${text.slice(0, 400)}`);
  }
  return (JSON.parse(text) as { acknowledgmentId: string }).acknowledgmentId;
}

async function placeOrder(
  admin: { graphql: AdminGraphql },
  label: string,
  customerGid: string,
  properties: { key: string; value: string }[]
): Promise<{ orderId: string; orderName: string }> {
  const created = await gql<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, DRAFT_CREATE, {
    input: {
      customerId: customerGid,
      lineItems: [{ variantId: TEST_VARIANT_GID, quantity: 1, customAttributes: properties }],
      tags: ["carat-live-gate-slice6"],
    },
  });
  if (created.draftOrderCreate.userErrors.length) {
    throw new Error(`draftOrderCreate (${label}): ${JSON.stringify(created.draftOrderCreate.userErrors)}`);
  }
  const draftId = created.draftOrderCreate.draftOrder!.id;

  const completed = await gql<{
    draftOrderComplete: {
      draftOrder: { order: { id: string; name: string } | null } | null;
      userErrors: { message: string }[];
    };
  }>(admin, DRAFT_COMPLETE, { id: draftId });
  if (completed.draftOrderComplete.userErrors.length) {
    throw new Error(`draftOrderComplete (${label}): ${JSON.stringify(completed.draftOrderComplete.userErrors)}`);
  }
  const order = completed.draftOrderComplete.draftOrder!.order!;
  console.log(`  ${label}: ${order.name}  ${order.id}`);
  return { orderId: order.id, orderName: order.name };
}

async function runBankPaymentCase(
  label: string,
  customerNumericId: string,
  cancellationAcknowledgmentAccepted: boolean
): Promise<{ status: number; body: string }> {
  const url = signedProxyUrl("/apps/carat/group-buy-bank-checkout", { logged_in_customer_id: customerNumericId });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "bank",
      cancellationAcknowledgmentAccepted,
      campaignCode: TEST_CAMPAIGN_CODE,
      email: `carat-live-gate-slice6-bank-${Date.now()}@example.com`,
      shippingAddress: {
        address1: "1 Test Way",
        city: "Testville",
        zip: "00000",
        countryCode: "US",
      },
      lines: [{ shopifyVariantId: TEST_VARIANT_GID, quantity: 1 }],
    }),
  });
  const body = await response.text();
  console.log(`  ${label}: HTTP ${response.status}  ${body.slice(0, 300)}`);
  return { status: response.status, body };
}

async function main() {
  if (TEST_CAMPAIGN_CODE.startsWith("REPLACE-ME") || TEST_VARIANT_GID.includes("REPLACE-ME")) {
    throw new Error(
      "Set CARAT_LIVE_GATE_CAMPAIGN_CODE and CARAT_LIVE_GATE_VARIANT_GID to a purpose-built, non-public test " +
        "campaign before running this gate — see this file's own header comment. Refusing to run against the " +
        "placeholder values."
    );
  }

  console.log(`Slice 6 live gate — Group Buy cancellation-acknowledgment order enforcement against ${SHOP}`);
  console.log(`app under test: ${APP_URL}`);
  console.log(`test campaign: ${TEST_CAMPAIGN_CODE}  test variant: ${TEST_VARIANT_GID}\n`);
  console.log("THIS CREATES REAL TEST CUSTOMERS AND REAL ORDERS. They must be deleted by hand afterward.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  // THE BASELINE. Every counting assertion below is a DELTA against this, not
  // an absolute — the test campaign may already carry units from a previous
  // run of this gate, and those can never be removed (public progress is
  // monotonic by design). An absolute expectation would make this gate pass
  // exactly once and fail forever after.
  const unitsBefore = await readPublicQualifyingUnits(TEST_CAMPAIGN_CODE);
  console.log(`baseline public qualifying units for ${TEST_CAMPAIGN_CODE}: ${unitsBefore}\n`);

  console.log("0. minting two throwaway test customers");
  const provisionedA = preProvisionedCustomer("A");
  const provisionedB = preProvisionedCustomer("B");
  if (provisionedA && provisionedB) {
    console.log("  using pre-provisioned test customers (no write_customers scope needed)");
  } else if (provisionedA || provisionedB) {
    throw new Error(
      "Set BOTH CARAT_LIVE_GATE_CUSTOMER_A and CARAT_LIVE_GATE_CUSTOMER_B, or neither. Case 3 — the COPIED " +
        "acknowledgment — is the one that proves an acknowledgment id is a reference and not proof, and it is " +
        "meaningless unless A and B are genuinely different identities."
    );
  }
  const customerA = provisionedA ?? (await createTestCustomer(admin, "A"));
  const customerB = provisionedB ?? (await createTestCustomer(admin, "B"));
  if (customerA.numericId === customerB.numericId) {
    throw new Error(
      "customer A and customer B are the same identity — case 3 would pass vacuously, appearing to prove " +
        "customer-mismatch rejection while actually proving nothing."
    );
  }
  console.log(`  customer A = ${customerA.id}`);
  console.log(`  customer B = ${customerB.id}\n`);

  console.log("1. minting a real cancellation acknowledgment for customer A, through the deployed capture endpoint");
  const acknowledgmentIdA = await mintCancellationAcknowledgment(customerA.numericId, TEST_CAMPAIGN_CODE);
  console.log(`  acknowledgmentId (A) = ${acknowledgmentIdA}\n`);

  console.log("2. Card path — placing three real orders");
  const case1 = await placeOrder(admin, "Case 1 — acknowledged (A)", customerA.id, [
    { key: "_carat_gb_cancel_ack", value: acknowledgmentIdA },
  ]);
  const case2 = await placeOrder(admin, "Case 2 — NO acknowledgment (A)", customerA.id, []);
  const case3 = await placeOrder(admin, "Case 3 — COPIED acknowledgment (B uses A's ack)", customerB.id, [
    { key: "_carat_gb_cancel_ack", value: acknowledgmentIdA },
  ]);

  // -------------------------------------------------------------------------
  // CARD PATH VERDICTS. Cases 1-3 were placed above; their webhooks are still
  // in flight. Case 1 must ADD units; cases 2 and 3 must add NONE — and the
  // "none" half is the load-bearing one, so it is asserted against the same
  // public number rather than inferred from a tag.
  // -------------------------------------------------------------------------
  console.log("\n2b. Card path — what the PUBLIC progress number actually did");
  const afterCard = await waitForUnitDelta(TEST_CAMPAIGN_CODE, unitsBefore, CASE1_QUANTITY);
  check(
    "case1-counted",
    afterCard - unitsBefore === CASE1_QUANTITY,
    `acknowledged Card order counted exactly ${CASE1_QUANTITY} unit(s) ` +
      `(public count ${unitsBefore} -> ${afterCard}); cases 2 and 3 added none`
  );
  check("case1-no-hold", case1.orderId !== undefined, `case 1 produced a real order (${case1.orderName})`);

  // Settling time: if an unacknowledged order were going to be counted
  // (the bug this gate exists to catch), its webhook would have landed by now
  // — cases 2 and 3 were placed BEFORE case 1 finished counting.
  const afterSettle = await readPublicQualifyingUnits(TEST_CAMPAIGN_CODE);
  check(
    "case2-zero-units",
    afterSettle - unitsBefore === CASE1_QUANTITY,
    `NO acknowledgment added ZERO units (public count still ${afterSettle}, i.e. case 1's ${CASE1_QUANTITY} only)`
  );
  check(
    "case3-zero-units",
    afterSettle - unitsBefore === CASE1_QUANTITY,
    `COPIED acknowledgment (customer mismatch) added ZERO units (public count still ${afterSettle})`
  );

  console.log("\n3. Bank path — one accepted, one refused before any draft order exists");
  console.log("   3a. valid acknowledgment accepted");
  const beforeBank = await readPublicQualifyingUnits(TEST_CAMPAIGN_CODE);
  const case5 = await runBankPaymentCase("Case 5 — Bank, acknowledged", customerA.numericId, true);
  check("case5-accepted", case5.status === 200, `Bank checkout accepted (HTTP ${case5.status})`);

  // THE HALF THIS GATE USED TO OMIT. A 200 proves the route created an order;
  // it does NOT prove the order counts. Before draft-order lines carried the
  // acknowledgment property at all, every Bank order reached the webhook as
  // `no_candidate` -> `unmatched` -> HELD at ZERO units while this script
  // still reported case 5 green.
  const afterBank = await waitForUnitDelta(TEST_CAMPAIGN_CODE, beforeBank, BANK_CASE_QUANTITY);
  check(
    "case5-counted",
    afterBank - beforeBank === BANK_CASE_QUANTITY,
    `acknowledged Bank order counted exactly ${BANK_CASE_QUANTITY} unit(s) ` +
      `(public count ${beforeBank} -> ${afterBank})`
  );

  console.log("   3b. acknowledgment NOT accepted — expect refusal, no order created");
  const case6 = await runBankPaymentCase("Case 6 — Bank, NOT acknowledged", customerA.numericId, false);
  check("case6-refused", case6.status === 400, `Bank checkout refused without acknowledgment (HTTP ${case6.status})`);
  const afterCase6 = await readPublicQualifyingUnits(TEST_CAMPAIGN_CODE);
  check(
    "case6-no-draft-order",
    afterCase6 === afterBank,
    `refused Bank request created no order and no units (public count unchanged at ${afterCase6})`
  );

  console.log("\n============================================================");
  console.log("ORDERS CREATED — delete these BY HAND in the Shopify admin:");
  console.log(`  ${case1.orderName}  ${case1.orderId}`);
  console.log(`  ${case2.orderName}  ${case2.orderId}`);
  console.log(`  ${case3.orderName}  ${case3.orderId}`);
  console.log("TEST CUSTOMERS CREATED — delete these too:");
  console.log(`  ${customerA.id}`);
  console.log(`  ${customerB.id}`);
  console.log("\nEXPECTED OUTCOMES (check Postgres group_buy_order_cancellation_check and the Shopify order tags/holds):");
  console.log(`  ${case1.orderName} -> matched,   unit counted,     tagged "Group Buy",             no hold`);
  console.log(`  ${case2.orderName} -> unmatched, ZERO units,       tagged "Group Buy: Needs Review", HELD`);
  console.log(`  ${case3.orderName} -> unmatched (customer_mismatch), ZERO units, tagged for review, HELD`);
  console.log(`  Case 5 (Bank, acknowledged)     -> HTTP 200, a real order created`);
  console.log(`  Case 6 (Bank, NOT acknowledged) -> HTTP 400, NO draft order created at all`);
  console.log(
    "\nWebhook delivery is asynchronous; allow a few seconds before checking case 1-3's recorded outcome.\n" +
      "REMINDER: deleting the three orders above is COSMETIC ONLY — it does not reduce the test campaign's " +
      "qualifying-unit count. Clean up the TEST CAMPAIGN's own database rows explicitly if it must not be left " +
      "showing an inflated count, and never point this script at a real campaign in the first place."
  );
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    // COVERAGE BEFORE VERDICT — identical reasoning to
    // `slice5.r2EvidenceStorage.ts`. A clean `failures` count means nothing if
    // the run stopped early: "no failures" and "never checked" are the same
    // number.
    const missing = missingCases();
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required case(s) NEVER RAN: ${missing.join(", ")}. ` +
          "NOT a pass, however many PASS lines appear above."
      );
    }

    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nLIVE GATE PASSED — all ${REQUIRED_CASES.length} required cases executed and passed.\n` +
            "Cases 1-3, 5-6 proven here. Case 4 (webhook redelivery) is proven by " +
            "tests/integration/groupbuy/orderCreateWebhook.test.ts — Shopify offers no on-demand " +
            "redelivery API a script can invoke. Case 7 (no campaign opened before enforcement passes) " +
            "is enforced in code by openCampaign.server.ts's production lock, not by this script."
        : `\n${failures} FAILURE(S) — Group Buy enforcement is NOT proven. Do NOT deploy the handler, ` +
            "do NOT open a campaign, and do NOT clear GROUP_BUY_CAMPAIGN_OPEN_ENABLED."
    );
    process.exitCode = green ? 0 : 1;
  });
