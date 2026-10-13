import { describe, expect, it, vi } from "vitest";

import {
  createFakeCartElement,
  createFakeMoneyNode,
  loadCaratCartPricing,
  makeGetElementById,
  makeQuerySelectorAll,
} from "./caratCartPricingSandbox";

/**
 * Stage 2B task 2B-5 — mode switching and Card Checkout interception
 * (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §19/§20;
 * docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md R12/L1-L5), loaded from the
 * REAL `theme/assets/cart.js` via caratCartPricingSandbox.ts.
 *
 * THE PROPERTY EVERY TEST BELOW SERVES: a customer cannot end up seeing one
 * pricing basis while being charged another, through any sequence of
 * switching, adding, changing quantity or reloading. Per the 2B-5 brief,
 * these are written as TRANSITIONS (switch, toggle, refresh, tamper) rather
 * than resting-state assertions — a resting-state test proves almost
 * nothing here, since every real failure this stage exists to catch shows
 * up only after an interaction.
 *
 * The two "Add to Cart" scenarios (already in Bank mode / with Bank Payment
 * Discount from Card mode) live in productFormPaymentMode.test.ts instead —
 * they are product-form.js's responsibility, not cart.js's; see that file.
 */

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

/** Matches proxyResponseDto.ts's shape — see caratCartPricing.test.ts's own copy for field provenance notes. */
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

/** A dto reflecting the CARD-mode active figures for the same underlying line as buildDto(). */
function buildCardDto(overrides: Partial<any> = {}) {
  return buildDto({
    mode: "card",
    lines: [
      {
        ...buildDto().lines[0],
        activeUnitPriceMinorUnits: "157500",
        lineActiveTotalMinorUnits: "315000",
      },
    ],
    activeMerchandiseTotalMinorUnits: "315000",
    ...overrides,
  });
}

/** A raw Section Rendering API HTML fragment, matching what `?sections=` / cart/update.js's `.sections` map carries. */
function sectionHtml(id: string, innerContent: string) {
  return `<div id="shopify-section-${id}" class="shopify-section"><div id="main-cart-footer">${innerContent}</div></div>`;
}

describe("CaratCartPricing.setPaymentMode", () => {
  it("posts carat_payment_mode through /cart/update.js and never requests footer sections when #main-cart-footer is absent", async () => {
    const fetchMock = vi.fn((url: string, _init?: { body?: string }) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);

    await caratCartPricing.setPaymentMode("bank");

    const updateCall = fetchMock.mock.calls.find((call) => call[0] === "/cart/update.js");
    if (!updateCall) throw new Error("expected a fetch call to /cart/update.js");
    const body = JSON.parse((updateCall[1] as { body?: string }).body ?? "null");
    expect(body).toEqual({ attributes: { carat_payment_mode: "bank" } });
  });

  it("CRITERION 43 fence: the request body sent to /cart/update.js never carries a price field — only the mode attribute and (optionally) section ids", async () => {
    const fetchMock = vi.fn((url: string, _init?: { body?: string }) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);

    await caratCartPricing.setPaymentMode("card");

    const updateCall = fetchMock.mock.calls.find((call) => call[0] === "/cart/update.js")!;
    const body = JSON.parse((updateCall[1] as { body?: string }).body ?? "null");
    expect(Object.keys(body).sort()).toEqual(["attributes"]);
    expect(Object.keys(body.attributes)).toEqual(["carat_payment_mode"]);
  });

  it("when #main-cart-footer is present, requests its section id and refreshes its innerHTML from the response (L4 suppression round trip)", async () => {
    const footerEl = createFakeCartElement({ id: "main-cart-footer" }, { id: "cart-footer" });
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        expect(body.sections).toEqual(["cart-footer"]);
        return jsonResponse({
          attributes: { carat_payment_mode: "bank" },
          items: [],
          sections: { "cart-footer": sectionHtml("cart-footer", "<p>refreshed content, no dynamic checkout</p>") },
        });
      }
      if (url === "/apps/carat/cart") return jsonResponse(buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    document.getElementById = makeGetElementById({ "main-cart-footer": footerEl });

    await caratCartPricing.setPaymentMode("bank");

    expect(footerEl.innerHTML).toBe("<p>refreshed content, no dynamic checkout</p>");
  });

  it("L4, Bank direction: the refreshed footer HTML omits the dynamic-checkout markup when the server sends none — the swap is purely a passthrough, never a JS decision", async () => {
    const footerEl = createFakeCartElement({}, { id: "cart-footer" });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart/update.js")
        return jsonResponse({
          attributes: { carat_payment_mode: "bank" },
          items: [],
          sections: { "cart-footer": sectionHtml("cart-footer", "<div class=\"cart__ctas\">no dynamic checkout here</div>") },
        });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    document.getElementById = makeGetElementById({ "main-cart-footer": footerEl });

    await caratCartPricing.setPaymentMode("bank");

    expect(footerEl.innerHTML).not.toContain("additional-checkout-buttons");
  });

  it("L4, Card direction: the refreshed footer HTML carries the dynamic-checkout markup back when the server sends it — restored, not re-added by JS", async () => {
    const footerEl = createFakeCartElement({}, { id: "cart-footer" });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart/update.js")
        return jsonResponse({
          attributes: { carat_payment_mode: "card" },
          items: [],
          sections: {
            "cart-footer": sectionHtml(
              "cart-footer",
              '<div class="cart__ctas"></div><div class="additional-checkout-buttons">shop pay etc</div>'
            ),
          },
        });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" }));
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    document.getElementById = makeGetElementById({ "main-cart-footer": footerEl });

    await caratCartPricing.setPaymentMode("card");

    expect(footerEl.innerHTML).toContain("additional-checkout-buttons");
  });

  it("SERVER-AUTHORITATIVE REPRICING: overwrites a pre-existing (stale/tampered) DOM figure completely — never reads or adjusts it", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    // Simulate a hostile or simply stale DOM value already sitting in the node —
    // e.g. a manually edited figure, or content left over from a previous mode.
    node.textContent = "$999,999.99";
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.setPaymentMode("bank");

    // The DTO's own activeMerchandiseTotalMinorUnits ("300000"), with no trace
    // of the pre-existing value — proves the figure is a fresh write, not a
    // transform of whatever was already there.
    expect(node.textContent).toBe("$3,000.00");
  });

  it("switching TO bank mode resets the Card Checkout confirm gate to its resting state", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card", hidden: "" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel, cardButton]);

    await caratCartPricing.setPaymentMode("bank");

    expect(confirmPanel.getAttribute("hidden")).toBe("");
    expect(cardButton.getAttribute("hidden")).toBeNull();
  });

  it("switching TO card mode does NOT reveal the confirm gate by itself — only handleCardCheckoutSubmit's interception may do that", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel]);

    await caratCartPricing.setPaymentMode("card");

    expect(confirmPanel.getAttribute("hidden")).toBe(""); // unchanged — still hidden
  });
});

describe("CaratCartPricing._internal.hideCardCheckoutConfirm / revealCardCheckoutConfirm", () => {
  it("reveal hides the plain Card Checkout button and shows the confirm panel", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel, cardButton]);

    caratCartPricing._internal.revealCardCheckoutConfirm();

    expect(confirmPanel.getAttribute("hidden")).toBeNull();
    expect(cardButton.getAttribute("hidden")).toBe("");
  });

  it("hide is the exact inverse and never touches `disabled` (would clobber an empty-cart-disabled button)", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card", hidden: "", disabled: "true" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel, cardButton]);

    caratCartPricing._internal.hideCardCheckoutConfirm();

    expect(confirmPanel.getAttribute("hidden")).toBe("");
    expect(cardButton.getAttribute("hidden")).toBeNull();
    expect(cardButton.getAttribute("disabled")).toBe("true"); // untouched
  });

  it("DRAWER CONSISTENCY: acts on every matching node in the document at once — a cart-page panel and a drawer panel reveal together, with no drawer-specific call needed", () => {
    const { caratCartPricing, document } = loadCaratCartPricing(vi.fn());
    const footerConfirm = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const drawerConfirm = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const footerButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const drawerButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    document.querySelectorAll = makeQuerySelectorAll([footerConfirm, drawerConfirm, footerButton, drawerButton]);

    caratCartPricing._internal.revealCardCheckoutConfirm();

    expect(footerConfirm.getAttribute("hidden")).toBeNull();
    expect(drawerConfirm.getAttribute("hidden")).toBeNull();
    expect(footerButton.getAttribute("hidden")).toBe("");
    expect(drawerButton.getAttribute("hidden")).toBe("");
  });
});

describe("CaratCartPricing._internal.handleCardCheckoutSubmit — Card Checkout interception (owner §19)", () => {
  it("ignores a submit whose submitter is not the card-checkout action at all", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should never fetch for an unrelated submit");
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);
    const preventDefault = vi.fn();
    const submitter = createFakeMoneyNode({});
    const form = { requestSubmit: vi.fn() };

    caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores the card-confirm action's own submit — per its Liquid contract it never needs interception", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should never fetch for the confirm action's own submit");
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);
    const preventDefault = vi.fn();
    const submitter = createFakeMoneyNode({ "data-carat-checkout-action": "card-confirm" });
    const form = { requestSubmit: vi.fn() };

    caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Card mode: blocks the first dispatch, then lets the SAME submitter through natively via requestSubmit (bypass-once)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);
    const preventDefault = vi.fn();
    const submitter = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const form = { requestSubmit: vi.fn() };

    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(form.requestSubmit).toHaveBeenCalledWith(submitter);
  });

  it("the bypass consumes exactly once — a second, unrelated submit through the same submitter is intercepted again", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);
    const submitter = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const form = { requestSubmit: vi.fn() };

    // First dispatch: intercepted, then bypassed once via requestSubmit.
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault: () => {} });

    // Simulate the browser's own resulting real submit event from that
    // requestSubmit call — this one must be let through without a second fetch.
    const preventDefault2 = vi.fn();
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault: preventDefault2 });
    expect(preventDefault2).not.toHaveBeenCalled();

    // A THIRD, independent click afterward must be intercepted again (the
    // bypass was one-shot, not a permanent exemption for this submitter).
    fetchMock.mockClear();
    const preventDefault3 = vi.fn();
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault: preventDefault3 });
    expect(preventDefault3).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("Bank mode: blocks the submit, switches the cart to Card, reprices, and reveals the confirm gate", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel, cardButton]);

    const preventDefault = vi.fn();
    const form = { requestSubmit: vi.fn() };
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter: cardButton, target: form, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(form.requestSubmit).not.toHaveBeenCalled(); // never submitted on this click
    expect(confirmPanel.getAttribute("hidden")).toBeNull(); // revealed
    expect(cardButton.getAttribute("hidden")).toBe(""); // original hidden
  });

  it("HAND-OFF (cart-notification, C1, pdp-actions ruling): when NO confirm panel is reachable anywhere on the page, repricing to Card completes and the customer is sent to the full cart instead of a reveal that has nothing to show", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document, routes, window_ } = loadCaratCartPricing(fetchMock);
    // No `[data-carat-card-checkout-confirm]` node anywhere — exactly
    // cart-notification.liquid's DOM contract, which deliberately carries
    // the checkout-action marker with no confirm panel of its own.
    const notificationCardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    document.querySelectorAll = makeQuerySelectorAll([notificationCardButton]);

    const form = { requestSubmit: vi.fn() };
    await caratCartPricing._internal.handleCardCheckoutSubmit({
      submitter: notificationCardButton,
      target: form,
      preventDefault: () => {},
    });

    // The reprice itself still completed — this is not a failure path — and
    // the customer is navigated to the full cart rather than left with a
    // hidden button and nothing to replace it.
    expect(form.requestSubmit).not.toHaveBeenCalled();
    expect(window_.location).toBe(routes.cart_url);
  });

  it("TAMPERED MODE VALUE: an invalid carat_payment_mode on the fetched cart (neither 'card' nor 'bank') is treated as Card — bypasses natively, never reveals the confirm gate", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "hacker-supplied-value" }, items: [] });
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel]);

    const submitter = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const form = { requestSubmit: vi.fn() };
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault: () => {} });

    expect(form.requestSubmit).toHaveBeenCalledWith(submitter);
    expect(confirmPanel.getAttribute("hidden")).toBe(""); // never revealed
  });

  it("fails closed on a fetch failure: no submit is allowed through, the confirm gate is never revealed, and a visible error is surfaced", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel]);
    const errorsEl = createFakeMoneyNode({});
    document.getElementById = makeGetElementById({ "cart-errors": errorsEl });

    const submitter = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const form = { requestSubmit: vi.fn() };
    await caratCartPricing._internal.handleCardCheckoutSubmit({ submitter, target: form, preventDefault: () => {} });

    expect(form.requestSubmit).not.toHaveBeenCalled();
    expect(confirmPanel.getAttribute("hidden")).toBe("");
    expect(errorsEl.textContent.length).toBeGreaterThan(0);
  });
});

describe("Repeated toggling and cross-transition consistency (owner §19 money-critical list)", () => {
  function makeToggleFetch() {
    return vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
  }

  it("Card -> Bank: the cart-total node reflects the Bank figure after switching", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.setPaymentMode("bank");

    expect(node.textContent).toBe("$3,000.00");
  });

  it("Bank -> Card: the SAME node reflects the Card figure after switching back", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.setPaymentMode("bank");
    await caratCartPricing.setPaymentMode("card");

    expect(node.textContent).toBe("$3,150.00");
  });

  it("NO COMPOUNDING: the figure after 5 alternating toggles ending on Bank equals the figure after a single switch to Bank", async () => {
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });

    const { caratCartPricing: single, document: singleDoc } = loadCaratCartPricing(makeToggleFetch());
    singleDoc.querySelectorAll = makeQuerySelectorAll([node]);
    await single.setPaymentMode("bank");
    const singleToggleResult = node.textContent;

    const { caratCartPricing: repeated, document: repeatedDoc } = loadCaratCartPricing(makeToggleFetch());
    const node2 = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    repeatedDoc.querySelectorAll = makeQuerySelectorAll([node2]);
    for (const mode of ["bank", "card", "bank", "card", "bank"] as const) {
      await repeated.setPaymentMode(mode);
    }

    expect(node2.textContent).toBe(singleToggleResult);
    expect(node2.textContent).toBe("$3,000.00");
  });

  it("MIXED ELIGIBLE/INELIGIBLE: switching mode reprices an eligible line to Bank while an ineligible line stays at its (equal) Card/Bank basis", async () => {
    const dtoWithMixedLines = (mode: string) =>
      buildDto({
        mode,
        lines: [
          {
            lineId: "eligible-line",
            shopifyVariantId: "111",
            quantity: "1",
            purchasable: true,
            bankPaymentDiscountEligible: true,
            unitBankPaymentPriceMinorUnits: "8000",
            unitRegularCardPriceMinorUnits: "8400",
            activeUnitPriceMinorUnits: mode === "bank" ? "8000" : "8400",
            lineActiveTotalMinorUnits: mode === "bank" ? "8000" : "8400",
            lineCardBasisTotalMinorUnits: "8400",
            lineBankBasisTotalMinorUnits: "8000",
            lineBankPaymentSavingsMinorUnits: "400",
          },
          {
            lineId: "ineligible-line",
            shopifyVariantId: "222",
            quantity: "1",
            purchasable: true,
            bankPaymentDiscountEligible: false,
            unitBankPaymentPriceMinorUnits: "5000",
            unitRegularCardPriceMinorUnits: "5000",
            activeUnitPriceMinorUnits: "5000",
            lineActiveTotalMinorUnits: "5000",
            lineCardBasisTotalMinorUnits: "5000",
            lineBankBasisTotalMinorUnits: "5000",
            lineBankPaymentSavingsMinorUnits: "0",
          },
        ],
      });

    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(dtoWithMixedLines(body.mode));
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const eligibleUnit = createFakeMoneyNode({ "data-carat-money": "line-unit", "data-carat-line-id": "eligible-line" });
    const ineligibleUnit = createFakeMoneyNode({ "data-carat-money": "line-unit", "data-carat-line-id": "ineligible-line" });
    document.querySelectorAll = makeQuerySelectorAll([eligibleUnit, ineligibleUnit]);

    await caratCartPricing.setPaymentMode("bank");

    expect(eligibleUnit.textContent).toBe("$80.00"); // moved to Bank price
    expect(ineligibleUnit.textContent).toBe("$50.00"); // unchanged — same in both bases
  });

  it("QUANTITY UPDATE after a mode switch: a later apply() for an unrelated quantity change still reads the ALREADY-set mode fresh, without re-calling setPaymentMode", async () => {
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        // Keyed off the REQUESTED quantity (not just mode), so this mock can
        // tell the initial (empty-cart) setPaymentMode call apart from the
        // later quantity-3 apply() call — both request mode "bank".
        const requestedQuantity = body.lines?.[0]?.quantity;
        if (body.mode !== "bank") throw new Error("this test never switches back to card");
        return jsonResponse(
          requestedQuantity === 3
            ? buildDto({ activeMerchandiseTotalMinorUnits: "450000" })
            : buildDto({ lines: [], activeMerchandiseTotalMinorUnits: "0" })
        );
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    await caratCartPricing.setPaymentMode("bank");
    expect(node.textContent).toBe("$0.00"); // empty cart at the moment of the switch

    // Simulate a quantity change elsewhere in the theme calling apply() with
    // the cart AS IT NOW STANDS (still carat_payment_mode: bank, never
    // re-supplied by this test) — proving mode persistence does not depend
    // on remembering a client-side variable across the two calls.
    await caratCartPricing.apply({
      cart: { attributes: { carat_payment_mode: "bank" }, items: [{ key: "line-1", variant_id: 111, quantity: 3 }] },
    });

    expect(node.textContent).toBe("$4,500.00");
  });

  it("VARIANT/CONFIGURATION CHANGE after a mode switch: a new line added to an already-Bank-mode cart is priced in Bank mode without a fresh setPaymentMode call", async () => {
    const fetchMock = vi.fn((url: string, _init?: { body?: string }) => {
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") {
        return jsonResponse(
          buildDto({
            lines: [
              buildDto().lines[0],
              {
                lineId: "line-2-different-variant",
                shopifyVariantId: "999",
                quantity: "1",
                purchasable: true,
                bankPaymentDiscountEligible: true,
                unitBankPaymentPriceMinorUnits: "20000",
                unitRegularCardPriceMinorUnits: "21000",
                activeUnitPriceMinorUnits: "20000",
                lineActiveTotalMinorUnits: "20000",
                lineCardBasisTotalMinorUnits: "21000",
                lineBankBasisTotalMinorUnits: "20000",
                lineBankPaymentSavingsMinorUnits: "1000",
              },
            ],
          })
        );
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const newLineNode = createFakeMoneyNode({ "data-carat-money": "line-unit", "data-carat-line-id": "line-2-different-variant" });
    document.querySelectorAll = makeQuerySelectorAll([newLineNode]);

    await caratCartPricing.setPaymentMode("bank");
    await caratCartPricing.apply({
      cart: {
        attributes: { carat_payment_mode: "bank" },
        items: [
          { key: "line-1", variant_id: 111, quantity: 2 },
          { key: "line-2-different-variant", variant_id: 999, quantity: 1 },
        ],
      },
    });

    expect(newLineNode.textContent).toBe("$200.00");
  });

  it("LIVE-REGION ANNOUNCEMENT carries the applied total after a mode switch, composed as '<label>: <amount>'", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const liveRegionNode = createFakeMoneyNode({
      "data-carat-money": "cart-total",
      "data-carat-live-region-label": "Estimated total",
    });
    document.querySelectorAll = makeQuerySelectorAll([liveRegionNode]);

    await caratCartPricing.setPaymentMode("bank");

    expect(liveRegionNode.textContent).toBe("Estimated total: $3,000.00");
  });

  it("RELOAD PERSISTENCE: apply() on a freshly-loaded page (no client-side transition this session) reflects whatever mode the cart attribute already carries", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const node = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([node]);

    // No setPaymentMode() call anywhere in this test — apply() alone, as
    // CartItems#connectedCallback calls it on every mount/reload.
    await caratCartPricing.apply();

    expect(node.textContent).toBe("$3,000.00");
  });
});

describe("CaratCartPricing — Card -> Bank one-click switch control (owner ruling 2026-09-19, cardToBankSwitch.test.ts)", () => {
  function makeToggleFetch() {
    return vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
  }

  it("clicking the switch-to-bank control switches mode, reprices, and hides itself (redundant in Bank mode)", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const wrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "" });
    const button = createFakeMoneyNode({ "data-carat-payment-mode-action": "bank" });
    const cartTotal = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    document.querySelectorAll = makeQuerySelectorAll([wrapper, button, cartTotal]);

    await caratCartPricing._internal.handleSwitchToBankClick({ target: button });

    expect(wrapper.getAttribute("hidden")).toBe("");
    expect(cartTotal.textContent).toBe("$3,000.00");
  });

  it("ignores a click on an unrelated element", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should never fetch for an unrelated click target");
    });
    const { caratCartPricing } = loadCaratCartPricing(fetchMock);
    const unrelated = createFakeMoneyNode({});

    await caratCartPricing._internal.handleSwitchToBankClick({ target: unrelated });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("NO CONFIRMATION: unlike Bank -> Card, a single click completes the switch with no gate and no second action required", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const button = createFakeMoneyNode({ "data-carat-payment-mode-action": "bank" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel, button]);

    await caratCartPricing._internal.handleSwitchToBankClick({ target: button });

    // The Bank -> Card confirm panel is an entirely separate control and
    // must stay untouched by the (confirmation-free) Card -> Bank switch.
    expect(confirmPanel.getAttribute("hidden")).toBe("");
  });

  it("switching back to Card (e.g. via the Bank Checkout interception) reveals the switch-to-bank control again — it is no longer redundant", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/cart/update.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const wrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "", hidden: "" });
    const cardConfirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    document.querySelectorAll = makeQuerySelectorAll([wrapper, cardConfirmPanel, cardButton]);

    // The Bank -> Card interception path (a DIFFERENT control) is what
    // exercises this in production — proving the two controls stay in sync
    // through it, not just through their own dedicated switch.
    await caratCartPricing._internal.handleCardCheckoutSubmit({
      submitter: cardButton,
      target: { requestSubmit: vi.fn() },
      preventDefault: () => {},
    });

    expect(wrapper.getAttribute("hidden")).toBeNull();
    expect(cardConfirmPanel.getAttribute("hidden")).toBeNull(); // the OTHER control's own reveal, unaffected
  });

  it("a failed switch surfaces a visible error and leaves the control's resting state untouched", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const wrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "" });
    const button = createFakeMoneyNode({ "data-carat-payment-mode-action": "bank" });
    const errorsEl = createFakeMoneyNode({});
    document.querySelectorAll = makeQuerySelectorAll([wrapper, button]);
    document.getElementById = makeGetElementById({ "cart-errors": errorsEl });

    await caratCartPricing._internal.handleSwitchToBankClick({ target: button });

    expect(wrapper.getAttribute("hidden")).toBeNull(); // never hidden — the switch never completed
    expect(errorsEl.textContent.length).toBeGreaterThan(0);
  });

  it("ADVERSARIAL (owner §19, team-lead ruling): clicking Card -> Bank while the Bank -> Card confirm panel is open makes the pending card-checkout submit UNREACHABLE, not merely visually hidden behind a class", async () => {
    // The exact sequence a customer could stumble into: open the confirm
    // panel from Bank mode (mode is now genuinely Card), change their mind,
    // and switch straight back to Bank. If the confirm panel's own submit
    // button were still actionable at that point, the customer could
    // complete a card checkout while every visible figure shows Bank
    // pricing — precisely the hole owner §19 exists to close.
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const wrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "", hidden: "" });
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const switchToBankButton = createFakeMoneyNode({ "data-carat-payment-mode-action": "bank" });
    document.querySelectorAll = makeQuerySelectorAll([wrapper, confirmPanel, cardButton, switchToBankButton]);

    // 1. Bank -> Card interception: confirm panel opens.
    await caratCartPricing._internal.handleCardCheckoutSubmit({
      submitter: cardButton,
      target: { requestSubmit: vi.fn() },
      preventDefault: () => {},
    });
    expect(confirmPanel.getAttribute("hidden")).toBeNull(); // panel is open
    expect(wrapper.getAttribute("hidden")).toBeNull(); // revealed together, per team-lead ruling

    // 2. Customer changes their mind: Card -> Bank.
    await caratCartPricing._internal.handleSwitchToBankClick({ target: switchToBankButton });

    // The confirm panel — and by HTML semantics, EVERY submit control
    // nested inside it — is `hidden`, which removes the whole subtree from
    // rendering, the tab order and the click surface. That is what makes
    // this "unreachable", not a CSS class a determined script could
    // override: a `hidden` ancestor cannot be clicked or focused through
    // ordinary user interaction, unlike `display:none` applied via a
    // toggleable class name.
    expect(confirmPanel.getAttribute("hidden")).toBe("");
    // The escape hatch and the primary path are both restored to their
    // normal Bank-mode resting state.
    expect(wrapper.getAttribute("hidden")).toBe(""); // redundant again in Bank mode
    expect(cardButton.getAttribute("hidden")).toBeNull(); // primary Card Checkout button restored
  });

  it("ROUND TRIP (the compounding test in its most realistic form, team-lead ruling): Bank -> Card confirm opened -> Card -> Bank -> lands on the exact figures as never having started", async () => {
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "bank" }, items: [] });
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const cartTotal = createFakeMoneyNode({ "data-carat-money": "cart-total" });
    const cardButton = createFakeMoneyNode({ "data-carat-checkout-action": "card" });
    const switchToBankButton = createFakeMoneyNode({ "data-carat-payment-mode-action": "bank" });
    document.querySelectorAll = makeQuerySelectorAll([cartTotal, cardButton, switchToBankButton]);

    // Baseline: never having started (fresh page load in Bank mode).
    await caratCartPricing.apply();
    const baselineFigure = cartTotal.textContent;
    expect(baselineFigure).toBe("$3,000.00");

    // Bank -> Card (confirm opens) -> Card -> Bank.
    await caratCartPricing._internal.handleCardCheckoutSubmit({
      submitter: cardButton,
      target: { requestSubmit: vi.fn() },
      preventDefault: () => {},
    });
    expect(cartTotal.textContent).toBe("$3,150.00"); // genuinely Card-priced mid-trip, not skipped
    await caratCartPricing._internal.handleSwitchToBankClick({ target: switchToBankButton });

    expect(cartTotal.textContent).toBe(baselineFigure);
  });
});

describe("apply() self-corrects the switch-to-bank control after a STALE full drawer/notification replacement", () => {
  it("REGRESSION: product-form.js's Bank-flavored add calls setPaymentMode('bank') BEFORE CartDrawer#renderContents() swaps in stale (pre-switch) markup — apply() must still leave the control hidden", async () => {
    // Simulates exactly the race product-form.js's own ordering creates:
    // setPaymentMode('bank') persists the mode and reprices first, THEN
    // (in the real file) CartDrawer#renderContents() replaces #CartDrawer's
    // entire innerHTML from the /cart/add.js response — whose `sections`
    // were rendered by Shopify at add-to-cart time, when the cart was still
    // Card mode. That stale replacement re-inserts a VISIBLE switch-to-bank
    // wrapper (Liquid's own snapshot from before the switch). This test
    // reproduces that exact sequence directly against the wrapper node.
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const wrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "" });
    document.querySelectorAll = makeQuerySelectorAll([wrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(wrapper.getAttribute("hidden")).toBe(""); // correctly hidden immediately after the switch

    // The stale drawer swap happens here in production, re-inserting a
    // VISIBLE wrapper node (Liquid rendered it before the switch) — modeled
    // here by resetting the SAME node back to visible, exactly as a fresh
    // innerHTML assignment from stale markup would.
    wrapper.removeAttribute("hidden");
    expect(wrapper.getAttribute("hidden")).toBeNull(); // the bug this test catches, reproduced

    // CartDrawer#renderContents() calls apply() unconditionally after every
    // swap (2B-4, unchanged) — this is that call, using the mode as it
    // stands right now (still "bank", since setPaymentMode already
    // persisted it — no second setPaymentMode call here).
    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(wrapper.getAttribute("hidden")).toBe(""); // self-corrected, no call site had to remember to do this
  });

  it("does NOT drive the Card Checkout confirm panel the same way — an ordinary Card-mode apply() must never reveal it on its own", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/cart.js") return jsonResponse({ attributes: { carat_payment_mode: "card" }, items: [] });
      if (url === "/apps/carat/cart") return jsonResponse(buildCardDto());
      throw new Error("unexpected fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(fetchMock);
    const confirmPanel = createFakeMoneyNode({ "data-carat-card-checkout-confirm": "", hidden: "" });
    document.querySelectorAll = makeQuerySelectorAll([confirmPanel]);

    // No interception, no setPaymentMode — an ordinary Card-mode customer's
    // page load/quantity-change/reload calling apply() alone.
    await caratCartPricing.apply();

    expect(confirmPanel.getAttribute("hidden")).toBe(""); // still hidden — never shown uninvited
  });
});

describe("F1 (PDP) + F2 (cart footer) dynamic-checkout wrapper — unified under ONE selector (team-lead ruling, 2026-09-19) — data-carat-dynamic-checkout-wrapper", () => {
  function makeToggleFetch() {
    return vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] });
      }
      if (url === "/apps/carat/cart") {
        const body = JSON.parse(init?.body ?? "{}");
        return jsonResponse(body.mode === "bank" ? buildDto() : buildCardDto());
      }
      throw new Error("unexpected fetch: " + url);
    });
  }

  it("shares the exact same hide/show rule as the switch-to-bank control — grouped under one dispatcher, not a bespoke pair", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const switchToBankWrapper = createFakeMoneyNode({ "data-carat-payment-mode-action-wrapper": "" });
    const dynamicCheckoutWrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" });
    document.querySelectorAll = makeQuerySelectorAll([switchToBankWrapper, dynamicCheckoutWrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(switchToBankWrapper.getAttribute("hidden")).toBe("");
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");

    await caratCartPricing.setPaymentMode("card");
    expect(switchToBankWrapper.getAttribute("hidden")).toBeNull();
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBeNull();
  });

  it("F1 AND F2 CANNOT DRIFT APART: both surfaces carry the identical attribute, so one query and one dispatch decision covers both — there is no per-surface logic that could diverge", async () => {
    // main-cart-footer.liquid (F2) and buy-buttons.liquid (F1) render this
    // wrapper independently, on different pages, for different Shopify
    // objects (content_for_additional_checkout_buttons vs. form |
    // payment_button) — but from cart.js's side there is exactly ONE
    // selector and ONE dispatcher (syncModeRedundantControls), with no
    // knowledge of which file rendered which node. This test proves that by
    // registering two nodes that could exist SIMULTANEOUSLY (a customer on
    // the cart page, where F2 lives, with the drawer's own copy of F1-style
    // markup never applicable here — but nothing stops a future page from
    // legitimately carrying both) and asserting they move together on every
    // transition, not just the common case of exactly one being present.
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const f1Wrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" }); // buy-buttons.liquid
    const f2Wrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" }); // main-cart-footer.liquid
    document.querySelectorAll = makeQuerySelectorAll([f1Wrapper, f2Wrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(f1Wrapper.getAttribute("hidden")).toBe("");
    expect(f2Wrapper.getAttribute("hidden")).toBe("");

    await caratCartPricing.setPaymentMode("card");
    expect(f1Wrapper.getAttribute("hidden")).toBeNull();
    expect(f2Wrapper.getAttribute("hidden")).toBeNull();
  });

  it("F2's own resync-race window (team-lead's stated reason for unifying): a stale main-cart-footer swap that re-inserts a visible wrapper self-corrects on the next apply(), exactly like F1's stale-add case", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const f2Wrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" });
    document.querySelectorAll = makeQuerySelectorAll([f2Wrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(f2Wrapper.getAttribute("hidden")).toBe("");

    // Simulates exactly the race the team lead named: a footer section
    // re-render that lost the race against the mode switch, re-inserting a
    // visible (stale Card-basis) wrapper.
    f2Wrapper.removeAttribute("hidden");

    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(f2Wrapper.getAttribute("hidden")).toBe("");
  });

  it("THE FIX: 'Add to Cart with Bank Payment Discount' hides the F1 button on the SAME page immediately — no PDP re-render, no reload", async () => {
    // The exact scenario team-lead pushed back on: a PDP has no cart-section
    // re-render the way the cart page does, so a customer who has just
    // expressed the clearest possible Bank intent must not still see an
    // accelerated-checkout button that bypasses the cart (and its mode)
    // entirely. product-form.js calls setPaymentMode('bank') for this exact
    // add-to-cart action — this test proves that alone is sufficient.
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const dynamicCheckoutWrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" }); // starts visible (Card default)
    document.querySelectorAll = makeQuerySelectorAll([dynamicCheckoutWrapper]);

    await caratCartPricing.setPaymentMode("bank");

    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");
  });

  it("REGRESSION (mirrors the switch-to-bank staleness fix): self-corrects after a stale swap re-inserts a visible wrapper, with no dedicated call site", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const dynamicCheckoutWrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" });
    document.querySelectorAll = makeQuerySelectorAll([dynamicCheckoutWrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");

    // A stale re-render (or, on a PDP, a variant/section refresh this task
    // does not own) re-inserts a visible wrapper.
    dynamicCheckoutWrapper.removeAttribute("hidden");
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBeNull();

    // Any later apply() — triggered by anything, not a dedicated call —
    // self-corrects it purely from the DTO's own mode.
    await caratCartPricing.apply({ cart: { attributes: { carat_payment_mode: "bank" }, items: [] } });

    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");
  });

  it("restored the moment the cart reads back as Card mode, including via the Card -> Bank round trip", async () => {
    const { caratCartPricing, document } = loadCaratCartPricing(makeToggleFetch());
    const dynamicCheckoutWrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" });
    document.querySelectorAll = makeQuerySelectorAll([dynamicCheckoutWrapper]);

    await caratCartPricing.setPaymentMode("bank");
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");

    await caratCartPricing.setPaymentMode("card");
    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBeNull();
  });
});
