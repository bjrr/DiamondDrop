/**
 * PRODUCTION BANK PAYMENT CONFIGURATION GATE (owner requirement 2026-10-04).
 *
 * Proves that Group Buy Bank Payment checkout works now that the five
 * `PAYMENT_*` secrets are configured, and — just as importantly — that the
 * fail-closed branch which refuses an order when they are NOT configured is
 * still intact.
 *
 * ============================================================================
 * NO SECRET VALUE IS EVER PRINTED
 * ============================================================================
 * Every assertion about a coordinate is phrased as a CONTAINMENT CHECK whose
 * result is a boolean. The value is read, compared, and discarded; it is never
 * echoed into a message, a label, or a failure string. Where a failure needs
 * to say WHICH coordinate was wrong, it names the VARIABLE, never the value.
 * `redactedSummary()` is used for anything log-shaped.
 *
 * ============================================================================
 * WHY THIS NEEDS THE COORDINATES LOCALLY, AND WHY IT REFUSES WITHOUT THEM
 * ============================================================================
 * The email is sent BY THE DEPLOYED APP to a customer mailbox this gate cannot
 * read. So "the Zelle instructions contain the configured Zelle destination"
 * cannot be observed from outside; it can only be proven by building the email
 * with the SAME pure function the route uses and the SAME coordinates, then
 * checking containment.
 *
 * That requires the five values to be resolvable here. If they are not, the
 * honest outcome is an INCOMPLETE gate, not a quiet skip — a clean failure
 * count with assertions that never ran is exactly the shape of a false pass
 * this project has been bitten by before. So the coordinate assertions are
 * declared REQUIRED and the gate exits non-zero when they cannot execute.
 *
 * WHAT IS OBSERVED LIVE vs COMPOSED, stated plainly so nobody over-reads it:
 *   - observed live: the checkout no longer 503s; a real order is created;
 *     its reference, amount and deadline come from the real row; the order is
 *     still unverified afterwards.
 *   - composed: the EMAIL BODY, built here from the same function and the same
 *     coordinates the route resolves. The route's own send is exercised live
 *     (the checkout succeeds, and `instructions_email_sent` is logged), but
 *     its rendered text is not retrievable, so its CONTENT is proven by
 *     construction rather than by reading the delivered message.
 *
 * ============================================================================
 * CREATES REAL DATA. One real Group Buy Bank Payment order on the test
 * campaign, which counts a REAL MONOTONIC UNIT that can never be withdrawn.
 * Point it at a `zz-live-gate-` campaign only.
 * ============================================================================
 *
 * RUN: npx tsx tests/live/slice6.bankPaymentConfiguration.ts
 *   DATABASE_URL must point at the production database.
 */
import "dotenv/config";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = process.env.CARAT_LIVE_GATE_APP_URL ?? "https://caratforus.fly.dev";
const CAMPAIGN_CODE = process.env.CARAT_LIVE_GATE_CAMPAIGN_CODE ?? "";
const VARIANT_GID = process.env.CARAT_LIVE_GATE_VARIANT_GID ?? "";
const CUSTOMER = (process.env.CARAT_LIVE_GATE_CUSTOMER_A ?? "").trim();

/**
 * EMAIL DOMAIN: example.com, NOT example.invalid.
 *
 * The first run of this gate failed with Shopify userError "email: Email
 * contains an invalid domain name". `.invalid` is reserved by RFC 2606 so it
 * can never resolve — which is exactly why it looked like the responsible
 * choice for synthetic data, and exactly why Shopify rejects it. example.com
 * is also reserved but is a real, resolvable TLD, and is what the other live
 * gates already use.
 *
 * QUANTITY IS CONFIGURABLE for one reason: the checkout idempotency key is
 * hash(customerGid, campaignId, lines) and does NOT include the email. So a
 * retry after a failure sends a byte-identical request and collides with the
 * prior key. Varying the quantity gives a fresh key without creating another
 * campaign — and campaigns cannot be deleted, so not creating one matters.
 */
const QUANTITY = Number(process.env.CARAT_LIVE_GATE_BANK_QUANTITY ?? "1");

const REQUIRED_ASSERTIONS = [
  "checkout-not-503",
  "order-reference-correct",
  "amount-due-correct",
  "email-states-amount-and-reference",
  "deadline-from-actual-order",
  "instructions-name-both-methods",
  "zelle-destination-present",
  "wire-details-present",
  "incomplete-config-fails-closed",
  "no-secret-in-logs",
  "staff-verification-still-required",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

function missingAssertions(): AssertionId[] {
  return REQUIRED_ASSERTIONS.filter((id) => !executed.has(id));
}

function signedProxyUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    ...params,
    shop: SHOP,
    path_prefix: "/apps/carat",
    timestamp: String(Date.now()).slice(0, -3),
  });
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

async function main() {
  for (const [name, value] of [
    ["CARAT_LIVE_GATE_CAMPAIGN_CODE", CAMPAIGN_CODE],
    ["CARAT_LIVE_GATE_VARIANT_GID", VARIANT_GID],
    ["CARAT_LIVE_GATE_CUSTOMER_A", CUSTOMER],
  ] as const) {
    if (!value) throw new Error(`${name} must be set`);
  }
  if (!CAMPAIGN_CODE.startsWith("zz-live-gate-")) {
    throw new Error(
      `Refusing to run against campaign "${CAMPAIGN_CODE}": this gate records a REAL, non-withdrawable ` +
        `qualifying unit, so it only runs against a purpose-built zz-live-gate- campaign.`
    );
  }

  console.log(`Bank Payment configuration gate — ${APP_URL}`);
  console.log(`campaign: ${CAMPAIGN_CODE}\nNO PAYMENT SECRET VALUE IS PRINTED BY THIS GATE.\n`);

  const { prisma } = await import("~/db/client.server");
  const { resolveBankPaymentCoordinates, redactedSummary } = await import(
    "~/lib/payments/bankPaymentCoordinates.server"
  );
  const { buildGroupBuyPaymentInstructionsEmail } = await import(
    "~/domain/bankpayment/groupBuyPaymentInstructionsEmail"
  );
  const { groupBuyInitialPaymentDeadline, resolveGroupBuyPaymentWindowStart } = await import(
    "~/domain/bankpayment/groupBuyPaymentWindow"
  );
  const { minorUnitsToDecimalString } = await import("~/shopify/admin/priceSyncAdapter.server");

  // -------------------------------------------------------------------------
  // Coordinates must be resolvable HERE for the containment assertions to
  // execute. Reported by variable name only.
  // -------------------------------------------------------------------------
  const resolution = resolveBankPaymentCoordinates();
  console.log(`1. local coordinate resolution: ${redactedSummary(resolution)}`);
  if (!resolution.configured) {
    throw new Error(
      "The coordinate assertions cannot EXECUTE without the five PAYMENT_* values resolvable in this " +
        "process. They are set on Fly, which the deployed app reads, but this gate builds the email " +
        "locally to compare it against them. Add them to app/.env and re-run. Refusing to report a pass " +
        "with assertions that never ran."
    );
  }
  const coordinates = resolution.coordinates;

  // -------------------------------------------------------------------------
  console.log("\n2. authenticated checkout no longer returns a configuration 503");
  const response = await fetch(signedProxyUrl("/apps/carat/group-buy-bank-checkout", { logged_in_customer_id: CUSTOMER }), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "bank",
      cancellationAcknowledgmentAccepted: true,
      campaignCode: CAMPAIGN_CODE,
      email: `carat-bankpay-gate-${Date.now()}@example.com`,
      shippingAddress: {
        firstName: "Carat",
        lastName: "Gate",
        address1: "1 Test Street",
        city: "Austin",
        provinceCode: "TX",
        zip: "78701",
        countryCode: "US",
      },
      lines: [{ shopifyVariantId: VARIANT_GID, quantity: QUANTITY }],
    }),
  });
  const raw = await response.text();
  check(
    "checkout-not-503",
    response.status === 200,
    `checkout returned ${response.status} (503 would mean coordinates unresolved on the server)` +
      (response.status !== 200 ? ` — ${raw.slice(0, 200)}` : "")
  );
  if (response.status !== 200) throw new Error("cannot continue without a created order");

  const dto = JSON.parse(raw) as {
    groupBuyBankPaymentOrderId: string;
    lines: { quotedBankPaymentPriceMinorUnits: string }[];
  };

  // -------------------------------------------------------------------------
  console.log("\n3. the order, its reference, amount and deadline come from the real row");
  const order = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({
    where: { id: dto.groupBuyBankPaymentOrderId },
    include: { lines: true, campaign: { select: { code: true } } },
  });
  check(
    "order-reference-correct",
    order.id === dto.groupBuyBankPaymentOrderId && order.campaign.code === CAMPAIGN_CODE,
    `the response reference matches the persisted row, on the expected campaign (${order.campaign.code})`
  );

  // Summed in bigint from the PERSISTED lines, not from the response, so this
  // checks the database rather than echoing the API back at itself.
  const totalDue = order.lines.reduce((sum, l) => sum + l.quotedBankPaymentPriceMinorUnits * BigInt(l.quantity), 0n);
  const currency = order.lines[0]!.currency;
  const formattedAmountDue = `${minorUnitsToDecimalString(totalDue)} ${currency}`;
  // PER UNIT on both sides. The DTO reports a UNIT price; the persisted total
  // multiplies by quantity. Comparing one against the other failed at
  // quantity 2 and would have passed at quantity 1 — a comparison that is
  // only correct for the default is not a check.
  const responseUnitTotal = dto.lines.reduce((sum, l) => sum + BigInt(l.quotedBankPaymentPriceMinorUnits), 0n);
  const persistedUnitTotal = order.lines.reduce((sum, l) => sum + l.quotedBankPaymentPriceMinorUnits, 0n);
  check(
    "amount-due-correct",
    persistedUnitTotal === responseUnitTotal && totalDue > 0n && totalDue === persistedUnitTotal * BigInt(QUANTITY),
    `unit prices agree between response and database, and the total is unit x quantity (${formattedAmountDue}, qty ${QUANTITY})`
  );

  // THE 48-HOUR CUSTOMER DEADLINE. `groupBuyPaymentWindowDeadline` is the
  // 96-hour INACTIVATION instant and is not what a customer is told; this gate
  // originally compared against it and caught the email printing a date four
  // days out beneath the words "48 hours".
  const deadline = groupBuyInitialPaymentDeadline(resolveGroupBuyPaymentWindowStart(order));
  const expectedFrom = order.quotedAt.getTime() + 48 * 60 * 60 * 1000;
  check(
    "deadline-from-actual-order",
    deadline.getTime() === expectedFrom,
    `the customer-facing deadline is 48h from the row's own quotedAt (${deadline.toISOString()}), matching the "48 hours" sentence beside it`
  );

  // -------------------------------------------------------------------------
  // The email the route sends, rebuilt here from the same function, the same
  // row and the same coordinates. Containment only — nothing printed.
  // -------------------------------------------------------------------------
  console.log("\n4. the instructions email content (built from the same function, same row, same coordinates)");
  const email = buildGroupBuyPaymentInstructionsEmail({
    bankPaymentOrderId: order.id,
    campaignCode: order.campaign.code,
    formattedAmountDue,
    paymentDeadline: deadline,
    coordinates,
  });

  check(
    "instructions-name-both-methods",
    email.text.includes("Zelle") &&
      email.text.includes("Domestic bank wire") &&
      !/\bACH\b/i.test(email.text) &&
      !/\bSWIFT\b/i.test(email.text) &&
      !/bank transfer/i.test(email.text),
    "names Zelle and domestic bank wire, and no method the owner excluded (ACH, SWIFT/BIC, generic bank transfer)"
  );

  check(
    "zelle-destination-present",
    email.text.includes(coordinates.zelle.recipient),
    "the Zelle block carries the CONFIGURED destination (compared, not printed)"
  );

  const wireFieldsPresent =
    email.text.includes(coordinates.wire.bankName) &&
    email.text.includes(coordinates.wire.accountName) &&
    email.text.includes(coordinates.wire.routingNumber) &&
    email.text.includes(coordinates.wire.accountNumber);
  check(
    "wire-details-present",
    wireFieldsPresent,
    "the wire block carries all four CONFIGURED values: bank name, account name, routing number, account number"
  );

  // A DISTINCT CLAIM FROM amount-due-correct, and it needs its own id: the
  // first run reused that id here, so this check silently overwrote the
  // earlier result in the executed-set and reported PASS beside its own FAIL.
  // Two assertions sharing one id is a coverage hole wearing a green tick.
  check(
    "email-states-amount-and-reference",
    email.text.includes(`Amount due: ${formattedAmountDue}`) && email.text.includes(`Order reference: ${order.id}`),
    `the email states the exact amount due and the order reference`
  );

  // -------------------------------------------------------------------------
  console.log("\n5. incomplete configuration STILL fails closed (branch intact, not retired)");
  // Exercised against the REAL resolver with a doctored copy of the env, one
  // field at a time. Deliberately NOT done by unsetting a production secret:
  // that would break live checkout for real customers to re-observe a
  // property a pure function can demonstrate.
  const keys = [
    "PAYMENT_ZELLE_RECIPIENT",
    "PAYMENT_WIRE_BANK_NAME",
    "PAYMENT_WIRE_ACCOUNT_NAME",
    "PAYMENT_WIRE_ROUTING_NUMBER",
    "PAYMENT_WIRE_ACCOUNT_NUMBER",
  ] as const;
  const { getEnv } = await import("~/lib/env.server");
  const realEnv = getEnv();
  let allRefused = true;
  const leaks: string[] = [];
  for (const key of keys) {
    const doctored = { ...realEnv, [key]: undefined } as typeof realEnv;
    const r = resolveBankPaymentCoordinates(doctored);
    if (r.configured) {
      allRefused = false;
      continue;
    }
    if (!r.reason.includes(key)) allRefused = false;
    // The reason must name the variable and leak no value.
    for (const value of [
      coordinates.zelle.recipient,
      coordinates.wire.bankName,
      coordinates.wire.accountName,
      coordinates.wire.routingNumber,
      coordinates.wire.accountNumber,
    ]) {
      if (r.reason.includes(value)) leaks.push(key);
    }
  }
  check(
    "incomplete-config-fails-closed",
    allRefused && leaks.length === 0,
    `each of the five variables, removed individually, makes the resolver refuse and name that variable; ` +
      `no refusal reason contains a coordinate value (${leaks.length} leaks)`
  );

  // -------------------------------------------------------------------------
  console.log("\n6. no coordinate value appears in production logs");
  // Searches recent app logs for each configured value. The needle is never
  // printed; only the verdict.
  const { execFileSync } = await import("node:child_process");
  let logs = "";
  try {
    logs = execFileSync(
      `${process.env.USERPROFILE}\\.fly\\bin\\fly.exe`,
      ["logs", "-a", "caratforus", "--no-tail"],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (error) {
    // A log read failure must not be reported as "no leaks found".
    check("no-secret-in-logs", false, `could not read production logs to check for leaks: ${String(error).slice(0, 120)}`);
  }
  if (logs) {
    const leaked: string[] = [];
    const named: Array<[string, string]> = [
      ["PAYMENT_ZELLE_RECIPIENT", coordinates.zelle.recipient],
      ["PAYMENT_WIRE_BANK_NAME", coordinates.wire.bankName],
      ["PAYMENT_WIRE_ACCOUNT_NAME", coordinates.wire.accountName],
      ["PAYMENT_WIRE_ROUTING_NUMBER", coordinates.wire.routingNumber],
      ["PAYMENT_WIRE_ACCOUNT_NUMBER", coordinates.wire.accountNumber],
    ];
    for (const [name, value] of named) {
      if (logs.includes(value)) leaked.push(name);
    }
    check(
      "no-secret-in-logs",
      leaked.length === 0,
      leaked.length === 0
        ? `none of the five configured values appears in ${logs.split("\n").length} recent log lines`
        : `VARIABLES WHOSE VALUES APPEAR IN LOGS: ${leaked.join(", ")} — rotate them`
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n7. payment is still unverified — staff confirmation remains required");
  check(
    "staff-verification-still-required",
    order.status === "active",
    `the order is "${order.status}", not paid or verified: sending instructions does not mark money received`
  );

  console.log("\n============================================================");
  console.log(`CREATED — a real order (${order.id}) and ONE non-withdrawable qualifying unit on ${CAMPAIGN_CODE}.`);
  await prisma.$disconnect();
}

main()
  .catch((error) => {
    console.error("\n", error instanceof Error ? error.message : String(error));
    failures += 1;
  })
  .finally(() => {
    const missing = missingAssertions();
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required assertion(s) NEVER RAN: ${missing.join(", ")}. ` +
          "NOT a pass, however many PASS lines appear above."
      );
    }
    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nGATE PASSED — all ${REQUIRED_ASSERTIONS.length} required assertions executed and passed.\n` +
            "The fail-closed branch for missing configuration remains intact and was exercised."
        : `\n${failures} FAILURE(S) — Bank Payment configuration is NOT proven.`
    );
    process.exitCode = green ? 0 : 1;
  });
