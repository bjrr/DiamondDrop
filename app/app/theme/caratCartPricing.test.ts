import { describe, expect, it, vi } from "vitest";

import { createFakeMoneyNode, loadCaratCartPricing, makeQuerySelectorAll } from "./caratCartPricingSandbox";

/**
 * Unit tests for the mode-aware cart pricing applier (Stage 2B task 2B-4,
 * docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md R12/L1/L2/L3/L5), loaded
 * from the REAL `theme/assets/cart.js` via caratCartPricingSandbox.ts — see
 * that file's header for why a vm sandbox rather than jsdom or a duplicated
 * mirror module.
 *
 * SCOPE. These tests cover the pure logic (money formatting, mode reading,
 * request-line building, DTO-to-node mapping) and the orchestration logic
 * (apply()'s success/failure/staleness handling, the global pubsub
 * subscription's source filter) using fake nodes and a mocked `fetch`. They
 * do NOT exercise real browser DOM, real network calls, or the actual
 * cart.js/cart-drawer.js call sites that invoke `apply()` (updateQuantity,
 * onCartUpdate, connectedCallback, CartDrawer#renderContents,
 * CartNotification#renderContents) — those are integration/interaction
 * behaviour this repo has no browser test harness for yet. Flagged in the
 * 2B-4 handoff as a follow-up (Playwright or equivalent) rather than
 * silently claimed as covered here.
 */

function buildDto(overrides: Partial<any> = {}) {
  return {
    mode: "bank",
    currency: "USD",
    lines: [
      {
        lineId: "line-1",
        shopifyVariantId: "111",
        quantity: "2",
        purchasable: true,
        bankPaymentDiscountEligible: true,
        unitBankPaymentPriceMinorUnits: "150000",
        unitRegularCardPriceMinorUnits: "157500",
        activeUnitPriceMinorUnits: "150000",
        lineActiveTotalMinorUnits: "300000",
        // All three quantity-extended: (157500 * 2), (150000 * 2), and their
        // difference. Server-authoritative (proxyResponseDto.ts) — none of
        // these three are derived client-side.
        lineCardBasisTotalMinorUnits: "315000",
        lineBankBasisTotalMinorUnits: "300000",
        lineBankPaymentSavingsMinorUnits: "15000",
      },
    ],
    cardMerchandiseTotalMinorUnits: "315000",
    bankMerchandiseTotalMinorUnits: "300000",
    bankPaymentSavingsMinorUnits: "15000",
    activeMerchandiseTotalMinorUnits: "300000",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("CaratCartPricing._internal.formatMoneyFromMinorUnits", () => {
  it("formats a typical amount with cents and thousands grouping", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("1234567", "USD")).toBe("$12,345.67");
  });

  it("formats an amount under a dollar", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("5", "USD")).toBe("$0.05");
  });

  it("formats exactly zero", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("0", "USD")).toBe("$0.00");
  });

  it("formats a negative amount (defensive — not expected from this DTO today)", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("-150", "USD")).toBe("-$1.50");
  });

  it("falls back to a currency-code prefix for a non-USD currency", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("100", "EUR")).toBe("EUR 1.00");
  });

  it("returns null for a non-numeric string rather than throwing", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("not-a-number", "USD")).toBeNull();
  });

  it("never converts through a JS float (spot check: a value unrepresentable exactly as a double cents division)", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    // 10.10 cannot be represented exactly in IEEE-754; a naive `Number(minorUnits) / 100` implementation
    // is prone to this class of bug. Pure string slicing has no such hazard.
    expect(caratCartPricing._internal.formatMoneyFromMinorUnits("1010", "USD")).toBe("$10.10");
  });
});

describe("CaratCartPricing._internal.readModeFromCart", () => {
  it("reads bank mode from the cart attribute", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.readModeFromCart({ attributes: { carat_payment_mode: "bank" } })).toBe("bank");
  });

  it("reads card mode explicitly", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.readModeFromCart({ attributes: { carat_payment_mode: "card" } })).toBe("card");
  });

  it("defaults to card when the attribute is absent", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.readModeFromCart({ attributes: {} })).toBe("card");
  });

  it("defaults to card for an unrecognized value rather than trusting it", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.readModeFromCart({ attributes: { carat_payment_mode: "bogus" } })).toBe("card");
  });

  it("does not throw on a missing attributes object", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.readModeFromCart({})).toBe("card");
  });
});

describe("CaratCartPricing._internal.buildRequestLines", () => {
  it("maps Ajax cart items to the proxy request line shape", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const lines = caratCartPricing._internal.buildRequestLines({
      items: [{ key: "abc:123", variant_id: 4455, id: 4455, quantity: 3 }],
    });
    expect(lines).toEqual([{ lineId: "abc:123", shopifyVariantId: "4455", quantity: 3 }]);
  });

  it("falls back to item.id when variant_id is missing", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const lines = caratCartPricing._internal.buildRequestLines({
      items: [{ key: "abc:123", id: 9988, quantity: 1 }],
    });
    expect(lines).toEqual([{ lineId: "abc:123", shopifyVariantId: "9988", quantity: 1 }]);
  });

  it("returns an empty array for an empty cart", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    expect(caratCartPricing._internal.buildRequestLines({ items: [] })).toEqual([]);
  });
});

describe("CaratCartPricing._internal.selectDisplayMinorUnits", () => {
  it("resolves line-unit for a purchasable line", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto();
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-unit", "line-1")).toBe("150000");
  });

  it("resolves line-total for a purchasable line", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto();
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-total", "line-1")).toBe("300000");
  });

  it("resolves cart-subtotal and cart-total to the same merchandise total (owner §5: never a re-tiered figure)", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto();
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "cart-subtotal", null)).toBe("300000");
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "cart-total", null)).toBe("300000");
  });

  it("returns null for an unknown lineId (stale/removed line) rather than guessing", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto();
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-unit", "does-not-exist")).toBeNull();
  });

  it("returns null for an unpurchasable line even if the lineId matches", () => {
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto({
      lines: [{ lineId: "line-1", shopifyVariantId: "111", quantity: "1", purchasable: false, reason: "unsynced" }],
    });
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-unit", "line-1")).toBeNull();
  });

  it("returns undefined (not null) for an unrecognized data-carat-money kind — distinguishing 'not my job' from 'try again later'", () => {
    // undefined vs null is a deliberate signal applyDtoToDocument depends on:
    // null means "line not found, leave pending"; undefined means "no
    // display mapping / missing field, fail loudly". In practice
    // applyDtoToDocument gates on VALID_CARAT_MONEY_KINDS before ever
    // reaching this function, so this default branch is defense in depth.
    const { caratCartPricing } = loadCaratCartPricing(vi.fn());
    const dto = buildDto();
    expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "savings", null)).toBeUndefined();
  });

  describe("owner §3 simultaneous card/bank/saving breakdown (2B-3 amendment)", () => {
    it("resolves the four cart-level breakdown kinds to their direct DTO fields — no derivation", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      const dto = buildDto();
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "cart-card-total", null)).toBe("315000");
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "cart-bank-total", null)).toBe("300000");
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "cart-saving", null)).toBe("15000");
    });

    it("resolves line-card directly from the quantity-extended lineCardBasisTotalMinorUnits field", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      const dto = buildDto();
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-card", "line-1")).toBe("315000");
    });

    it("resolves line-bank directly from the quantity-extended lineBankBasisTotalMinorUnits field, unconditionally — no eligibility branch in this file", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      const dto = buildDto();
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-bank", "line-1")).toBe("300000");
    });

    it("resolves line-saving directly from the server-authoritative, quantity-extended DTO field (no client-side subtraction)", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      const dto = buildDto();
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-saving", "line-1")).toBe("15000");
    });

    it("the three breakdown figures reconcile by eye at any quantity: line-card minus line-bank equals line-saving", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      // Quantity 10, mirroring the team lead's own reconciliation example.
      const dto = buildDto({
        lines: [
          {
            lineId: "line-1",
            shopifyVariantId: "111",
            quantity: "10",
            purchasable: true,
            bankPaymentDiscountEligible: true,
            unitBankPaymentPriceMinorUnits: "40000",
            unitRegularCardPriceMinorUnits: "42000",
            activeUnitPriceMinorUnits: "40000",
            lineActiveTotalMinorUnits: "400000",
            lineCardBasisTotalMinorUnits: "420000",
            lineBankBasisTotalMinorUnits: "400000",
            lineBankPaymentSavingsMinorUnits: "20000",
          },
        ],
      });
      const card = BigInt(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-card", "line-1")!);
      const bank = BigInt(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-bank", "line-1")!);
      const saving = BigInt(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-saving", "line-1")!);
      expect(card - bank).toBe(saving);
      expect(saving).toBe(20000n);
    });

    it("owner §18: reads an ineligible line's basis totals as given, with no eligibility branch — the server already made them equal", () => {
      const { caratCartPricing } = loadCaratCartPricing(vi.fn());
      const dto = buildDto({
        lines: [
          {
            lineId: "line-1",
            shopifyVariantId: "111",
            quantity: "3",
            purchasable: true,
            bankPaymentDiscountEligible: false,
            unitBankPaymentPriceMinorUnits: "73500",
            unitRegularCardPriceMinorUnits: "73500",
            activeUnitPriceMinorUnits: "73500",
            lineActiveTotalMinorUnits: "220500",
            // priceCartLine sets these equal by construction for an
            // ineligible line (owner §18) — this file trusts that rather
            // than re-deriving it.
            lineCardBasisTotalMinorUnits: "220500",
            lineBankBasisTotalMinorUnits: "220500",
            lineBankPaymentSavingsMinorUnits: "0",
          },
        ],
      });
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-card", "line-1")).toBe("220500");
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-bank", "line-1")).toBe("220500");
      expect(caratCartPricing._internal.selectDisplayMinorUnits(dto, "line-saving", "line-1")).toBe("0");
    });
  });
});

describe("CaratCartPricing._internal.applyDtoToDocument", () => {
  it("writes the resolved figure and clears the pending/error markers", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({
      "data-carat-money": "line-unit",
      "data-carat-line-id": "line-1",
      "data-carat-mode-pending": "true",
    });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.applyDtoToDocument(buildDto());

    expect(node.textContent).toBe("$1,500.00");
    expect(node.getAttribute("data-carat-mode-pending")).toBeNull();
    expect(node.getAttribute("data-carat-mode-error")).toBeNull();
  });

  it("writes the cart-total node from the merchandise total", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total", "data-carat-mode-pending": "true" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.applyDtoToDocument(buildDto());

    expect(node.textContent).toBe("$3,000.00");
    expect(node.getAttribute("data-carat-mode-pending")).toBeNull();
  });

  it("composes '<label>: <amount>' for the live-region node (L2), rather than the bare figure", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({
      "data-carat-money": "cart-total",
      "data-carat-mode-pending": "true",
      "data-carat-live-region-label": "Estimated total",
    });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.applyDtoToDocument(buildDto());

    expect(node.textContent).toBe("Estimated total: $3,000.00");
    expect(node.getAttribute("data-carat-mode-pending")).toBeNull();
  });

  it("writes the owner §3 breakdown nodes (line-card/line-bank/line-saving) alongside the active-mode node", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const cardNode = createFakeMoneyNode({ "data-carat-money": "line-card", "data-carat-line-id": "line-1" });
    const bankNode = createFakeMoneyNode({ "data-carat-money": "line-bank", "data-carat-line-id": "line-1" });
    const savingNode = createFakeMoneyNode({ "data-carat-money": "line-saving", "data-carat-line-id": "line-1" });
    document.querySelectorAll = makeQuerySelectorAll([cardNode, bankNode, savingNode]);

    caratCartPricing._internal.applyDtoToDocument(buildDto());

    expect(cardNode.textContent).toBe("$3,150.00"); // lineCardBasisTotalMinorUnits, quantity-extended
    expect(bankNode.textContent).toBe("$3,000.00"); // lineBankBasisTotalMinorUnits, quantity-extended
    expect(savingNode.textContent).toBe("$150.00"); // lineBankPaymentSavingsMinorUnits — all three reconcile
  });

  it("leaves an unresolved line's node untouched, including its pending marker", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({
      "data-carat-money": "line-unit",
      "data-carat-line-id": "not-in-the-dto",
      "data-carat-mode-pending": "true",
    });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.applyDtoToDocument(buildDto());

    expect(node.textContent).toBe("");
    expect(node.getAttribute("data-carat-mode-pending")).toBe("true");
  });

  it("fails loudly — never falls back to another field — when a recognized kind's line is found but its field is missing (team lead ruling, 2026-09-19)", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({
      "data-carat-money": "line-bank",
      "data-carat-line-id": "line-1",
      "data-carat-mode-pending": "true",
    });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    const dto = buildDto();
    // Simulate an upstream fault: the line resolves, but the field this
    // kind reads is absent from the response entirely (not merely zero).
    delete (dto.lines[0] as { lineBankBasisTotalMinorUnits?: string }).lineBankBasisTotalMinorUnits;

    caratCartPricing._internal.applyDtoToDocument(dto);

    expect(node.getAttribute("data-carat-mode-error")).toBe("true");
    expect(node.getAttribute("data-carat-mode-pending")).toBe("true"); // never cleared
    expect(node.textContent).not.toMatch(/\$/);
    // Must not have silently fallen back to the Card figure for this line.
    expect(node.textContent).not.toBe(
      caratCartPricing._internal.formatMoneyFromMinorUnits(dto.lines[0]!.lineCardBasisTotalMinorUnits as string, "USD")
    );
  });

  it("updates every eligible node across multiple lines independently", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const unitNode = createFakeMoneyNode({ "data-carat-money": "line-unit", "data-carat-line-id": "line-2" });
    const totalNode = createFakeMoneyNode({ "data-carat-money": "line-total", "data-carat-line-id": "line-2" });
    document.querySelectorAll = makeQuerySelectorAll([unitNode, totalNode]);

    const dto = buildDto({
      lines: [
        {
          lineId: "line-2",
          shopifyVariantId: "222",
          quantity: "1",
          purchasable: true,
          bankPaymentDiscountEligible: false,
          unitBankPaymentPriceMinorUnits: "99999",
          unitRegularCardPriceMinorUnits: "99999",
          activeUnitPriceMinorUnits: "99999",
          lineActiveTotalMinorUnits: "99999",
        },
      ],
    });

    caratCartPricing._internal.applyDtoToDocument(dto);

    expect(unitNode.textContent).toBe("$999.99");
    expect(totalNode.textContent).toBe("$999.99");
  });

  describe("loud failure for an unrecognized data-carat-money value (team lead correction, 2026-09-19)", () => {
    it("puts an unrecognized kind into the visible error state rather than leaving it pending forever", () => {
      const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
      const node = createFakeMoneyNode({
        "data-carat-money": "line-eleventh-value-nobody-taught-me",
        "data-carat-line-id": "line-1",
        "data-carat-mode-pending": "true",
      });
      document.querySelectorAll = makeQuerySelectorAll([node]);

      caratCartPricing._internal.applyDtoToDocument(buildDto());

      expect(node.getAttribute("data-carat-mode-error")).toBe("true");
      expect(node.textContent).not.toBe(""); // some visible message, not silence
      expect(node.textContent).not.toMatch(/\$/); // never a price-shaped string
    });

    it("never falls through to another kind's figure for an unrecognized value", () => {
      const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
      // Same line-id as the DTO's real line, so a fall-through-to-line-total
      // bug would produce a plausible-looking (but wrong) price here.
      const node = createFakeMoneyNode({
        "data-carat-money": "line-not-a-real-kind",
        "data-carat-line-id": "line-1",
      });
      document.querySelectorAll = makeQuerySelectorAll([node]);

      caratCartPricing._internal.applyDtoToDocument(buildDto());

      expect(node.textContent).not.toBe("$3,000.00");
      expect(node.textContent).not.toBe("$1,500.00");
      expect(node.getAttribute("data-carat-mode-error")).toBe("true");
    });

    it("logs the unrecognized-kind failure distinctly from a fetch-failure log", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
      const node = createFakeMoneyNode({ "data-carat-money": "not-a-real-kind" });
      document.querySelectorAll = makeQuerySelectorAll([node]);

      caratCartPricing._internal.applyDtoToDocument(buildDto());

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unrecognized data-carat-money value"));
      errorSpy.mockRestore();
    });

    it("still resolves every recognized kind correctly (the error path does not swallow valid nodes)", () => {
      const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
      const validNode = createFakeMoneyNode({ "data-carat-money": "cart-saving" });
      const invalidNode = createFakeMoneyNode({ "data-carat-money": "bogus" });
      document.querySelectorAll = makeQuerySelectorAll([validNode, invalidNode]);

      caratCartPricing._internal.applyDtoToDocument(buildDto());

      expect(validNode.textContent).toBe("$150.00");
      expect(validNode.getAttribute("data-carat-mode-error")).toBeNull();
      expect(invalidNode.getAttribute("data-carat-mode-error")).toBe("true");
    });
  });
});

describe("CaratCartPricing._internal.markPendingNodesAsFailed", () => {
  it("marks a pending node with an error state and a non-price message, keeping it pending", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total", "data-carat-mode-pending": "true" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.markPendingNodesAsFailed();

    expect(node.getAttribute("data-carat-mode-error")).toBe("true");
    expect(node.getAttribute("data-carat-mode-pending")).toBe("true"); // NEVER cleared on failure
    expect(node.textContent).not.toMatch(/\$/); // never a price-shaped string
    expect(node.textContent.length).toBeGreaterThan(0);
  });

  it("does not touch a non-pending node (e.g. an already-correct Card-mode figure)", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    node.textContent = "$42.00";
    document.querySelectorAll = makeQuerySelectorAll([node]);

    caratCartPricing._internal.markPendingNodesAsFailed();

    expect(node.textContent).toBe("$42.00");
    expect(node.getAttribute("data-carat-mode-error")).toBeNull();
  });
});

describe("CaratCartPricing.apply() — end to end against a mocked fetch", () => {
  it("fetches the cart then the proxy, and applies the result, when no cart is supplied", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") {
        return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        return jsonResponse(buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total", "data-carat-mode-pending": "true" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.apply();

    expect(fetchMock).toHaveBeenCalledWith("/cart.js", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/apps/carat/cart", expect.anything());
    expect(node.textContent).toBe("$0.00");
    expect(node.getAttribute("data-carat-mode-pending")).toBeNull();
  });

  it("skips the cart fetch and uses the supplied cart object directly", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") throw new Error("should not fetch the cart when one was supplied");
      if (url === "/apps/carat/cart") return jsonResponse(buildDto());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "line-total", "data-carat-line-id": "line-1" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(node.textContent).toBe("$3,000.00");
  });

  it("sends the mode read from the cart attribute and the built request lines to the proxy", async () => {
    const fetchMock = vi.fn((_url: string, _init?: { body?: string }) => {
      return jsonResponse(buildDto());
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);

    await caratCartPricing.apply({
      cart: {
        attributes: { carat_payment_mode: "bank" },
        items: [{ key: "line-1", variant_id: 111, quantity: 2 }],
      },
    });

    const proxyCall = fetchMock.mock.calls.find((call) => call[0] === "/apps/carat/cart");
    if (!proxyCall || !proxyCall[1]) throw new Error("expected a fetch call to /apps/carat/cart with an init object");
    const body = JSON.parse(proxyCall[1].body ?? "null");
    expect(body).toEqual({
      mode: "bank",
      lines: [{ lineId: "line-1", shopifyVariantId: "111", quantity: 2 }],
    });
  });

  it("on a rejected fetch, marks pending nodes as failed and never reveals a Card figure", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const pendingNode = createFakeMoneyNode({ "data-carat-money": "cart-total", "data-carat-mode-pending": "true" });
    document.querySelectorAll = makeQuerySelectorAll([pendingNode]);

    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(pendingNode.getAttribute("data-carat-mode-error")).toBe("true");
    expect(pendingNode.getAttribute("data-carat-mode-pending")).toBe("true");
    expect(pendingNode.textContent).not.toMatch(/\$/);
  });

  it("on a non-ok proxy response, marks pending nodes as failed rather than applying a partial/garbage result", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/apps/carat/cart") return jsonResponse({ error: "invalid_request" }, false, 400);
      return jsonResponse(buildDto());
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const pendingNode = createFakeMoneyNode({ "data-carat-money": "cart-total", "data-carat-mode-pending": "true" });
    document.querySelectorAll = makeQuerySelectorAll([pendingNode]);

    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(pendingNode.getAttribute("data-carat-mode-error")).toBe("true");
    expect(pendingNode.getAttribute("data-carat-mode-pending")).toBe("true");
  });

  it("discards a stale response when a newer apply() call has already started (out-of-order resolution)", async () => {
    let resolveFirstProxyCall: (value: unknown) => void = () => {};
    const firstProxyResponse = new Promise((resolve) => {
      resolveFirstProxyCall = resolve;
    });

    let callCount = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/apps/carat/cart") {
        callCount += 1;
        if (callCount === 1) {
          // The FIRST apply()'s proxy call — deliberately left unresolved
          // until after the SECOND apply() has already completed, to prove
          // the sequence guard drops it rather than letting it win the race.
          return firstProxyResponse.then(() =>
            jsonResponseSync(buildDto({ activeMerchandiseTotalMinorUnits: "111100" }))
          );
        }
        // The SECOND, newer apply() resolves immediately.
        return jsonResponse(buildDto({ activeMerchandiseTotalMinorUnits: "222200" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    const cart = { attributes: { carat_payment_mode: "bank" }, items: [] };
    const firstApply = caratCartPricing.apply({ cart });
    const secondApply = caratCartPricing.apply({ cart });

    await secondApply;
    expect(node.textContent).toBe("$2,222.00");

    // Now let the stale first call resolve — it must NOT overwrite the newer value.
    resolveFirstProxyCall(undefined);
    await firstApply;
    expect(node.textContent).toBe("$2,222.00");
  });
});

describe("CaratCartPricing — global cartUpdate subscription", () => {
  it("registers a handler for PUB_SUB_EVENTS.cartUpdate at load time", () => {
    const { subscribedHandlers } = loadCaratCartPricing(vi.fn());
    expect(subscribedHandlers.get("cart-update")?.length).toBeGreaterThan(0);
  });

  it("reapplies pricing when a cartUpdate event arrives from a source other than cart-items", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: {}, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { subscribedHandlers } = loadCaratCartPricing(fetchMock);

    const handlers = subscribedHandlers.get("cart-update") ?? [];
    handlers.forEach((handler) => handler({ source: "external-refresh" }));

    // apply() is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith("/cart.js", expect.anything());
  });

  it("does NOT reapply for a cartUpdate event sourced from cart-items (that path applies with its own precise timing)", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not have fetched anything for a cart-items-sourced event");
    });
    const { subscribedHandlers } = loadCaratCartPricing(fetchMock);

    const handlers = subscribedHandlers.get("cart-update") ?? [];
    handlers.forEach((handler) => handler({ source: "cart-items" }));

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Synchronous Response-shaped object, for chaining after a manually-resolved Promise above. */
function jsonResponseSync(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
