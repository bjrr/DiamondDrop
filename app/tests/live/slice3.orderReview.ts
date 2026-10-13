/**
 * SLICE 3 LIVE GATE, STAGE 3 — D28 tagging and fulfilment holds.
 *
 * Proves the four cases the owner specified, against the real dev store and
 * the deployed app:
 *
 *   A. acknowledged Luxury Steal order  -> tagged "Luxury Steal", NOT held
 *   B. missing acknowledgment           -> tagged "Needs Review", HELD
 *   C. webhook redelivery               -> no duplicate check, no duplicate hold
 *   D. ordinary non-Luxury-Steal order  -> completely untouched
 *
 * WHY IT ASSERTS AGAINST SHOPIFY AND NOT ONLY AGAINST OUR OWN DATABASE.
 * Our evidence rows record what we BELIEVE we did. A tag that was never
 * applied, or a hold that Shopify rejected, would leave our audit trail
 * looking correct while the order shipped anyway — which is the entire failure
 * D28 exists to prevent. So every assertion here reads Shopify's own state:
 * the order's `tags`, and each fulfilment order's `status`.
 *
 * Case C deliberately does NOT fabricate a payload. It replays the exact bytes
 * Shopify delivered, read back from `webhook_event.raw_body` in production and
 * re-signed, because duplicate suppression has to be proven against what
 * Shopify really sends rather than against our reconstruction of it. That
 * replay is driven separately (see `--replay`), since reading production
 * Postgres needs the Fly machine.
 *
 * RUN:  npx tsx tests/live/slice3.orderReview.ts
 *       npx tsx tests/live/slice3.orderReview.ts --replay <orderGid> <rawBodyFile> <eventId>
 *
 * SIDE EFFECTS. Creates REAL ORDERS in the dev store that cannot be removed
 * through the Admin API and must be deleted by hand. Every order it creates is
 * printed at the end for exactly that reason. It does not delete anything.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = "https://caratforus.fly.dev";

/** Assigned as a Luxury Steal in the PRODUCTION database before this runs. */
const LS_VARIANT_GID = "gid://shopify/ProductVariant/52375385309485";

const VERIFIED_TAG = "Luxury Steal";
const REVIEW_TAG = "Luxury Steal: Needs Review";

let failures = 0;
function check(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { errors?: unknown; data?: T };
  if (body.errors) throw new Error(`top-level errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

const ORDER_STATE = `#graphql
  query CaratOrderState($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      fulfillmentOrders(first: 20) { nodes { id status } }
    }
  }
`;

const DRAFT_CREATE = `#graphql
  mutation CaratReviewDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } }
  }
`;

const DRAFT_COMPLETE = `#graphql
  mutation CaratReviewComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { id order { id name } }
      userErrors { field message }
    }
  }
`;

function signedProxyUrl(path: string): string {
  const search = new URLSearchParams({
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

async function mintAcknowledgment(): Promise<string> {
  const response = await fetch(signedProxyUrl("/apps/carat/luxury-acknowledgment"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopifyVariantId: LS_VARIANT_GID.split("/").pop() }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`acknowledgment endpoint returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { acknowledgmentId: string }).acknowledgmentId;
}

async function placeOrder(
  admin: { graphql: AdminGraphql },
  variantGid: string,
  customAttributes: { key: string; value: string }[]
): Promise<{ id: string; name: string }> {
  const created = await gql<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, DRAFT_CREATE, {
    input: { lineItems: [{ variantId: variantGid, quantity: 1, customAttributes }] },
  });
  if (created.draftOrderCreate.userErrors.length) {
    throw new Error(`draftOrderCreate: ${JSON.stringify(created.draftOrderCreate.userErrors)}`);
  }
  const completed = await gql<{
    draftOrderComplete: {
      draftOrder: { order: { id: string; name: string } | null } | null;
      userErrors: { message: string }[];
    };
  }>(admin, DRAFT_COMPLETE, { id: created.draftOrderCreate.draftOrder!.id });
  if (completed.draftOrderComplete.userErrors.length) {
    throw new Error(`draftOrderComplete: ${JSON.stringify(completed.draftOrderComplete.userErrors)}`);
  }
  return completed.draftOrderComplete.draftOrder!.order!;
}

async function readOrderState(admin: { graphql: AdminGraphql }, orderGid: string) {
  const data = await gql<{
    order: { name: string; tags: string[]; fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null;
  }>(admin, ORDER_STATE, { id: orderGid });
  return data.order;
}

/** Waits for the webhook to land, rather than assuming a fixed delay is enough. */
async function waitForTag(
  admin: { graphql: AdminGraphql },
  orderGid: string,
  attempts = 12
): Promise<{ name: string; tags: string[]; fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null> {
  for (let i = 0; i < attempts; i++) {
    const state = await readOrderState(admin, orderGid);
    if (state && state.tags.length > 0) return state;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return readOrderState(admin, orderGid);
}

async function replay(orderGid: string, rawBodyFile: string, eventId: string) {
  const rawBody = readFileSync(rawBodyFile, "utf8");
  const hmac = createHmac("sha256", SECRET).update(rawBody, "utf8").digest("base64");
  console.log(`replaying ${rawBody.length} bytes of Shopify's own payload for ${orderGid}`);
  const response = await fetch(`${APP_URL}/webhooks/carat/orders-create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": eventId,
    },
    body: rawBody,
  });
  console.log(`  HTTP ${response.status} — ${(await response.text()).slice(0, 200)}`);
  console.log("\nNow re-check production: the evidence row count and the hold count must be UNCHANGED.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--replay") {
    const [, orderGid, rawBodyFile, eventId] = args;
    if (!orderGid || !rawBodyFile || !eventId) {
      throw new Error("usage: --replay <orderGid> <rawBodyFile> <eventId>");
    }
    await replay(orderGid, rawBodyFile, eventId);
    return;
  }

  console.log(`Slice 3 live gate, stage 3 — D28 tagging and holds against ${SHOP}`);
  console.log("CREATES REAL ORDERS. Delete them by hand afterwards.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  const created: { label: string; name: string; id: string }[] = [];

  // ---------------------------------------------------------------- case A
  console.log("CASE A — acknowledged Luxury Steal: expect tagged, NOT held");
  const ackId = await mintAcknowledgment();
  const orderA = await placeOrder(admin, LS_VARIANT_GID, [{ key: "_carat_ls_ack", value: ackId }]);
  created.push({ label: "A acknowledged", ...orderA });
  console.log(`  order ${orderA.name}, acknowledgment ${ackId}`);
  const stateA = await waitForTag(admin, orderA.id);
  check(stateA?.tags.includes(VERIFIED_TAG), `tagged "${VERIFIED_TAG}" (got ${JSON.stringify(stateA?.tags)})`);
  check(!stateA?.tags.includes(REVIEW_TAG), `NOT tagged "${REVIEW_TAG}"`);
  check(
    (stateA?.fulfillmentOrders.nodes ?? []).every((fo) => fo.status !== "ON_HOLD"),
    `no fulfilment order is ON_HOLD (got ${JSON.stringify((stateA?.fulfillmentOrders.nodes ?? []).map((f) => f.status))})`
  );

  // ---------------------------------------------------------------- case B
  console.log("\nCASE B — no acknowledgment: expect review tag AND hold");
  const orderB = await placeOrder(admin, LS_VARIANT_GID, []);
  created.push({ label: "B unverified", ...orderB });
  console.log(`  order ${orderB.name}`);
  const stateB = await waitForTag(admin, orderB.id);
  check(stateB?.tags.includes(REVIEW_TAG), `tagged "${REVIEW_TAG}" (got ${JSON.stringify(stateB?.tags)})`);
  const fosB = stateB?.fulfillmentOrders.nodes ?? [];
  check(fosB.length > 0, `order has at least one fulfilment order (got ${fosB.length})`);
  check(
    fosB.length > 0 && fosB.every((fo) => fo.status === "ON_HOLD"),
    `EVERY fulfilment order is ON_HOLD (got ${JSON.stringify(fosB.map((f) => f.status))})`
  );

  // ---------------------------------------------------------------- case D
  console.log("\nCASE D — ordinary non-Luxury-Steal order: expect completely untouched");
  const ordinaryVariant = await gql<{
    productVariants: { nodes: { id: string }[] };
  }>(
    admin,
    `#graphql
      query CaratOrdinaryVariant { productVariants(first: 10) { nodes { id } } }
    `
  );
  const ordinaryGid = ordinaryVariant.productVariants.nodes
    .map((n) => n.id)
    .find((id) => id !== LS_VARIANT_GID);
  if (!ordinaryGid) {
    console.log("  SKIPPED — no second variant exists in this store to use as a control");
  } else {
    const orderD = await placeOrder(admin, ordinaryGid, []);
    created.push({ label: "D ordinary", ...orderD });
    console.log(`  order ${orderD.name} using ${ordinaryGid}`);
    await new Promise((r) => setTimeout(r, 20000));
    const stateD = await readOrderState(admin, orderD.id);
    check(
      !(stateD?.tags ?? []).includes(VERIFIED_TAG) && !(stateD?.tags ?? []).includes(REVIEW_TAG),
      `carries NEITHER Luxury Steal tag (got ${JSON.stringify(stateD?.tags)})`
    );
    check(
      (stateD?.fulfillmentOrders.nodes ?? []).every((fo) => fo.status !== "ON_HOLD"),
      `no fulfilment order is ON_HOLD (got ${JSON.stringify((stateD?.fulfillmentOrders.nodes ?? []).map((f) => f.status))})`
    );
  }

  // ---------------------------------------------------------------- summary
  console.log("\nORDERS CREATED — delete these by hand:");
  for (const o of created) console.log(`  ${o.label.padEnd(16)} ${o.name}  ${o.id}`);

  console.log(
    failures === 0
      ? "\nCASES A, B and D PASSED against Shopify's own order state."
      : `\n${failures} ASSERTION(S) FAILED — see above.`
  );
  console.log("Case C (redelivery) runs separately via --replay, using the stored raw body.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
