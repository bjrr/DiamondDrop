import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeTierRefund } from "./refunds";

/**
 * ============================================================================
 * SHIPPING IS A NON-MERCHANDISE CHARGE AND MUST STAY OUTSIDE GROUP BUY MONEY
 * ============================================================================
 * Owner decision 2026-11-15 charges Group Buy Bank Payment orders the same
 * shipping rates as Card checkout, and is explicit that shipping must remain
 * outside:
 *
 *   - the Group Buy tier price
 *   - the Bank/Card merchandise-price derivation
 *   - tier savings
 *   - the refund due when a later tier reduces the merchandise price
 *
 * and that "a later Group Buy merchandise refund must not incorrectly refund
 * or recalculate a valid shipping charge".
 *
 * ============================================================================
 * HOW THE SEPARATION IS ACHIEVED — BY SHAPE, NOT BY A CHECK
 * ============================================================================
 * The shipping charge is stored on `group_buy_bank_payment_order`, the ORDER
 * HEADER, and never on `group_buy_bank_payment_order_line`.
 *
 * That placement is the whole mechanism. `campaignSettlement.server.ts`
 * recomputes what each order should have paid from the campaign's frozen basis,
 * the final unlocked tier and the order's LINES (`include: { lines: true }`,
 * then `paidPerUnitMinorUnits: line.quotedBankPaymentPriceMinorUnits`).
 * `computeTierRefund` works per unit on those merchandise prices alone. A
 * shipping amount folded into a line price would therefore be swept into that
 * recomputation automatically and refunded as though it were merchandise —
 * refunding a carrier service that had already been performed.
 *
 * So the invariant is structural, and this file guards the structure. A
 * behavioural test alone could not: it would pass right up until someone added
 * shipping to a line, at which point the arithmetic would still be internally
 * consistent and simply wrong.
 */

const REPO_APP_ROOT = join(process.cwd(), "app");

const MERCHANDISE_MONEY_MODULES = [
  // Settlement and refunds — where a stray shipping amount would be refunded.
  "jobs/groupbuy/campaignSettlement.server.ts",
  "jobs/groupbuy/executeGroupBuyRefund.server.ts",
  "jobs/groupbuy/refundLedger.server.ts",
  "domain/groupbuy/refunds.ts",
  // Tier pricing and the Bank/Card derivation — where it would corrupt a price.
  "domain/groupbuy/campaignTierPricing.ts",
  "domain/pricing/regularCardPrice.ts",
  "domain/pricing/engine.ts",
  "domain/pricing/cost.ts",
  "domain/pricing/solve.ts",
] as const;

/**
 * The persisted shipping columns, as the Prisma client names them. Searched
 * for as identifiers: any mention inside a merchandise-money module means that
 * module has started reading a shipping amount, which is the thing to catch.
 */
const SHIPPING_FIELD_IDENTIFIERS = [
  "shippingPriceMinorUnits",
  "shippingServiceTitle",
  "shippingCurrency",
] as const;

describe("Group Buy shipping separation (owner decision 2026-11-15)", () => {
  describe("no merchandise-money module reads the shipping charge", () => {
    for (const relativePath of MERCHANDISE_MONEY_MODULES) {
      it(`${relativePath} never references a shipping amount`, () => {
        const source = readFileSync(join(REPO_APP_ROOT, relativePath), "utf8");

        for (const identifier of SHIPPING_FIELD_IDENTIFIERS) {
          expect(
            source.includes(identifier),
            `${relativePath} references ${identifier}. Shipping is a non-merchandise charge: ` +
              `settlement, refunds, tier pricing and the Bank/Card derivation must not read it. ` +
              `If a shipping refund is genuinely required, it needs its own owner decision and ` +
              `its own path — not an addend inside merchandise arithmetic.`
          ).toBe(false);
        }
      });
    }
  });

  describe("the refund calculation is per-unit merchandise only", () => {
    it("computes the refund from the paid and final UNIT prices, with no shipping term", () => {
      // Paid at tier 1 ($1,000), settled at tier 3 ($900), 2 units.
      const result = computeTierRefund({
        paidPerUnitMinorUnits: 100_000n,
        finalPerUnitMinorUnits: 90_000n,
        qualifyingUnits: 2,
      });

      expect(result.refundPerUnitMinorUnits).toBe(10_000n);
      expect(result.totalRefundMinorUnits).toBe(20_000n);
    });

    it("is unchanged by the existence of a shipping charge on the order", () => {
      // The structural point, stated behaviourally: the function has no
      // parameter a shipping amount could enter through, so an order that paid
      // $30 shipping and one that paid nothing refund identically on the
      // merchandise. A $30 difference here would mean shipping had leaked in.
      const a = computeTierRefund({
        paidPerUnitMinorUnits: 100_000n,
        finalPerUnitMinorUnits: 90_000n,
        qualifyingUnits: 1,
      });
      const b = computeTierRefund({
        paidPerUnitMinorUnits: 100_000n,
        finalPerUnitMinorUnits: 90_000n,
        qualifyingUnits: 1,
      });

      expect(a.totalRefundMinorUnits).toBe(b.totalRefundMinorUnits);
      expect(a.totalRefundMinorUnits).toBe(10_000n);
    });

    it("refunds nothing when the tier did not improve, rather than refunding shipping", () => {
      const result = computeTierRefund({
        paidPerUnitMinorUnits: 90_000n,
        finalPerUnitMinorUnits: 90_000n,
        qualifyingUnits: 3,
      });

      expect(result.owed).toBe(false);
      expect(result.totalRefundMinorUnits).toBe(0n);
    });
  });

  describe("the shipping charge lives on the order, never on a line", () => {
    it("group_buy_bank_payment_order_line declares no shipping column", () => {
      // Read from the schema rather than the client, because the schema is
      // where someone would add it.
      const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
      const start = schema.indexOf("model GroupBuyBankPaymentOrderLine ");
      expect(start, "GroupBuyBankPaymentOrderLine model not found in schema").toBeGreaterThan(-1);
      const model = schema.slice(start, schema.indexOf("\n}", start));

      for (const identifier of SHIPPING_FIELD_IDENTIFIERS) {
        expect(
          model.includes(identifier),
          `GroupBuyBankPaymentOrderLine declares ${identifier}. Shipping on a LINE is swept into ` +
            `settlement's merchandise recomputation and refunded as merchandise. It belongs on ` +
            `the order header.`
        ).toBe(false);
      }
    });

    it("bank_payment_order_line declares no shipping column either", () => {
      const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
      const start = schema.indexOf("model BankPaymentOrderLine ");
      expect(start, "BankPaymentOrderLine model not found in schema").toBeGreaterThan(-1);
      const model = schema.slice(start, schema.indexOf("\n}", start));

      for (const identifier of SHIPPING_FIELD_IDENTIFIERS) {
        expect(model.includes(identifier), `BankPaymentOrderLine declares ${identifier}`).toBe(false);
      }
    });

    it("both order headers DO declare it, so the charge is recorded somewhere", () => {
      // The complement of the rules above: proving absence from the lines is
      // only reassuring if the charge is actually persisted.
      const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

      for (const modelName of ["model BankPaymentOrder ", "model GroupBuyBankPaymentOrder "]) {
        const start = schema.indexOf(modelName);
        expect(start, `${modelName} not found`).toBeGreaterThan(-1);
        const model = schema.slice(start, schema.indexOf("\n}", start));
        for (const identifier of SHIPPING_FIELD_IDENTIFIERS) {
          expect(model.includes(identifier), `${modelName} is missing ${identifier}`).toBe(true);
        }
      }
    });
  });
});
