/**
 * LIVE GATE — is the authenticated Bank Payment orders route actually
 * deployed, routable, and failing closed, in production?
 *
 * RUN:  npx tsx tests/live/bankPaymentOrdersRoute.ts
 *
 * ============================================================================
 * WHY A LIVE GATE AND NOT ONLY THE INTEGRATION SUITE
 * ============================================================================
 * `tests/integration/bankpayment/bankCheckoutRoute.test.ts` already proves
 * this route's authorization decisions against real Postgres. What it calls
 * is the exported `loader` function. It cannot prove that the route is
 * REACHABLE in production, that the deployed `SHOPIFY_API_SECRET` is the one
 * the storefront signs with, or that nothing between Fly and the handler
 * (proxy, redirect, CSRF guard, error page) turns a legitimate signed
 * request into something else.
 *
 * This project has already shipped a defect of exactly that shape: D11, where
 * every `/app` action 400'd in production for nine days because Fly
 * terminates TLS and `react-router-serve` does not trust the proxy — a fact
 * no local test could see, and which only a real write against the real
 * deployment surfaced. Register D12's whole purpose is that a customer can
 * find their payment instructions without an email. A route that is correct
 * but unreachable fails that purpose completely and silently.
 *
 * ============================================================================
 * READ-ONLY, AND DELIBERATELY OWNS NOTHING
 * ============================================================================
 * It places no order and writes nothing. `SMOKE_CUSTOMER_ID` is an id that
 * owns no orders, so the expected success for the authenticated case is
 * `200` with two EMPTY lists. That is not a weak assertion — it is the
 * correct one: a customer who owns nothing must see nothing, and the four
 * refusal cases below are where the real proof is.
 *
 * ============================================================================
 * THE SECRET IS READ FROM THE ENVIRONMENT AND NEVER PRINTED
 * ============================================================================
 * Signing requires the same `SHOPIFY_API_SECRET` the deployed app verifies
 * with. It is read from the environment, never hardcoded, and no response
 * body is printed beyond a short prefix — this route's successful bodies can
 * carry bank coordinates for a customer who does have payable orders.
 */

import "dotenv/config";

import { createHmac } from "node:crypto";

const BASE = process.env.SMOKE_BASE_URL ?? "https://caratforus.fly.dev";
const PATH = "/apps/carat/bank-payment-orders";
const SECRET = process.env.SHOPIFY_API_SECRET;
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN ?? "caratforus-dev.myshopify.com";
/** An id that owns nothing. Do not point this at a real customer. */
const SMOKE_CUSTOMER_ID = process.env.SMOKE_CUSTOMER_ID ?? "999000111";

if (!SECRET) {
  console.error("SHOPIFY_API_SECRET is required — it must match the DEPLOYED app's secret.");
  process.exit(2);
}

function withParams(params: Record<string, string>): URL {
  const url = new URL(BASE + PATH);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

/** Signs exactly as Shopify's App Proxy does: sorted `k=v` pairs, concatenated. */
function signed(params: Record<string, string>): string {
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const url = withParams(params);
  url.searchParams.set("signature", createHmac("sha256", SECRET!).update(message, "utf8").digest("hex"));
  return url.toString();
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function main(): Promise<void> {
  console.log(`LIVE GATE — ${BASE}${PATH}\n`);

  // ---- Fails closed. A signature proves the request came through the
  // proxy; it does not prove who is asking. ----

  let response = await fetch(withParams({ shop: SHOP, logged_in_customer_id: SMOKE_CUSTOMER_ID }).toString());
  check("an UNSIGNED request is refused", response.status === 401, `status ${response.status}`);

  const tampered = withParams({ shop: SHOP, logged_in_customer_id: SMOKE_CUSTOMER_ID });
  tampered.searchParams.set("signature", "0".repeat(64));
  response = await fetch(tampered.toString());
  check("a WRONG signature is refused", response.status === 401, `status ${response.status}`);

  response = await fetch(signed({ shop: SHOP }));
  check("a validly signed ANONYMOUS request is refused", response.status === 401, `status ${response.status}`);

  // What Shopify actually sends for a signed-out visitor — and it IS part
  // of the signed message, so this request is genuinely well-formed.
  response = await fetch(signed({ shop: SHOP, logged_in_customer_id: "" }));
  check("a signed request with an EMPTY customer id is refused", response.status === 401, `status ${response.status}`);

  // ---- Succeeds for a real authenticated caller. A 200 here also proves
  // the deployed secret matches the one signing above. ----

  response = await fetch(signed({ shop: SHOP, logged_in_customer_id: SMOKE_CUSTOMER_ID }));
  const authenticated = response.status === 200;
  check("a signed, AUTHENTICATED request succeeds", authenticated, `status ${response.status}`);
  check(
    "the response is uncacheable",
    response.headers.get("cache-control") === "no-store",
    `Cache-Control: ${response.headers.get("cache-control")}`
  );

  if (authenticated) {
    const body = (await response.json()) as {
      buyNow?: unknown[];
      groupBuy?: unknown[];
      coordinatesAvailable?: boolean;
    };

    check(
      "both lifecycles are reported separately",
      Array.isArray(body.buyNow) && Array.isArray(body.groupBuy),
      `buyNow=${Array.isArray(body.buyNow)} groupBuy=${Array.isArray(body.groupBuy)}`
    );
    check(
      "a customer who owns nothing sees nothing",
      body.buyNow?.length === 0 && body.groupBuy?.length === 0,
      `${body.buyNow?.length} + ${body.groupBuy?.length}`
    );
    // The point of D12: instructions must be statable WITHOUT an email. If
    // this is false in production, every payable order degrades to "email
    // us for the destination".
    check(
      "payment coordinates ARE configured in production",
      body.coordinatesAvailable === true,
      `coordinatesAvailable=${body.coordinatesAvailable}`
    );
    check(
      "no coordinate is emitted for a caller with no payable order",
      !/routing|accountNumber|zelle/i.test(JSON.stringify(body)),
      ""
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nLIVE GATE FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("\nLIVE GATE PASSED");
}

main().catch((error) => {
  console.error("\n", error);
  process.exitCode = 1;
});
