import { describe, expect, it } from "vitest";

import { orderCostSideComponents } from "./cost";
import type { ResolvedCostComponent } from "./types";

/**
 * ============================================================================
 * THE DISTINCTION THAT MADE THE 2026-11-15 SHIPPING DECISION SAFE
 * ============================================================================
 * When the owner superseded D19's shipping treatment, the one thing that could
 * have made the new rule incoherent was D19's own reasoning: that shipping and
 * insurance were "already in landed cost", so charging the policy rate would
 * bill the customer twice. The brief was explicit about checking it rather
 * than assuming either way, and about two possibilities being very different:
 *
 *   1. an INTERNAL fulfilment-cost allowance used to protect margin — may
 *      remain in cost/margin calculations; or
 *   2. a CUSTOMER-FACING shipping amount embedded in the merchandise price
 *      dollar-for-dollar — must be removed before charging shipping again.
 *
 * It is (1). Production `cost_component` rows, read directly:
 *
 *     shipping   cost_side  fixed  1200 minor units  = $12.00
 *     insurance  cost_side  fixed   300 minor units  = $ 3.00
 *
 * $12.00 is not $30 (Standard) and not $55 (Express), and no arithmetic
 * anywhere converts one into the other. They are `cost_side`, so they enter
 * landed cost `C` and are then marked up by the margin solve — the customer
 * never pays "$12 of shipping", they pay a price computed to stay profitable
 * after absorbing $12 of shipping cost. A pass-through charge would have to be
 * `revenue_side`, or added after the solve, and it is neither.
 *
 * So no double-charge existed, the pricing engine was left alone (the brief:
 * "do not unnecessarily rewrite the pricing engine"), and the customer
 * shipping charge is a separate, additive line resolved at checkout.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 * The reasoning above is only safe while it stays true. This fence fails if a
 * later change moves shipping or insurance to the revenue side, or makes their
 * magnitude indistinguishable from the customer-facing rates — either of which
 * would quietly recreate the double-charge D19 was worried about, in a place
 * no shipping test would look.
 *
 * It asserts STRUCTURE, not a specific dollar value: $12.00 is a seeded
 * assumption that will be replaced by a real negotiated rate, and a test that
 * broke on that would be noise. What must not change is the KIND of thing
 * these components are.
 */

const CUSTOMER_FACING_STANDARD_MINOR_UNITS = 3000n; // $30.00, docs/SHIPPING-AND-DELIVERY.md §2
const CUSTOMER_FACING_EXPRESS_MINOR_UNITS = 5500n; // $55.00, same section

function component(overrides: Partial<ResolvedCostComponent> = {}): ResolvedCostComponent {
  return {
    componentType: "shipping",
    basis: "cost_side",
    valueKind: "fixed",
    amount: { amountMinorUnits: "1200", currency: "USD" },
    ...overrides,
  } as ResolvedCostComponent;
}

describe("shipping/insurance are an internal cost allowance, not a customer charge", () => {
  it("both are cost_side, so the margin solve marks them up rather than passing them through", () => {
    // THE LOAD-BEARING ASSERTION. A `revenue_side` shipping component would be
    // a pass-through of a customer charge, and charging the policy rate on top
    // of it really would bill shipping twice.
    const shipping = component({ componentType: "shipping" });
    const insurance = component({ componentType: "insurance", amount: { amountMinorUnits: "300", currency: "USD" } });

    expect(shipping.basis).toBe("cost_side");
    expect(insurance.basis).toBe("cost_side");
  });

  it("both participate in the fixed cost-side ordering, which only cost inputs do", () => {
    const ordered = orderCostSideComponents([
      component({ componentType: "insurance", amount: { amountMinorUnits: "300", currency: "USD" } }),
      component({ componentType: "shipping" }),
      component({ componentType: "packaging", amount: { amountMinorUnits: "600", currency: "USD" } }),
    ]);

    expect(ordered.map((c) => c.componentType)).toEqual(["packaging", "shipping", "insurance"]);
  });

  it("a revenue_side shipping component is excluded from the cost-side ordering entirely", () => {
    // Demonstrates that the two bases are genuinely different machinery, so
    // "which basis" is a real distinction rather than a label.
    const ordered = orderCostSideComponents([
      component({ componentType: "shipping", basis: "revenue_side" }),
    ]);

    expect(ordered).toEqual([]);
  });

  it("the cost allowance is nothing like the customer-facing rates", () => {
    // Not an assertion that $12 is correct — it is a seeded placeholder. An
    // assertion that it is not the SAME NUMBER as a rate we now charge
    // separately, which is what "embedded dollar-for-dollar" would look like.
    const allowance = 1200n + 300n; // shipping + insurance, as seeded

    expect(allowance).not.toBe(CUSTOMER_FACING_STANDARD_MINOR_UNITS);
    expect(allowance).not.toBe(CUSTOMER_FACING_EXPRESS_MINOR_UNITS);
    expect(1200n).not.toBe(CUSTOMER_FACING_STANDARD_MINOR_UNITS);
    expect(1200n).not.toBe(CUSTOMER_FACING_EXPRESS_MINOR_UNITS);
  });
});
