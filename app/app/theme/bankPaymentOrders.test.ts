import { beforeEach, describe, expect, it } from "vitest";

import {
  loadBankPaymentOrders,
  type BankPaymentOrdersModule,
  type BankPaymentOrdersWindow,
} from "./bankPaymentOrdersSandbox";

/**
 * The durable Bank Payment orders page (register D12) — its pure decisions.
 *
 * WHAT THIS FILE IS FOR. The page shows a customer where to send money. The
 * ways it can be wrong that actually cost something are: showing payment
 * instructions for an order that must not be paid, hiding an order because
 * its status word was unfamiliar, and treating "we cannot state a
 * destination right now" as "your orders do not exist". Those three are
 * decided by `summarize`, `statusLabel` and `isLapsedGroupBuy`, and they are
 * what this file pins.
 *
 * Rendering is out of scope here and says so in the sandbox header.
 */

let module: BankPaymentOrdersModule;
let windowStub: BankPaymentOrdersWindow;

beforeEach(() => {
  const loaded = loadBankPaymentOrders();
  module = loaded.module;
  windowStub = loaded.windowStub;
});

function buyNow(overrides: Record<string, unknown> = {}) {
  return {
    reference: "bpo_1",
    status: "open",
    formattedAmountDue: "1200.00",
    currency: "USD",
    quotedAt: "2026-10-24T12:00:00.000Z",
    guaranteeExpiresAt: "2026-10-25T12:00:00.000Z",
    instructions: { methods: [] },
    ...overrides,
  };
}

describe("summarize — what the page shows", () => {
  it("reports empty when the customer has no Bank Payment orders at all", () => {
    const view = module._internal.summarize({ buyNow: [], groupBuy: [], coordinatesAvailable: true });
    expect(view.isEmpty).toBe(true);
    expect(view.coordinatesMissing).toBe(false);
  });

  it("tolerates a malformed payload instead of throwing on the customer", () => {
    // A page that white-screens is worse than a page that says "nothing here",
    // because the customer cannot tell the difference between the two from a
    // blank screen and will assume their order is gone.
    expect(module._internal.summarize(null).isEmpty).toBe(true);
    expect(module._internal.summarize({}).isEmpty).toBe(true);
    expect(module._internal.summarize({ buyNow: undefined }).isEmpty).toBe(true);
  });

  it("keeps both flows separate rather than merging them into one list", () => {
    const view = module._internal.summarize({
      buyNow: [buyNow()],
      groupBuy: [{ reference: "gbo_1", instructions: { methods: [] } }],
      coordinatesAvailable: true,
    });
    expect(view.buyNow).toHaveLength(1);
    expect(view.groupBuy).toHaveLength(1);
    expect(view.isEmpty).toBe(false);
  });

  it("flags missing coordinates only when an order actually lacks instructions", () => {
    // Coordinates unconfigured AND an order the customer might want to pay.
    const stranded = module._internal.summarize({
      buyNow: [buyNow({ instructions: null })],
      groupBuy: [],
      coordinatesAvailable: false,
    });
    expect(stranded.coordinatesMissing).toBe(true);
    expect(stranded.isEmpty).toBe(false); // the orders are still shown
  });

  it("does NOT flag missing coordinates for a customer with no orders", () => {
    // An unconfigured provider is a staff problem. Telling a customer with
    // nothing outstanding that "we cannot display payment instructions" is
    // alarming and meaningless to them.
    const view = module._internal.summarize({
      buyNow: [],
      groupBuy: [],
      coordinatesAvailable: false,
    });
    expect(view.coordinatesMissing).toBe(false);
  });

  it("does NOT flag missing coordinates when every order already has instructions", () => {
    const view = module._internal.summarize({
      buyNow: [buyNow()],
      groupBuy: [],
      coordinatesAvailable: true,
    });
    expect(view.coordinatesMissing).toBe(false);
  });

  it("never invents instructions — a paid order carries none and stays that way", () => {
    // The ROUTE decides payability and attaches instructions only when the
    // order is payable. Nothing in this file may second-guess that; if it
    // did, a cancelled order would show a payment destination.
    const view = module._internal.summarize({
      buyNow: [buyNow({ status: "paid", instructions: null })],
      groupBuy: [],
      coordinatesAvailable: true,
    });
    expect((view.buyNow[0] as { instructions: unknown }).instructions).toBeNull();
  });
});

describe("statusLabel — the two lifecycles are not the same vocabulary", () => {
  beforeEach(() => {
    windowStub.bankPaymentOrdersStrings = {
      status_buy_now_open: "Awaiting your payment",
      status_group_buy_active: "Awaiting your payment",
      status_group_buy_inactive: "Inactive — payment window passed",
    };
  });

  it("reads a flow-specific key", () => {
    expect(module._internal.statusLabel("buy_now", "open")).toBe("Awaiting your payment");
    expect(module._internal.statusLabel("group_buy", "inactive")).toBe(
      "Inactive — payment window passed"
    );
  });

  it("does not cross flows — a Buy Now order never borrows a Group Buy label", () => {
    // `inactive` is the Group Buy 96-hour lapse and has no Buy Now meaning.
    // Falling through to the raw value is correct; borrowing the Group Buy
    // sentence would tell a Buy Now customer about an extension they do not
    // have.
    expect(module._internal.statusLabel("buy_now", "inactive")).toBe("inactive");
  });

  it("falls through to the raw status rather than rendering nothing", () => {
    // A customer can quote an unfamiliar word to support. A blank cell is
    // indistinguishable from a broken page.
    expect(module._internal.statusLabel("buy_now", "some_future_status")).toBe("some_future_status");
  });

  it("falls through when the strings object is absent entirely", () => {
    windowStub.bankPaymentOrdersStrings = undefined;
    expect(module._internal.statusLabel("buy_now", "open")).toBe("open");
  });

  it("treats an empty-string translation as missing", () => {
    windowStub.bankPaymentOrdersStrings = { status_buy_now_open: "" };
    expect(module._internal.statusLabel("buy_now", "open")).toBe("open");
  });
});

describe("isLapsedGroupBuy — whether to offer reactivation", () => {
  it("is false for an order that never lapsed", () => {
    expect(module._internal.isLapsedGroupBuy({ inactivatedAt: null, reactivatedAt: null })).toBe(false);
  });

  it("is true once inactivated and never brought back", () => {
    expect(
      module._internal.isLapsedGroupBuy({ inactivatedAt: "2026-10-20T00:00:00.000Z", reactivatedAt: null })
    ).toBe(true);
  });

  it("is false when staff reactivated it AFTER the lapse", () => {
    expect(
      module._internal.isLapsedGroupBuy({
        inactivatedAt: "2026-10-20T00:00:00.000Z",
        reactivatedAt: "2026-10-21T00:00:00.000Z",
      })
    ).toBe(false);
  });

  it("is true again when it lapsed a SECOND time after an earlier reactivation", () => {
    // The ordering matters, not merely the presence of both timestamps: an
    // order reactivated in September and lapsed again in October is lapsed
    // now, and must still be offered the reactivation line.
    expect(
      module._internal.isLapsedGroupBuy({
        inactivatedAt: "2026-10-20T00:00:00.000Z",
        reactivatedAt: "2026-09-01T00:00:00.000Z",
      })
    ).toBe(true);
  });

  it("is false for a missing order rather than throwing", () => {
    expect(module._internal.isLapsedGroupBuy(null)).toBe(false);
  });
});

describe("formatDeadline", () => {
  it("renders an ISO instant as a readable UTC string", () => {
    expect(module._internal.formatDeadline("2026-10-25T12:34:56.000Z")).toBe("2026-10-25 12:34 UTC");
  });

  it("returns an unparseable value unchanged instead of printing 'Invalid Date'", () => {
    expect(module._internal.formatDeadline("not-a-date")).toBe("not-a-date");
  });
});

describe("messageKeyForFailure — never leaks a server detail", () => {
  it("maps 401 to the sign-in message", () => {
    expect(module._internal.messageKeyForFailure(401)).toBe("error_authentication_required");
  });

  it("maps 404 to its own message", () => {
    expect(module._internal.messageKeyForFailure(404)).toBe("error_not_found");
  });

  it("maps every other status to the generic message", () => {
    for (const status of [400, 403, 500, 502, 503]) {
      expect(module._internal.messageKeyForFailure(status)).toBe("error_generic");
    }
  });
});
