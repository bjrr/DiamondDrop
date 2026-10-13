import { describe, expect, it } from "vitest";

import {
  DepositAmountMismatchError,
  depositInvoiceLineTitle,
  depositInvoiceTags,
  resolveDepositInvoiceAmount,
} from "./depositInvoice";
import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS } from "./designDepositAcknowledgmentText";

describe("the invoice amount comes from the acceptance, not from today's constant", () => {
  it("returns the authorized amount when it still matches", () => {
    const money = resolveDepositInvoiceAmount({
      amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
      currency: "USD",
    });
    expect(money.amountMinorUnits).toBe(4900n);
    expect(money.currency).toBe("USD");
  });

  it("REFUSES when the acceptance authorized MORE than today's price", () => {
    // Less obviously wrong than the other direction, and still wrong: the
    // record of what the customer agreed to would stop describing what we
    // are doing to them. A human needs to look either way.
    expect(() => resolveDepositInvoiceAmount({ amountMinorUnits: 9900n, currency: "USD" })).toThrow(
      DepositAmountMismatchError
    );
  });

  it("REFUSES when the acceptance authorized LESS than today's price", () => {
    // The dangerous direction: a price rise would otherwise invoice an old
    // acceptance at the new figure, charging a sum nobody agreed to.
    expect(() => resolveDepositInvoiceAmount({ amountMinorUnits: 2900n, currency: "USD" })).toThrow(
      DepositAmountMismatchError
    );
  });

  it("REFUSES on a currency difference even when the number matches", () => {
    expect(() => resolveDepositInvoiceAmount({ amountMinorUnits: 4900n, currency: "CAD" })).toThrow(
      DepositAmountMismatchError
    );
  });

  it("names both figures in the error, so the reader knows which way it diverged", () => {
    try {
      resolveDepositInvoiceAmount({ amountMinorUnits: 2900n, currency: "USD" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DepositAmountMismatchError);
      const message = (error as Error).message;
      expect(message).toContain("2900");
      expect(message).toContain("4900");
    }
  });
});

describe("what the customer sees on the invoice", () => {
  it("names the project, so a customer with two enquiries knows which deposit this is", () => {
    expect(depositInvoiceLineTitle("CJ-7Q2MPX4N")).toBe("Custom Jewelry Design Deposit — CJ-7Q2MPX4N");
  });

  it("carries no internal data", () => {
    // The line title is customer-facing AND visible to every Shopify admin
    // user. No cost, no margin, no internal id.
    const title = depositInvoiceLineTitle("CJ-7Q2MPX4N");
    expect(title).not.toMatch(/cost|margin|markup|internal/i);
    // The project REFERENCE is fine — it is already in the customer's own
    // confirmation email. The project's primary key is not.
    expect(title).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });
});

describe("tags make these orders findable as a class", () => {
  it("tags the order as a design deposit and by project", () => {
    expect(depositInvoiceTags("CJ-7Q2MPX4N")).toEqual(["carat-design-deposit", "carat-project-CJ-7Q2MPX4N"]);
  });

  it("the class tag is stable — anything reading the order stream keys on it", () => {
    const [classTag] = depositInvoiceTags("CJ-ANYTHING");
    expect(classTag).toBe("carat-design-deposit");
  });
});
