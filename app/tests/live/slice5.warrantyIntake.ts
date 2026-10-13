/**
 * SLICE 5 LIVE GATE — the warranty claim intake, end to end.
 *
 * Proves what no test can: that a signed App Proxy request reaches the
 * deployed route, that the order and line resolve against real Shopify data,
 * that the acknowledgment is recorded against the provisioned policy version,
 * and — the one that matters most — that the confirmation carries NO shipping
 * instruction (criterion 156, WARRANTY-CLAIMS.md §3).
 *
 * It also exercises the fail-closed path deliberately: a claim naming an order
 * that does not exist must be REFUSED, not stored against a guess
 * (criterion 155).
 *
 * RUN:  npx tsx tests/live/slice5.warrantyIntake.ts
 *
 * SIDE EFFECTS: creates warranty_claim rows in PRODUCTION Postgres. It creates
 * no Shopify data and no orders. Claim rows are evidence and append-only by
 * design, so they are not cleaned up — they are test claims against a real
 * order and should be recognised as such by their description text.
 */
import "dotenv/config";
import { createHmac } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = "https://caratforus.fly.dev";

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

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

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function main() {
  console.log(`Slice 5 live gate — warranty intake against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  // A REAL order and line, because criterion 155 refuses anything it cannot
  // resolve — testing with a fabricated id would only prove the refusal path.
  const resp = await (admin.graphql as AdminGraphql)(
    `#graphql
      query CaratRecentOrder {
        orders(first: 5, reverse: true) {
          nodes { id name lineItems(first: 1) { nodes { id } } }
        }
      }
    `
  );
  const body = (await resp.json()) as {
    data?: { orders?: { nodes?: { id: string; name: string; lineItems: { nodes: { id: string }[] } }[] } };
  };
  const order = (body.data?.orders?.nodes ?? []).find((o) => o.lineItems.nodes.length > 0);
  if (!order) {
    console.log("No order with a line item exists in this store — cannot exercise the happy path.");
    console.log("The refusal path below still runs.");
  } else {
    console.log(`using order ${order.name}  ${order.id}`);
  }

  const post = async (payload: object) => {
    const r = await fetch(signedProxyUrl("/apps/carat/warranty-claim"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: r.status, text: await r.text() };
  };

  // FIELD NAMES READ FROM THE ROUTE'S OWN ZOD SCHEMA, not guessed.
  //
  // My first version of this harness invented plausible names —
  // itemDescription, issueNoticedOn, impactOrDamageOccurred — and every
  // request was rejected with "body does not match the warranty claim request
  // contract". The 4xx assertion PASSED, so the harness reported a green
  // refusal while proving only that I had written the payload wrong. A test
  // that passes for the wrong reason is the failure mode this whole gate
  // exists to catch, and it caught me.
  const basePayload = {
    purchaserName: "Live Gate",
    purchaserEmail: "live-gate@example.com",
    itemConfigurationDescription: "LIVE GATE TEST CLAIM — automated slice 5 verification",
    problemDescription: "Automated live-gate submission verifying the intake route end to end.",
    issueFirstNoticedDate: "2026-09-20",
    hadImpactOrDamageEvent: false,
    wasAlteredAfterDelivery: false,
    claimAcknowledgmentAccepted: true as const,
  };

  if (order) {
    console.log("\n1. a real order and line — expect the claim to be accepted");
    const ok = await post({
      ...basePayload,
      orderRef: order.id,
      lineRef: order.lineItems.nodes[0]!.id,
    });
    console.log(`  HTTP ${ok.status}  ${ok.text.slice(0, 200)}`);
    check(ok.status === 201, `accepted (got ${ok.status})`);

    // CRITERION 156 — the whole point. Not "a field is absent" but "no
    // address- or shipping-like content anywhere in the body".
    const shippingish = /address|send (it|your|the)|ship (it|your)|post (it|your)|mail (it|your)|P\.?O\.? Box|\b\d{5}(-\d{4})?\b/i;
    check(!shippingish.test(ok.text), "confirmation carries NO shipping instruction or address");
    check(!/jewell?er/i.test(ok.text), "confirmation carries no local-jeweller reference");

    try {
      const parsed = JSON.parse(ok.text) as Record<string, unknown>;
      check(
        Object.keys(parsed).every((k) => ["claimId", "claimReference", "status"].includes(k)),
        `response is a closed allowlist (got ${Object.keys(parsed).join(", ")})`
      );
    } catch {
      check(false, "response body is JSON");
    }
  }

  console.log("\n2. an order that does not exist — expect refusal, not a stored guess");
  const bad = await post({
    ...basePayload,
    orderRef: "gid://shopify/Order/999999999999",
    lineRef: "gid://shopify/LineItem/999999999999",
  });
  console.log(`  HTTP ${bad.status}  ${bad.text.slice(0, 160)}`);
  check(bad.status >= 400 && bad.status < 500, `refused with a 4xx (got ${bad.status})`);
  // A 4xx alone proves nothing: a malformed payload also 4xxes. Criterion 155
  // is specifically "an order that cannot be RESOLVED is refused", so the
  // refusal must not be a schema complaint.
  check(
    !/does not match/i.test(bad.text),
    "refused because the ORDER could not be resolved, not because the payload was malformed"
  );

  console.log("\n3. an unsigned request — expect 401");
  const unsigned = await fetch(`${APP_URL}/apps/carat/warranty-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(basePayload),
  });
  console.log(`  HTTP ${unsigned.status}`);
  check(unsigned.status === 401, `rejected unsigned (got ${unsigned.status})`);

  console.log(failures === 0 ? "\nLIVE GATE PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
