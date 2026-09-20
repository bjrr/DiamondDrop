import { describe, expect, it, vi } from "vitest";

import { createFakeMoneyNode, loadCaratCartPricing, makeQuerySelectorAll } from "./caratCartPricingSandbox";
import { createFakeProductFormThis, createFakeSubmitter, loadProductForm } from "./productFormPaymentModeSandbox";

/**
 * Stage 2B task 2B-5 — the two owner §20 add-to-cart actions
 * (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §20), loaded from the REAL
 * `theme/assets/product-form.js` via productFormPaymentModeSandbox.ts — see
 * that file's header for why a hand-called prototype method rather than a
 * real custom element instantiation.
 *
 * SCOPE: only the mode-switch wiring 2B-5 added — which submitter triggers
 * `window.CaratCartPricing.setPaymentMode('bank')`, and in what order
 * relative to the drawer/notification render. Dawn's pre-existing
 * add-to-cart mechanics (error handling, sold-out messaging, quick-add-modal
 * timing) are unchanged by this task and are not re-tested here.
 */

function jsonResponse(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) });
}

/** Flushes as many microtask turns as the fetch().then() chain under test needs. */
async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function fakeCart(renderContents: (response: unknown) => void) {
  return {
    getSectionsToRender: () => [],
    setActiveElement: () => {},
    renderContents,
    classList: { contains: () => false, remove: () => {}, add: () => {} },
  };
}

describe("product-form.js — owner §20 add-to-cart actions", () => {
  it("'Add to Cart with Bank Payment Discount' (bank flavor) switches the cart to Bank mode before rendering the drawer/notification", async () => {
    const callOrder: string[] = [];
    const setPaymentMode = vi.fn((mode: string) => {
      callOrder.push("setPaymentMode:" + mode);
      return Promise.resolve({ attributes: { carat_payment_mode: mode } });
    });
    const fetchImpl = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    const { ProductForm } = loadProductForm(setPaymentMode, fetchImpl);

    const renderContents = vi.fn(() => callOrder.push("renderContents"));
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });

    const submitter = createFakeSubmitter("bank");
    ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter });
    await flushMicrotasks();

    expect(setPaymentMode).toHaveBeenCalledWith("bank");
    expect(callOrder).toEqual(["setPaymentMode:bank", "renderContents"]);
  });

  it("plain 'Add to Cart' (default flavor) never calls setPaymentMode — the cart's existing mode (Bank or Card) is preserved by inaction", async () => {
    const setPaymentMode = vi.fn(() => Promise.resolve({}));
    const fetchImpl = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    const { ProductForm } = loadProductForm(setPaymentMode, fetchImpl);

    const renderContents = vi.fn();
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });

    const submitter = createFakeSubmitter("default");
    ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter });
    await flushMicrotasks();

    expect(setPaymentMode).not.toHaveBeenCalled();
    expect(renderContents).toHaveBeenCalled();
  });

  it("a submitter with no data-carat-add-to-cart attribute at all (e.g. a future/unrelated submit button) behaves like 'default' — never calls setPaymentMode", async () => {
    const setPaymentMode = vi.fn(() => Promise.resolve({}));
    const fetchImpl = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    const { ProductForm } = loadProductForm(setPaymentMode, fetchImpl);

    const renderContents = vi.fn();
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });
    const submitter = createFakeSubmitter(null);
    ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter });
    await flushMicrotasks();

    expect(setPaymentMode).not.toHaveBeenCalled();
  });

  it("a failed setPaymentMode never blocks the add-to-cart flow that already succeeded (fails open to whatever mode the cart already had)", async () => {
    const setPaymentMode = vi.fn(() => Promise.reject(new Error("network down")));
    const fetchImpl = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    const { ProductForm } = loadProductForm(setPaymentMode, fetchImpl);

    const renderContents = vi.fn();
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const submitter = createFakeSubmitter("bank");
    ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter });
    await flushMicrotasks();

    expect(renderContents).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("gracefully no-ops (never throws) when window.CaratCartPricing is not loaded on the page at all — a real gap on some cart_type settings, not a hypothetical", async () => {
    const fetchImpl = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    // `undefined` here means CaratCartPricing genuinely does not exist on
    // window in this sandbox — see loadProductForm's own doc comment.
    const { ProductForm } = loadProductForm(undefined, fetchImpl);

    const renderContents = vi.fn();
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });
    const submitter = createFakeSubmitter("bank");

    expect(() =>
      ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter })
    ).not.toThrow();
    await flushMicrotasks();

    expect(renderContents).toHaveBeenCalled();
  });

  it("END TO END (team-lead ruling, gap 2): a Bank-flavoured add on a PDP hides the F1 accelerated-checkout element on that SAME page, with no reload — wires the REAL cart.js engine in, not a setPaymentMode mock", async () => {
    // The other tests in this file mock setPaymentMode entirely, which
    // proves product-form.js CALLS it correctly but nothing about what it
    // actually does to the page — exactly the gap the team lead flagged: "a
    // test that only checks the next render would pass while the hole stays
    // open." This test instead loads the REAL theme/assets/cart.js engine
    // and hands product-form.js ITS real setPaymentMode, so the assertion is
    // against the actual DOM-hiding side effect (hideModeRedundantControls,
    // driven by the DTO's own mode), not a mock's call record.
    //
    // The two loaders run in separate vm contexts with their own `document`/
    // `fetch`, but `caratCartPricing.setPaymentMode` is a closure over ITS
    // OWN context's stubs regardless of who calls it — so calling it from
    // inside product-form.js's sandbox still correctly operates on the
    // fake dynamic-checkout-wrapper node registered below.
    const cartFetchMock = vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/cart/update.js") {
        const body = JSON.parse(init?.body ?? "{}");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ attributes: { carat_payment_mode: body.attributes.carat_payment_mode }, items: [] }),
        });
      }
      if (url === "/apps/carat/cart") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              mode: "bank",
              currency: "USD",
              lines: [],
              cardMerchandiseTotalMinorUnits: "0",
              bankMerchandiseTotalMinorUnits: "0",
              bankPaymentSavingsMinorUnits: "0",
              activeMerchandiseTotalMinorUnits: "0",
            }),
        });
      }
      throw new Error("unexpected cart.js fetch: " + url);
    });
    const { caratCartPricing, document } = loadCaratCartPricing(cartFetchMock);
    const dynamicCheckoutWrapper = createFakeMoneyNode({ "data-carat-dynamic-checkout-wrapper": "" }); // starts visible, Card default
    document.querySelectorAll = makeQuerySelectorAll([dynamicCheckoutWrapper]);

    const addToCartFetch = vi.fn(() => jsonResponse({ id: 111, quantity: 1 }));
    const { ProductForm } = loadProductForm(caratCartPricing.setPaymentMode, addToCartFetch);
    const renderContents = vi.fn();
    const fakeThis = createFakeProductFormThis(ProductForm.prototype, { cart: fakeCart(renderContents) });
    const submitter = createFakeSubmitter("bank");

    ProductForm.prototype.onSubmitHandler.call(fakeThis, { preventDefault: () => {}, submitter });
    // FLAKINESS FIX (pdp-actions report, 2026-09-19): this chain is roughly
    // twice as deep as the mocked-setPaymentMode tests above (real cart.js
    // adds its own /cart/update.js -> apply() -> /apps/carat/cart round trip
    // in between). The original version of this test used a real
    // `setTimeout(resolve, 0)` macrotask flush, which reportedly flaked once
    // under the full app/theme suite (never in isolation, and not
    // reproduced on immediate rerun). Checked for the most likely culprit —
    // a stray `vi.useFakeTimers()` from a sibling file leaking into this
    // worker — and found none anywhere in the codebase (`grep -rln
    // useFakeTimers app/` matches only this comment), so that specific
    // theory is ruled out rather than confirmed. The underlying risk is
    // real regardless of the exact cause, though: a genuine macrotask
    // (`setTimeout`) can be delayed relative to microtasks under CPU
    // contention from many concurrent test files/workers in a way a pure
    // microtask drain cannot. flushMicrotasks below drains pending
    // `.then()` callbacks by directly `await`ing `Promise.resolve()` in a
    // loop — no timer of any kind, so it is not subject to macrotask
    // scheduling variance at all. The count is generous (20) for the depth
    // of this specific cross-sandbox chain, not tuned to the exact minimum.
    await flushMicrotasks(20);

    expect(dynamicCheckoutWrapper.getAttribute("hidden")).toBe("");
    expect(renderContents).toHaveBeenCalled(); // the add-to-cart flow itself still completed
  });
});
