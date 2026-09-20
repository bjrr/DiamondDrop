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

/**
 * Finds `<TAG id="ID" ...>...</TAG>` inside a raw HTML string and returns its
 * inner content, balance-counting tags of the SAME name so a nested element
 * sharing a tag name (e.g. a `<div>` inside another `<div>`) does not
 * terminate the match early. Not a general HTML parser — deliberately scoped
 * to exactly what {@link FakeDOMParser}'s `#id` querySelector needs, the same
 * "not a general X, just enough for what real code needs" scoping as every
 * other fake in this file.
 */
function extractElementInnerHtmlById(html: string, id: string): string | null {
  const idAttr = `id="${id}"`;
  const idIndex = html.indexOf(idAttr);
  if (idIndex === -1) return null;

  const tagStart = html.lastIndexOf("<", idIndex);
  if (tagStart === -1) return null;
  const tagNameMatch = /^<([a-zA-Z0-9-]+)/.exec(html.slice(tagStart));
  if (!tagNameMatch) return null;
  const tagName = tagNameMatch[1];

  const openTagEnd = html.indexOf(">", idIndex);
  if (openTagEnd === -1) return null;
  const contentStart = openTagEnd + 1;

  const tagPattern = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "g");
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return html.slice(contentStart, match.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/**
 * A minimal `DOMParser` stand-in — 2B-5's `extractSectionInnerHTML()` in
 * cart.js calls `new DOMParser().parseFromString(html, 'text/html')
 * .querySelector(selector)` with a plain `#id` selector, and nothing else.
 * Only that one shape is supported; a real DOMParser is out of scope for the
 * same "no jsdom in this repo" reason documented at the top of this file.
 */
class FakeDOMParser {
  parseFromString(html: string, _contentType: string) {
    return {
      querySelector(selector: string): { innerHTML: string } | null {
        const idMatch = /^#([\w-]+)$/.exec(selector);
        if (!idMatch) return null;
        const inner = extractElementInnerHtmlById(html, idMatch[1]!);
        return inner == null ? null : { innerHTML: inner };
      },
    };
  }
}

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
 * A tiny stand-in for `document.querySelectorAll`. Originally hardcoded to
 * the two selector shapes CaratCartPricing's 2B-4 applier used
 * (`[data-carat-money]` and `[data-carat-money][data-carat-mode-pending]`);
 * generalized for 2B-5 to any compound `[attr]`/`[attr="value"]` selector
 * (ANDed together) so the same helper also covers the checkout-interception
 * selectors (`[data-carat-checkout-action="card"]`,
 * `[data-carat-card-checkout-confirm]`) without a second bespoke fake. Not a
 * general CSS engine — still scoped to exactly the attribute-selector shapes
 * this file's real module queries for, just not hardcoded to which
 * attributes those are.
 */
export function makeQuerySelectorAll(nodes: readonly FakeMoneyNode[]) {
  return (selector: string): FakeMoneyNode[] => {
    const requirements = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((match) => ({
      attr: match[1]!,
      value: match[2],
    }));
    return nodes.filter((node) =>
      requirements.every(({ attr, value }) => {
        const actual = node.getAttribute(attr);
        return value !== undefined ? actual === value : actual != null;
      })
    );
  };
}

/** Same shape as {@link FakeMoneyNode}, plus `.dataset` and `.innerHTML` — 2B-5's
 * setPaymentMode() reads `footerEl.dataset.id` (to know which section id to
 * request) and writes `footerEl.innerHTML` (to apply a Section Rendering API
 * refresh), neither of which the money-node-focused FakeMoneyNode needs.
 */
export interface FakeCartElement extends FakeMoneyNode {
  dataset: Record<string, string>;
  innerHTML: string;
}

export function createFakeCartElement(
  initialAttributes: Record<string, string> = {},
  initialDataset: Record<string, string> = {}
): FakeCartElement {
  const attributes: Record<string, string> = { ...initialAttributes };
  const dataset: Record<string, string> = { ...initialDataset };
  let text = "";
  let html = "";
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
    dataset,
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
  } as FakeCartElement;
}

/** A `document.getElementById` stand-in keyed by a plain id->element map. */
export function makeGetElementById<T>(byId: Record<string, T | null | undefined>) {
  return (id: string): T | null => byId[id] ?? null;
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
  /** Public API (2B-5) — see cart.js's own doc comment on setPaymentMode. */
  setPaymentMode(mode: "card" | "bank"): Promise<unknown>;
  _internal: {
    formatMoneyFromMinorUnits(minorUnitsString: string, currency: string): string | null;
    readModeFromCart(cart: unknown): "bank" | "card";
    buildRequestLines(
      cart: unknown
    ): Array<{ lineId: string; shopifyVariantId: string; quantity: number }>;
    selectDisplayMinorUnits(dto: unknown, kind: string, lineId: string | null): string | null;
    applyDtoToDocument(dto: unknown): void;
    markPendingNodesAsFailed(): void;
    // 2B-5 additions — see cart.js's own doc comments.
    hideCardCheckoutConfirm(): void;
    revealCardCheckoutConfirm(): void;
    handleCardCheckoutSubmit(event: {
      submitter: FakeMoneyNode | null;
      target: { requestSubmit(submitter?: unknown): void };
      preventDefault(): void;
    }): unknown;
    hideModeRedundantControls(): void;
    showModeRedundantControls(): void;
    syncModeRedundantControls(mode: string): void;
    handleSwitchToBankClick(event: { target: FakeMoneyNode | null }): unknown;
  };
}

interface WindowStub {
  StandardEvents: { createViewEventElement(base: unknown): unknown };
  self?: WindowStub;
  CaratCartPricing?: CaratCartPricingModule;
  location: { pathname: string };
}

export interface CartPricingSandbox {
  /** The window.CaratCartPricing module cart.js defines. */
  caratCartPricing: CaratCartPricingModule;
  /** The sandboxed `document` — reassign `.querySelectorAll`/`.getElementById` per test. */
  document: {
    querySelectorAll: (selector: string) => FakeMoneyNode[];
    getElementById: (id: string) => FakeCartElement | FakeMoneyNode | null;
  };
  /** The sandboxed `fetch` mock — assign a vi.fn() implementation per test BEFORE this is created (see loadCaratCartPricing's `fetch` param). */
  fetch: FetchImpl;
  /** Handlers registered via the sandboxed `subscribe()`, keyed by event name. */
  subscribedHandlers: Map<string, Array<(event: unknown) => void>>;
  routes: { cart_url: string; cart_update_url: string };
  /** The sandboxed `window.location` AT LOAD TIME — 2B-5's setPaymentMode() reads `.pathname` from this. */
  location: { pathname: string };
  /**
   * The LIVE sandboxed `window` object (same reference cart.js's `window` resolves to) —
   * read `window_.location` fresh, rather than the `location` field above, to observe a
   * hand-off navigation: cart.js's C1 hand-off does `window.location = <url string>`,
   * REPLACING the property entirely rather than mutating `.pathname`, and the `location`
   * field above was captured once at load time so it would not reflect that replacement.
   */
  window_: { location: unknown };
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
    // 2B-5's setPaymentMode() reads window.location.pathname for the
    // Section Rendering API's sections_url param — only reached when a
    // fake #main-cart-footer element is present (see createFakeCartElement
    // usage in tests), but must exist unconditionally so loading the module
    // itself never throws.
    location: { pathname: "/cart" },
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
    DOMParser: FakeDOMParser,
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
    routes: { cart_url: "/cart", cart_change_url: "/cart/change.js", cart_update_url: "/cart/update.js" },
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
    routes: sandbox.routes as { cart_url: string; cart_update_url: string },
    location: windowStub.location,
    window_: windowStub,
  };
}
