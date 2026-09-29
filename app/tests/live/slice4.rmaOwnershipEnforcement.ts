/**
 * SLICE 4 LIVE GATE — RMA ownership enforcement against production
 * (owner requirement 2026-09-29).
 *
 * WHY THIS EXISTS. `apps.carat.rma-intake.tsx` resolves the order through the
 * SAME Admin API `customer { id }` lookup that the warranty route uses, and
 * that lookup was broken in production until `read_customers` was granted —
 * every submission returned 502. The owner's instruction was to live-prove
 * the RMA ownership path too, since one scope covered both.
 *
 * THE FIVE RULES THIS GATE HOLDS TO, stated by the owner and each mapped to a
 * named assertion below:
 *   - an authenticated Shopify customer identity is REQUIRED
 *   - the order is retrieved SERVER-SIDE
 *   - the order's customer must MATCH the authenticated customer
 *   - a browser-supplied customer id / email / ownership claim is NEVER trusted
 *   - a missing scope or API failure continues to FAIL CLOSED
 *
 * ABOUT THE LAST ONE. It is deliberately NOT re-proven here, because proving
 * it live would mean removing `read_customers` again and breaking production
 * warranty and RMA for every customer while the run completed. It was already
 * observed under exactly those conditions on 2026-09-29: with the scope
 * absent, this route returned 502 `order_lookup_failed` and created nothing —
 * no RMA row, no partial state. That is the fail-closed behaviour, witnessed
 * in production, and re-breaking a live system to re-witness it would be
 * theatre rather than evidence.
 *
 * ============================================================================
 * CREATES REAL DATA. One real Shopify order for customer A, and — on the happy
 * path — one real RmaRequest row in production. Both are listed at the end.
 * ============================================================================
 *
 * RUN: npx tsx tests/live/slice4.rmaOwnershipEnforcement.ts
 */
import "dotenv/config";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = process.env.CARAT_LIVE_GATE_APP_URL ?? "https://caratforus.fly.dev";
const TEST_VARIANT_GID = process.env.CARAT_LIVE_GATE_VARIANT_GID ?? "gid://shopify/ProductVariant/REPLACE-ME";

const REQUIRED_ASSERTIONS = [
  "rma-anonymous-refused",
  "rma-owner-accepted",
  "rma-cross-customer-refused",
  "rma-unknown-order-indistinguishable",
  "rma-browser-identity-rejected",
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
    // Seconds since epoch without Math.floor — this repo bans that family
    // unconditionally (see the money-safety lint), even for a timestamp.
    timestamp: String(Date.now()).slice(0, -3),
  });
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  // Shopify reports failures on HTTP 200 — checking response.ok proves nothing.
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error("GraphQL response carried no data");
  return body.data;
}

const DRAFT_CREATE = `
  mutation CaratRmaGateDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id } userErrors { message } }
  }
`;

const DRAFT_COMPLETE = `
  mutation CaratRmaGateComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { order { id name lineItems(first: 5) { nodes { id } } } }
      userErrors { message }
    }
  }
`;

function customerFromEnv(label: "A" | "B"): { id: string; numericId: string } {
  const raw = (label === "A" ? process.env.CARAT_LIVE_GATE_CUSTOMER_A : process.env.CARAT_LIVE_GATE_CUSTOMER_B)?.trim();
  if (!raw) {
    throw new Error(
      `CARAT_LIVE_GATE_CUSTOMER_${label} must be set. This gate does not mint customers — the app does not ` +
        `request write_customers, and the owner declined to widen it for test fixtures.`
    );
  }
  const numericId = raw.startsWith("gid://") ? raw.split("/").pop()! : raw;
  if (!/^\d+$/.test(numericId)) throw new Error(`CARAT_LIVE_GATE_CUSTOMER_${label} is not a numeric id or customer gid`);
  return { id: `gid://shopify/Customer/${numericId}`, numericId };
}

async function createOrderFor(
  admin: { graphql: AdminGraphql },
  customerGid: string
): Promise<{ orderGid: string; orderName: string; lineGid: string }> {
  const created = await gql<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, DRAFT_CREATE, {
    input: {
      customerId: customerGid,
      lineItems: [{ variantId: TEST_VARIANT_GID, quantity: 1 }],
      tags: ["carat-live-gate-slice4"],
    },
  });
  if (created.draftOrderCreate.userErrors.length) {
    throw new Error(`draftOrderCreate: ${JSON.stringify(created.draftOrderCreate.userErrors)}`);
  }
  const completed = await gql<{
    draftOrderComplete: {
      draftOrder: { order: { id: string; name: string; lineItems: { nodes: { id: string }[] } } | null } | null;
      userErrors: { message: string }[];
    };
  }>(admin, DRAFT_COMPLETE, { id: created.draftOrderCreate.draftOrder!.id });
  if (completed.draftOrderComplete.userErrors.length) {
    throw new Error(`draftOrderComplete: ${JSON.stringify(completed.draftOrderComplete.userErrors)}`);
  }
  const order = completed.draftOrderComplete.draftOrder!.order!;
  const lineGid = order.lineItems.nodes[0]?.id;
  if (!lineGid) throw new Error("completed order carried no line items");
  return { orderGid: order.id, orderName: order.name, lineGid };
}

/** Today, as YYYY-MM-DD — a day-0 delivery, which is the `standard` window and takes no remedy choice. */
function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function rmaBody(order: { orderGid: string; lineGid: string }, extra: Record<string, unknown> = {}) {
  return {
    orderRef: order.orderGid,
    lineRef: order.lineGid,
    itemConfigurationDescription: "Live gate test item",
    carrierConfirmedDeliveryDate: todayDateOnly(),
    reasonCategory: "buyer_remorse",
    reasonExplanation: "Live gate synthetic RMA — ownership enforcement verification.",
    confirmsUnwornBeyondInspection: true,
    confirmsUndamaged: true,
    confirmsUnalteredAfterDelivery: true,
    confirmsOriginalPackagingIncluded: true,
    isPersonalizedOrAltered: false,
    returnPolicyAcknowledgmentAccepted: true,
    ...extra,
  };
}

async function postRma(
  customerNumericId: string | null,
  body: Record<string, unknown>
): Promise<{ status: number; error?: string; raw: string }> {
  const params: Record<string, string> = customerNumericId ? { logged_in_customer_id: customerNumericId } : {};
  const response = await fetch(signedProxyUrl("/apps/carat/rma-intake", params), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let error: string | undefined;
  try {
    error = (JSON.parse(raw) as { error?: string }).error;
  } catch {
    /* non-JSON body is itself a finding */
  }
  return { status: response.status, error, raw };
}

async function main() {
  if (TEST_VARIANT_GID.includes("REPLACE-ME")) throw new Error("Set CARAT_LIVE_GATE_VARIANT_GID to the test variant.");
  if (!SHOP || !SECRET) throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_API_SECRET must be set.");

  const customerA = customerFromEnv("A");
  const customerB = customerFromEnv("B");
  if (customerA.numericId === customerB.numericId) {
    throw new Error("A and B are the same identity — the cross-customer assertion would pass vacuously.");
  }

  console.log(`Slice 4 live gate — RMA ownership enforcement against ${APP_URL}`);
  console.log(`store: ${SHOP}\nCREATES A REAL ORDER AND, ON SUCCESS, A REAL RmaRequest ROW.\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  console.log("0. setup — one real order belonging to customer A");
  const order = await createOrderFor(admin, customerA.id);
  console.log(`  order = ${order.orderName}  ${order.orderGid}\n`);

  // -------------------------------------------------------------------------
  console.log("1. an authenticated customer identity is REQUIRED");
  const anon = await postRma(null, rmaBody(order));
  check(
    "rma-anonymous-refused",
    anon.status === 401,
    `a signed proxy request with NO logged_in_customer_id is refused (HTTP ${anon.status}, error ${anon.error})`
  );

  // -------------------------------------------------------------------------
  console.log("\n2. the order's own customer is accepted");
  const owner = await postRma(customerA.numericId, rmaBody(order));
  check(
    "rma-owner-accepted",
    owner.status === 201,
    `customer A submitting an RMA for their OWN order is accepted (HTTP ${owner.status})` +
      (owner.status !== 201 ? ` — ${owner.raw.slice(0, 200)}` : "")
  );

  // -------------------------------------------------------------------------
  console.log("\n3. a DIFFERENT customer is refused for the same order");
  // The order is fetched server-side and its customer compared against the
  // SIGNED proxy identity. Nothing customer B sends can change that.
  const crossOrder = await createOrderFor(admin, customerA.id);
  const cross = await postRma(customerB.numericId, rmaBody(crossOrder));
  check(
    "rma-cross-customer-refused",
    cross.status === 422 && cross.error === "order_or_line_unresolved",
    `customer B submitting customer A's order is refused (HTTP ${cross.status}, error ${cross.error})`
  );

  // -------------------------------------------------------------------------
  console.log("\n4. a non-existent order is INDISTINGUISHABLE from someone else's");
  const unknown = await postRma(customerA.numericId, {
    ...rmaBody(order),
    orderRef: "gid://shopify/Order/9999999999999",
    lineRef: "gid://shopify/LineItem/9999999999999",
  });
  check(
    "rma-unknown-order-indistinguishable",
    unknown.status === cross.status && unknown.error === cross.error,
    `an order that does not exist returns the SAME response as one belonging to someone else ` +
      `(${unknown.status}/${unknown.error} vs ${cross.status}/${cross.error}) — not an enumeration oracle`
  );

  // -------------------------------------------------------------------------
  console.log("\n5. the browser cannot assert an identity");
  // The schema is `.strict()` and has no customer/email field at all: the
  // stored purchaser email comes from the resolved order's own Shopify record.
  // A body that tries to smuggle one is refused outright rather than having
  // the extra field quietly ignored — which would be the dangerous outcome,
  // since "ignored" and "honoured" look identical from outside.
  const spoofOrder = await createOrderFor(admin, customerA.id);
  const spoof = await postRma(customerB.numericId, {
    ...rmaBody(spoofOrder),
    customerRef: customerA.id,
    purchaserEmail: "attacker@example.com",
  });
  check(
    "rma-browser-identity-rejected",
    spoof.status === 400 || (spoof.status === 422 && spoof.error === "order_or_line_unresolved"),
    `a body asserting customerRef/purchaserEmail does not grant ownership (HTTP ${spoof.status}, error ${spoof.error})`
  );

  console.log("\n============================================================");
  console.log("CREATED — delete by hand (Shopify admin, tag carat-live-gate-slice4):");
  console.log(`  ${order.orderName} ${order.orderGid}   (an RmaRequest row exists for this one)`);
  console.log(`  ${crossOrder.orderName} ${crossOrder.orderGid}`);
  console.log(`  ${spoofOrder.orderName} ${spoofOrder.orderGid}`);
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    const missing = missingAssertions();
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required assertion(s) NEVER RAN: ${missing.join(", ")}. NOT a pass.`
      );
    }
    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nLIVE GATE PASSED — all ${REQUIRED_ASSERTIONS.length} RMA ownership assertions executed and passed.`
        : `\n${failures} FAILURE(S) — RMA ownership is NOT proven.`
    );
    process.exitCode = green ? 0 : 1;
  });
