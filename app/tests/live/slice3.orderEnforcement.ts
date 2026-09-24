/**
 * SLICE 3 LIVE GATE, STAGE 2 — the order-time enforcement path, end to end.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE CAN.
 * D6 declined a cart/checkout validation Function, so `orders/create`
 * verification is the ONLY enforcement that binds. Every test of it so far has
 * fed the handler a payload we constructed ourselves — which can only confirm
 * what we already believe about Shopify's payload shape. This harness makes
 * Shopify build the order and Shopify deliver the webhook, then checks what
 * our production database actually recorded.
 *
 * It runs two orders against the deployed app at caratforus.fly.dev:
 *
 *   A. a Luxury Steal line with NO acknowledgment property  -> expect unmatched, held
 *   B. a Luxury Steal line carrying a REAL acknowledgment id -> expect matched
 *
 * Case B's acknowledgment is obtained by signing an App Proxy request to the
 * deployed acknowledgment endpoint, so the id is one production actually
 * minted rather than a row this harness inserted. That matters: an id we wrote
 * ourselves would prove the matching logic and nothing about the route.
 *
 * RUN:  npx tsx tests/live/slice3.orderEnforcement.ts
 *
 * SIDE EFFECTS — READ BEFORE RUNNING. This creates TWO REAL ORDERS in the dev
 * store. They cannot be removed through the Admin API and must be deleted by
 * hand afterwards; the harness prints their names and ids so that is a
 * copy-paste job rather than a hunt. It does not delete anything itself.
 */
import "dotenv/config";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = "https://caratforus.fly.dev";

/** The variant assigned as a Luxury Steal in the PRODUCTION database. */
const VARIANT_GID = "gid://shopify/ProductVariant/52375385309485";

function signedProxyUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    ...params,
    shop: SHOP,
    path_prefix: "/apps/carat",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  // Same construction the server verifies with: signature removed, remaining
  // pairs sorted by key, joined as key=value with NO separator.
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

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

async function gql<T>(admin: { graphql: Function }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { errors?: unknown; data?: T };
  // Every Admin API failure arrives on HTTP 200.
  if (body.errors) throw new Error(`top-level errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

async function placeOrder(
  admin: { graphql: Function },
  label: string,
  customAttributes: { key: string; value: string }[]
): Promise<{ orderId: string; orderName: string }> {
  const created = await gql<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, DRAFT_CREATE, {
    input: {
      lineItems: [{ variantId: VARIANT_GID, quantity: 1, customAttributes }],
      tags: ["carat-live-gate-slice3"],
    },
  });
  if (created.draftOrderCreate.userErrors.length) {
    throw new Error(`draftOrderCreate: ${JSON.stringify(created.draftOrderCreate.userErrors)}`);
  }
  const draftId = created.draftOrderCreate.draftOrder!.id;

  const completed = await gql<{
    draftOrderComplete: {
      draftOrder: { order: { id: string; name: string } | null } | null;
      userErrors: { message: string }[];
    };
  }>(admin, DRAFT_COMPLETE, { id: draftId });
  if (completed.draftOrderComplete.userErrors.length) {
    throw new Error(`draftOrderComplete: ${JSON.stringify(completed.draftOrderComplete.userErrors)}`);
  }
  const order = completed.draftOrderComplete.draftOrder!.order!;
  console.log(`  ${label}: ${order.name}  ${order.id}`);
  return { orderId: order.id, orderName: order.name };
}

async function main() {
  console.log(`Slice 3 live gate, stage 2 — order enforcement against ${SHOP}`);
  console.log(`app under test: ${APP_URL}\n`);
  console.log("THIS CREATES TWO REAL ORDERS. They must be deleted by hand afterwards.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  console.log("1. minting a real acknowledgment through the deployed App Proxy route");
  const bareVariantId = VARIANT_GID.split("/").pop()!;
  const ackUrl = signedProxyUrl("/apps/carat/luxury-acknowledgment", {});
  const ackResponse = await fetch(ackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopifyVariantId: bareVariantId }),
  });
  const ackText = await ackResponse.text();
  console.log(`  HTTP ${ackResponse.status}  ${ackText.slice(0, 200)}`);
  if (ackResponse.status !== 201) {
    throw new Error(
      `acknowledgment endpoint did not return 201 — cannot run case B. Body: ${ackText.slice(0, 400)}`
    );
  }
  const acknowledgmentId = (JSON.parse(ackText) as { acknowledgmentId: string }).acknowledgmentId;
  console.log(`  acknowledgmentId = ${acknowledgmentId}`);

  console.log("\n2. placing orders");
  const caseA = await placeOrder(admin, "A (no acknowledgment property)", []);
  const caseB = await placeOrder(admin, "B (real acknowledgment id)", [
    { key: "_carat_ls_ack", value: acknowledgmentId },
  ]);

  console.log("\nORDERS CREATED — delete these by hand in the Shopify admin:");
  console.log(`  ${caseA.orderName}  ${caseA.orderId}`);
  console.log(`  ${caseB.orderName}  ${caseB.orderId}`);
  console.log("\nNow check what production recorded. Expected:");
  console.log(`  ${caseA.orderName} -> unmatched (held for staff review)`);
  console.log(`  ${caseB.orderName} -> matched   (acknowledgment ${acknowledgmentId})`);
  console.log("\nWebhook delivery is asynchronous; allow a few seconds before checking.");
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
