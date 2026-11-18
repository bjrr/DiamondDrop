import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ============================================================================
 * SHIPPING RULES APPLY TO EVERY PURCHASE PATH (owner decision 2026-11-18)
 * ============================================================================
 * The locked rule, from `docs/SHIPPING-AND-DELIVERY.md` §8: CaratForUs shipping
 * rules apply consistently to **Buy Now, Group Buy, Custom Jewelry and Let Us
 * Beat Your Quote**, on **Card and Bank Payment** alike. No path is a
 * free-shipping path, and in particular none of them may carry the superseded
 * unconditional zero shipping line.
 *
 * That rule arrived in two steps, and the second step existed because the
 * first one left holdouts:
 *
 *   2026-11-15  Buy Now and Group Buy stopped shipping free. Custom Jewelry
 *               and quote redemption were FLAGGED and deliberately left, since
 *               both price from a figure the customer had already agreed.
 *   2026-11-18  The owner ruled those prices are MERCHANDISE prices, so
 *               shipping is separate there too.
 *
 * ============================================================================
 * WHY THIS IS A SOURCE FENCE AND NOT ONLY A BEHAVIOURAL TEST
 * ============================================================================
 * Each path has its own behavioural tests, and those are where the charging
 * logic is actually proven. But a behavioural test only covers the path it
 * exercises, and the failure this guards against is **a fifth path appearing**
 * — or a sixth — that quietly reintroduces a zero line, in a method nobody
 * thought to write a shipping test for. That is exactly how the first two
 * holdouts survived the 2026-11-15 change: not by anyone deciding they should,
 * but by their being somewhere else.
 *
 * So the assertion is about the adapter as a whole: the superseded string must
 * not appear in it, and every method that builds a shippable draft order must
 * take a resolved shipping input. A new method that charges nothing for
 * shipping fails here before it reaches review.
 */

const ADAPTER = join(process.cwd(), "app", "shopify", "admin", "draftOrderAdapter.server.ts");
const SUPERSEDED_ZERO_LINE_TITLE = "Shipping (included in item price)";

/**
 * Every adapter method that creates a draft order for SHIPPABLE merchandise,
 * with the input field that proves it resolved a service first.
 *
 * `createServiceDraftOrder` is deliberately absent: the $49 Custom Jewelry
 * design deposit is a service with nothing to ship, so it states no shipping
 * fact at all. That is a permanent and correct exemption, not a gap — and it
 * is the ONLY one.
 */
const SHIPPABLE_METHODS = [
  { method: "createDraftOrder", requiredInputField: "shippingRateHandle: string;" },
  { method: "createRedemptionDraftOrder", requiredInputField: "shippingRateHandle: string;" },
  { method: "createCustomJewelryDraftOrder", requiredInputField: "shippingServiceTitle: string;" },
] as const;

const INPUT_TYPE_BY_METHOD: Record<string, string> = {
  createDraftOrder: "CreateDraftOrderInput",
  createRedemptionDraftOrder: "CreateRedemptionDraftOrderInput",
  createCustomJewelryDraftOrder: "CreateCustomJewelryDraftOrderInput",
};

function adapterSource(): string {
  return readFileSync(ADAPTER, "utf8");
}

/** The body of one `export interface X { ... }` declaration. */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name} not found in the adapter`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `interface ${name} is not terminated`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("shipping applies to every purchase path (owner decision 2026-11-18)", () => {
  it("the superseded zero shipping line is gone from the adapter entirely", () => {
    const source = adapterSource();
    // Comments are allowed to NAME the string, so that a search for it lands
    // on the explanation. What must not exist is a line of code that sets it,
    // so the check is for the string outside a comment: every occurrence must
    // sit on a line that is prose.
    const offending = source
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes(SUPERSEDED_ZERO_LINE_TITLE))
      .filter(({ line }) => {
        const trimmed = line.trimStart();
        return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
      });

    expect(
      offending.map((o) => `line ${o.number}: ${o.line.trim()}`),
      `the superseded zero shipping line is being set in code. Every purchase path charges ` +
        `shipping under docs/SHIPPING-AND-DELIVERY.md; a $0.00 line is only correct for a ` +
        `service with nothing to ship, and createServiceDraftOrder states no shipping line at all.`
    ).toEqual([]);
  });

  it("no adapter method sets a hard-coded zero shipping price", () => {
    const source = adapterSource();
    // `Money.zero(...)` reaching a shippingLine would be the same defect
    // wearing different clothes.
    const shippingLineBlocks = [...source.matchAll(/shippingLine:\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(shippingLineBlocks.length, "expected at least one shippingLine in the adapter").toBeGreaterThan(0);
    for (const block of shippingLineBlocks) {
      expect(block, `a shippingLine hard-codes a zero price: ${block}`).not.toMatch(/Money\.zero/);
    }
  });

  for (const { method, requiredInputField } of SHIPPABLE_METHODS) {
    it(`${method} cannot be called without a resolved shipping service`, () => {
      const source = adapterSource();
      const body = interfaceBody(source, INPUT_TYPE_BY_METHOD[method]!);

      // NON-OPTIONAL, which is the whole point. `shippingRateHandle?: string`
      // would let a caller omit it and fall back to no shipping line — the
      // superseded behaviour, reachable again by accident.
      expect(
        body.includes(requiredInputField),
        `${INPUT_TYPE_BY_METHOD[method]} must declare "${requiredInputField}" as a REQUIRED field, so ` +
          `"do not create an order until a valid shipping service has been resolved" is enforced by the ` +
          `type system rather than by a check a caller can forget.`
      ).toBe(true);

      const optionalForm = requiredInputField.replace(": string;", "?: string;");
      expect(
        body.includes(optionalForm),
        `${INPUT_TYPE_BY_METHOD[method]} declares "${optionalForm}" — an optional shipping input permits ` +
          `an order with no shipping charge.`
      ).toBe(false);
    });
  }

  it("the custom-jewelry line declares requiresShipping, or Shopify thinks a ring needs no shipping", () => {
    // Measured, not assumed: a custom line defaults to requiresShipping FALSE,
    // which both suppresses every shipping rate AND produces an order Shopify
    // believes needs no shipment. This method relied on that default until
    // 2026-11-18.
    const source = adapterSource();
    const start = source.indexOf("async createCustomJewelryDraftOrder(");
    expect(start, "createCustomJewelryDraftOrder not found").toBeGreaterThan(-1);
    const method = source.slice(start, source.indexOf("\n  async ", start + 10));
    expect(method).toContain("requiresShipping: true");
  });

  it("every shippable method verifies what Shopify actually charged", () => {
    // The echo check is the only thing standing between a silently substituted
    // service and a mis-charged customer — Shopify swaps a rate handle it no
    // longer considers earned WITHOUT a userError, which is how that was
    // discovered. One shared helper, called from each path.
    const source = adapterSource();
    const callSites = [...source.matchAll(/assertShippingEcho\(/g)].length;
    // One declaration plus one call per shippable method.
    expect(callSites).toBeGreaterThanOrEqual(SHIPPABLE_METHODS.length + 1);
  });
});
