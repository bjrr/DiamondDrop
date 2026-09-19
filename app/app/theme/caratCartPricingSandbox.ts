import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/cart.js` — not a mirror of it — into a
 * minimal Node `vm` sandbox and returns the `window.CaratCartPricing` module
 * it defines, so Stage 2B task 2B-4's pure logic can be unit tested without
 * duplicating it (the same reasoning R9/R10 record elsewhere in this spec
 * for why duplicated money logic is a hazard, not a convenience).
 *
 * WHY A HAND-ROLLED SANDBOX RATHER THAN jsdom. This repo has no DOM test
 * environment configured (vitest.config.ts uses `environment: "node"`, and
 * no `jsdom` dependency exists) — see docs/specs/SLICE-2B-CART-SURFACE-
 * INVENTORY.md's implementation notes. Adding one is an architecture-level
 * dependency decision this task does not own. `theme/assets/cart.js` is
 * also not an ES module (it is a plain classic script loaded via
 * `<script src>` — see theme/sections/main-cart-items.liquid and
 * theme/snippets/cart-drawer.liquid) and must stay that way in production,
 * so it cannot be `import`ed directly either. `vm.runInContext` is the one
 * approach that runs the actual shipped file, unmodified, against a
 * purpose-built minimal global environment.
 *
 * WHAT IS STUBBED, AND WHY IT IS SAFE TO STUB. `cart.js` declares several
 * custom-element classes (CartRemoveButton, CartItems, CartNote) at its top
 * level. Class DECLARATIONS execute their `extends` expression immediately,
 * but no constructor or method body runs until something actually
 * instantiates one — this harness never does. So the stubs below only need
 * to be real enough to let the file PARSE AND EXECUTE top-to-bottom (defining
 * `window.CaratCartPricing`, declaring the classes, registering them with
 * `customElements.define`) without throwing; they do not need to behave like
 * a real DOM, because nothing here exercises DOM-dependent method bodies.
 * `document.querySelectorAll` is the one exception — `CaratCartPricing`
 * itself calls it, so tests that exercise `apply()`/`_internal.applyDtoTo
 * Document`/`_internal.markPendingNodesAsFailed` replace it with a fake
 * per-test via `sandbox.document.querySelectorAll = ...`.
 */

const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

export interface FakeMoneyNode {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  textContent: string;
}

/** A money-surface DOM node stand-in, carrying only what CaratCartPricing reads/writes. */
export function createFakeMoneyNode(initialAttributes: Record<string, string>): FakeMoneyNode {
  const attributes: Record<string, string> = { ...initialAttributes };
  let text = "";
  return {
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
    },
  } as FakeMoneyNode;
}

/**
 * A tiny stand-in for `document.querySelectorAll` covering exactly the two
 * selector shapes CaratCartPricing uses: `[data-carat-money]` and
 * `[data-carat-money][data-carat-mode-pending]`. Not a general CSS engine —
 * scoped deliberately to what the real module queries for.
 */
export function makeQuerySelectorAll(nodes: readonly FakeMoneyNode[]) {
  return (selector: string): FakeMoneyNode[] => {
    return nodes.filter((node) => {
      if (selector.includes("[data-carat-money]") && node.getAttribute("data-carat-money") == null) return false;
      if (
        selector.includes("[data-carat-mode-pending]") &&
        node.getAttribute("data-carat-mode-pending") == null
      ) {
        return false;
      }
      return true;
    });
  };
}

/**
 * Loose on purpose: test call sites pass `vi.fn((url: string, init?: ...) => ...)`
 * implementations, whose inferred Mock type does not structurally satisfy a
 * stricter `(...args: unknown[]) => Promise<unknown>` signature (TS rejects
 * narrowing a rest-`unknown[]` parameter to a concrete `string` parameter).
 * This is a test-harness boundary, not production code, so `any` here is
 * the pragmatic choice over fighting variance for no safety benefit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FetchImpl = (...args: any[]) => Promise<any>;

/** The shape of `window.CaratCartPricing` as cart.js defines it — see that file for the real implementation. */
export interface CaratCartPricingModule {
  apply(options?: { cart?: unknown }): Promise<void>;
  _internal: {
    formatMoneyFromMinorUnits(minorUnitsString: string, currency: string): string | null;
    readModeFromCart(cart: unknown): "bank" | "card";
    buildRequestLines(
      cart: unknown
    ): Array<{ lineId: string; shopifyVariantId: string; quantity: number }>;
    selectDisplayMinorUnits(dto: unknown, kind: string, lineId: string | null): string | null;
    applyDtoToDocument(dto: unknown): void;
    markPendingNodesAsFailed(): void;
  };
}

interface WindowStub {
  StandardEvents: { createViewEventElement(base: unknown): unknown };
  self?: WindowStub;
  CaratCartPricing?: CaratCartPricingModule;
}

export interface CartPricingSandbox {
  /** The window.CaratCartPricing module cart.js defines. */
  caratCartPricing: CaratCartPricingModule;
  /** The sandboxed `document` — reassign `.querySelectorAll` per test. */
  document: { querySelectorAll: (selector: string) => FakeMoneyNode[] };
  /** The sandboxed `fetch` mock — assign a vi.fn() implementation per test BEFORE this is created (see loadCaratCartPricing's `fetch` param). */
  fetch: FetchImpl;
  /** Handlers registered via the sandboxed `subscribe()`, keyed by event name. */
  subscribedHandlers: Map<string, Array<(event: unknown) => void>>;
  routes: { cart_url: string };
}

/**
 * Evaluates theme/assets/cart.js in a fresh sandbox. `fetch` is supplied by
 * the caller (typically a `vi.fn()`) so each test controls exactly what the
 * cart-fetch and proxy-fetch calls resolve/reject with.
 */
export function loadCaratCartPricing(fetchImpl: FetchImpl): CartPricingSandbox {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "cart.js"), "utf8");

  const subscribedHandlers = new Map<string, Array<(event: unknown) => void>>();

  class FakeHTMLElement {
    querySelector(): null {
      return null;
    }
    querySelectorAll(): never[] {
      return [];
    }
    addEventListener(): void {}
    closest(): null {
      return null;
    }
  }

  const documentStub = {
    addEventListener: () => {},
    querySelectorAll: (): FakeMoneyNode[] => [],
    getElementById: () => null,
    querySelector: () => null,
  };

  const windowStub: WindowStub = {
    StandardEvents: {
      // cart.js does `class CartItems extends window.StandardEvents.createViewEventElement(HTMLElement)`.
      // Identity stub: extending HTMLElement itself is enough for the class to declare successfully.
      createViewEventElement: (Base: unknown) => Base,
    },
  };

  const sandbox: Record<string, unknown> = {
    console,
    HTMLElement: FakeHTMLElement,
    customElements: {
      define: () => {},
      get: () => undefined,
    },
    document: documentStub,
    window: windowStub,
    fetch: fetchImpl,
    subscribe: (eventName: string, callback: (event: unknown) => void) => {
      const handlers = subscribedHandlers.get(eventName) ?? [];
      handlers.push(callback);
      subscribedHandlers.set(eventName, handlers);
      return () => {
        const remaining = (subscribedHandlers.get(eventName) ?? []).filter((h) => h !== callback);
        subscribedHandlers.set(eventName, remaining);
      };
    },
    publish: async () => {},
    PUB_SUB_EVENTS: {
      cartUpdate: "cart-update",
      quantityUpdate: "quantity-update",
      optionValueSelectionChange: "option-value-selection-change",
      variantChange: "variant-change",
      cartError: "cart-error",
    },
    routes: { cart_url: "/cart", cart_change_url: "/cart/change.js" },
    debounce: (fn: (...args: unknown[]) => unknown) => fn,
    ON_CHANGE_DEBOUNCE_TIMER: 0,
    trapFocus: () => {},
    removeTrapFocus: () => {},
    CartPerformance: {
      createStartingMarker: () => ({}),
      measure: (_name: string, fn: () => unknown) => fn(),
      measureFromMarker: () => {},
      measureFromEvent: () => {},
    },
    fetchConfig: () => ({ method: "POST", headers: {} }),
  };
  windowStub.self = windowStub;
  sandbox.self = windowStub;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/cart.js" });

  const caratCartPricing = (sandbox.window as WindowStub).CaratCartPricing;
  if (!caratCartPricing) {
    throw new Error(
      "loadCaratCartPricing: theme/assets/cart.js executed but did not define window.CaratCartPricing " +
        "— the sandbox stubs above may be out of date with the real file."
    );
  }

  return {
    caratCartPricing,
    document: documentStub,
    fetch: fetchImpl,
    subscribedHandlers,
    routes: sandbox.routes as { cart_url: string },
  };
}
