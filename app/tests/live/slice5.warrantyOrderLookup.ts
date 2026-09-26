/**
 * SLICE 5 LIVE GATE — the D33 order-lookup Admin API BEHAVIOUR (matching
 * semantics, not merely schema shape — see `tests/live/
 * slice5.orderLookupSchemaIntrospection.ts` for the schema-level pass, which
 * this gate complements rather than duplicates).
 *
 * `warrantyOrderLookupAdapter.server.ts`'s `orders(query: "name:...")` and
 * `order(id:)` shapes were RECALLED, not live-verified, when D33 shipped (no
 * store credentials were available in that pass) — flagged explicitly in
 * that file's own header, same as the identical gap in the older
 * `warrantyClaimOrderLookupAdapter.server.ts`.
 *
 * THE MISTAKE THIS GATE IS WRITTEN TO NOT REPEAT (read before touching this
 * file). An earlier live-gate pass for a sibling route (`slice5.warrantyIntake.ts`)
 * invented plausible field names, every request was rejected on schema, and
 * the harness's "expect a 4xx" assertion PASSED — a green run that proved
 * only that the payload was wrong, not that anything real was verified. This
 * gate exercises the ACTUAL adapter CLASS (`ShopifyWarrantyOrderLookupAdapter`,
 * imported directly, not a hand-copied query string that could quietly drift
 * from it) and asserts the POSITIVE shape: the specific order id/name/line
 * items it returns, checked against a SECOND, independent query — never
 * merely "the call did not throw".
 *
 * ============================================================================
 * KNOWN OPEN ITEM — READ THIS BEFORE TRUSTING A GREEN RUN
 * ============================================================================
 * As of 2026-09-26, caratforus-dev has ZERO orders. Section 0 below finds a
 * real order to test the FOUND path against; when none exists, it logs that
 * and skips straight to the not-found assertions. A run that only exercised
 * sections 3-4 (not-found) has NOT verified that `orders(query: "name:#1001")`
 * actually MATCHES the order with that exact name — only that a name which
 * certainly does not exist correctly returns `null` rather than throwing.
 * Schema introspection (the sibling gate above) cannot answer the match
 * question either: it confirms the `query` argument is a `String`, not what
 * string value produces what match. THIS STAYS OPEN until this gate is
 * re-run against a store that has at least one real order — which will
 * happen naturally the first time the owner places a test order for live
 * verification. Do not mark this closed on a run whose section 1/2 output
 * says "cannot exercise the positive-shape assertions".
 *
 * RUN:  npx tsx tests/live/slice5.warrantyOrderLookup.ts
 *
 * SIDE EFFECTS: NONE. Every query here is read-only (`orders`, `order`) —
 * no draft order, no order, no acknowledgment, no database row of ours is
 * created. This is safe to re-run as often as useful, including once real
 * order data exists, to close the KNOWN OPEN ITEM above.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { errors?: unknown; data?: T };
  if (body.errors) throw new Error(`top-level errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

async function main() {
  console.log(`Slice 5 live gate — D33 warranty order-lookup Admin API shapes against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  const { ShopifyWarrantyOrderLookupAdapter } = await import("~/shopify/admin/warrantyOrderLookupAdapter.server");
  const adapter = new ShopifyWarrantyOrderLookupAdapter(admin);

  // -------------------------------------------------------------------------
  // A REAL order, obtained by an INDEPENDENT query the adapter never runs —
  // so the adapter's own answer can be checked against a second source of
  // truth, not merely trusted.
  // -------------------------------------------------------------------------
  console.log("0. finding a real order with at least one line item, independently of the adapter");
  const recent = await gql<{
    orders: { nodes: { id: string; name: string; lineItems: { nodes: { id: string }[] } }[] };
  }>(
    admin,
    `#graphql
      query CaratLiveGateRecentOrder {
        orders(first: 10, reverse: true) {
          nodes { id name lineItems(first: 1) { nodes { id } } }
        }
      }
    `
  );
  const referenceOrder = recent.orders.nodes.find((o) => o.lineItems.nodes.length > 0);
  if (!referenceOrder) {
    console.log("No order with a line item exists in this store — cannot exercise the positive-shape assertions.");
    console.log("The not-found assertions below still run.\n");
  } else {
    console.log(`  using ${referenceOrder.name}  ${referenceOrder.id}\n`);
  }

  if (referenceOrder) {
    // -----------------------------------------------------------------------
    // findOrderByName — the shape the GUEST and LOGGED-IN lookup flows both
    // depend on to resolve a human-typed order number.
    // -----------------------------------------------------------------------
    console.log(`1. adapter.findOrderByName("${referenceOrder.name}") — expect it to resolve to the SAME order`);
    const byName = await adapter.findOrderByName(referenceOrder.name);
    check(byName !== null, "resolved (not null)");
    if (byName) {
      check(byName.orderGid === referenceOrder.id, `orderGid matches the independently-fetched order (${byName.orderGid})`);
      check(byName.orderName === referenceOrder.name, `orderName matches (${byName.orderName})`);
      check(typeof byName.orderEmail === "string" || byName.orderEmail === null, "orderEmail is a string or null");
      check(byName.customerGid === null || byName.customerGid.startsWith("gid://shopify/Customer/"), "customerGid is null or a real Customer gid");
      check(Array.isArray(byName.lineItems) && byName.lineItems.length > 0, `lineItems is non-empty (${byName.lineItems.length})`);
      const line = byName.lineItems[0]!;
      check(line.lineRef.startsWith("gid://shopify/LineItem/"), `lineItems[0].lineRef looks like a real LineItem gid (${line.lineRef})`);
      check(typeof line.title === "string" && line.title.length > 0, `lineItems[0].title is a non-empty string ("${line.title}")`);
      check(typeof line.quantity === "number" && line.quantity >= 1, `lineItems[0].quantity is a real number (${line.quantity})`);
    }

    // -----------------------------------------------------------------------
    // findOrderByGid — the shape the REDEMPTION path depends on to re-fetch
    // fresh line items after a guest verification token is consumed.
    // -----------------------------------------------------------------------
    console.log(`\n2. adapter.findOrderByGid("${referenceOrder.id}") — expect the SAME order back`);
    const byGid = await adapter.findOrderByGid(referenceOrder.id);
    check(byGid !== null, "resolved (not null)");
    if (byGid) {
      check(byGid.orderGid === referenceOrder.id, "orderGid matches");
      check(byGid.orderName === referenceOrder.name, `orderName matches (${byGid.orderName})`);
      check(byGid.lineItems.length === byName?.lineItems.length, "same line item count as findOrderByName's answer for the same order");
    }
  }

  // ---------------------------------------------------------------------------
  // NOT FOUND — an order number/id that certainly does not exist must resolve
  // to `null`, never throw and never silently return an unrelated order. This
  // is criterion 155's exact refusal condition for the SIBLING intake route,
  // and this adapter's `null` contract is what lets both lookup routes give
  // the same generic "not found" answer D33 requires.
  // ---------------------------------------------------------------------------
  console.log("\n3. a name that certainly does not exist — expect null, not an error");
  const missingByName = await adapter.findOrderByName("#999999999999");
  check(missingByName === null, `findOrderByName returned null (got ${JSON.stringify(missingByName)})`);

  console.log("\n4. a gid that certainly does not exist — expect null, not an error");
  const missingByGid = await adapter.findOrderByGid("gid://shopify/Order/999999999999");
  check(missingByGid === null, `findOrderByGid returned null (got ${JSON.stringify(missingByGid)})`);

  console.log(failures === 0 ? "\nLIVE GATE PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
