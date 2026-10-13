import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/product-form.js` into a minimal Node `vm`
 * sandbox, the same approach as `caratCartPricingSandbox.ts` and for the
 * same reason (no jsdom in this repo — see that file's header comment for
 * the full rationale, which applies unchanged here).
 *
 * WHY NOT INSTANTIATE A REAL CUSTOM ELEMENT. product-form.js's class
 * extends HTMLElement and is registered via `customElements.define`, but
 * this harness never does `document.createElement('product-form')` or
 * `new ProductForm()` — constructing a spec-compliant custom element
 * without a real DOM is its own rabbit hole (attachment, upgrade timing,
 * a real `<form>` to back `new FormData(this.form)`, ...) that would test
 * plumbing this task didn't touch. Instead, `customElements.define` is
 * stubbed to CAPTURE the class constructor, and tests call
 * `ProductForm.prototype.onSubmitHandler.call(fakeThis, fakeEvent)`
 * directly — a plain method call with a hand-built `this`, which is all
 * `onSubmitHandler` and `applyCaratPaymentModeIfRequested` need, since
 * neither reads anything from the HTMLElement base class itself.
 *
 * SCOPE. This harness exists for exactly one thing 2B-5 added to this
 * file: which submit button (`evt.submitter`) triggers a call to
 * `window.CaratCartPricing.setPaymentMode('bank')`, and in what order
 * relative to the drawer/notification render. It does not re-test Dawn's
 * pre-existing add-to-cart mechanics (error handling, sold-out messaging,
 * quick-add-modal timing, ...), which this task did not change.
 *
 * `FormData` IS A LOCAL FAKE, NOT NODE'S REAL GLOBAL. Node's undici-backed
 * `FormData` performs WebIDL argument conversion on its constructor
 * argument and throws for a plain fake `{}` (verified: "FormData
 * constructor: Argument 1 could not be converted to: undefined") — it does
 * not support the browser's `new FormData(formElement)` extraction form
 * either, so there is no version of Node's real FormData that would accept
 * `this.form` here regardless. The fake below ignores its constructor
 * argument entirely and only implements `.get()`/`.append()`, which is all
 * `onSubmitHandler` calls on it — sufficient because these tests never
 * assert on submitted field values, only on mode-switch call sequencing.
 */

const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

/** See this file's header comment for why this exists instead of Node's real global FormData. */
class FakeFormData {
  private readonly fields = new Map<string, unknown>();
  constructor(_form?: unknown) {}
  append(key: string, value: unknown) {
    this.fields.set(key, value);
  }
  get(key: string) {
    return this.fields.has(key) ? this.fields.get(key) : null;
  }
}

export interface FakeClassList {
  contains(className: string): boolean;
  remove(className: string): void;
  add(className: string): void;
}

export function createFakeClassList(initiallyEmpty = true): FakeClassList {
  let empty = initiallyEmpty;
  return {
    contains: (className) => (className === "is-empty" ? empty : false),
    remove: (className) => {
      if (className === "is-empty") empty = false;
    },
    add: () => {},
  };
}

/** The minimal fake `this` product-form.js's prototype methods are called against. */
export interface FakeProductFormThis {
  form: Record<string, unknown>;
  cart: {
    getSectionsToRender: () => Array<{ id: string }>;
    setActiveElement: (el: unknown) => void;
    renderContents: (response: unknown) => void;
    classList: FakeClassList;
  } | null;
  submitButton: { getAttribute: () => null; querySelector: () => null; classList: FakeClassList };
  submitButtonText: null;
  hideErrors: boolean;
  error: boolean;
  handleErrorMessage: (message?: string) => void;
  dispatchCartErrorEvent: (message: string, code: string) => void;
  createCartLinesUpdateEvent: (variantId: unknown, quantity: number) => null;
  resolveCartLinesUpdate: (deferred: unknown) => void;
  closest: () => null;
}

/**
 * `prototype` MUST be `ProductForm.prototype` from the same `loadProductForm()`
 * call these tests exercise. `onSubmitHandler` calls
 * `this.applyCaratPaymentModeIfRequested(...)` — a REAL prototype method this
 * harness does not stub — so the fake `this` has to actually inherit from
 * that prototype rather than being a bare object literal, or that call
 * throws "not a function".
 */
export function createFakeProductFormThis(
  prototype: object,
  overrides: Partial<FakeProductFormThis> = {}
): FakeProductFormThis {
  return Object.assign(Object.create(prototype), {
    form: {},
    cart: {
      getSectionsToRender: () => [],
      setActiveElement: () => {},
      renderContents: () => {},
      classList: createFakeClassList(),
    },
    submitButton: { getAttribute: () => null, querySelector: () => null, classList: createFakeClassList() },
    submitButtonText: null,
    hideErrors: true,
    error: false,
    handleErrorMessage: () => {},
    dispatchCartErrorEvent: () => {},
    createCartLinesUpdateEvent: () => null,
    resolveCartLinesUpdate: () => {},
    closest: () => null,
    ...overrides,
  });
}

/** A fake submit button carrying `data-carat-add-to-cart`, for use as `evt.submitter`. */
export function createFakeSubmitter(flavor: "default" | "bank" | null) {
  return {
    getAttribute: (name: string) => (name === "data-carat-add-to-cart" ? flavor : null),
    setAttribute: () => {},
    removeAttribute: () => {},
    classList: createFakeClassList(),
    querySelector: () => null,
  };
}

/**
 * Explicit rather than `Record<string, ...>` so `.call(fakeThis, evt)` at
 * call sites type-checks without `noUncheckedIndexedAccess` widening every
 * lookup to `| undefined` — this repo's tsconfig has that flag on.
 */
export interface ProductFormPrototype {
  onSubmitHandler(
    this: FakeProductFormThis,
    evt: { preventDefault: () => void; submitter: ReturnType<typeof createFakeSubmitter> }
  ): unknown;
  applyCaratPaymentModeIfRequested(this: FakeProductFormThis, wantsBankPaymentMode: boolean): Promise<unknown>;
}

export interface ProductFormSandbox {
  ProductForm: { prototype: ProductFormPrototype };
  caratCartPricing: { setPaymentMode: (...args: unknown[]) => Promise<unknown> } | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FetchImpl = (...args: any[]) => Promise<any>;

const NO_FETCH_CONFIGURED: FetchImpl = () =>
  Promise.reject(new Error("loadProductForm: no fetch mock configured for this test"));

/**
 * `setPaymentModeImpl` of `undefined` means "window.CaratCartPricing is not
 * loaded on this page at all" (see the 2B-5 handoff's named gap for
 * `cart_type: notification`), rather than "loaded but missing the method" —
 * `applyCaratPaymentModeIfRequested`'s optional-chaining must tolerate both,
 * but they are genuinely different scenarios and tests should be able to
 * exercise the first one exactly.
 */
export function loadProductForm(
  // `"card" | "bank"`, matching cart.js's own setPaymentMode signature
  // exactly — not the wider `string` this used to declare, which rejected
  // wiring the REAL `caratCartPricing.setPaymentMode` in directly (its
  // narrower parameter type isn't assignable to a `(mode: string) => ...`
  // parameter under strict contravariance).
  setPaymentModeImpl: ((mode: "card" | "bank") => Promise<unknown>) | undefined,
  fetchImpl: FetchImpl = NO_FETCH_CONFIGURED
): ProductFormSandbox {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "product-form.js"), "utf8");

  let capturedClass: { prototype: ProductFormPrototype } | null = null;

  class FakeHTMLElement {}

  const windowStub: Record<string, unknown> = {
    StandardEvents: undefined,
    variantStrings: { addToCart: "Add to cart" },
    location: { pathname: "/products/fake-product" },
  };
  if (setPaymentModeImpl) {
    windowStub.CaratCartPricing = { setPaymentMode: setPaymentModeImpl };
  }

  const routesStub = { cart_add_url: "/cart/add.js", cart_url: "/cart" };
  windowStub.routes = routesStub;

  const sandbox: Record<string, unknown> = {
    console,
    HTMLElement: FakeHTMLElement,
    FormData: FakeFormData,
    customElements: {
      define: (_name: string, ctor: { prototype: ProductFormPrototype }) => {
        capturedClass = ctor;
      },
      get: () => undefined,
    },
    document: {
      querySelector: () => null,
      activeElement: null,
      body: { addEventListener: () => {} },
    },
    window: windowStub,
    routes: routesStub,
    fetchConfig: (type = "json") => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: `application/${type}` },
    }),
    fetch: fetchImpl,
    publish: () => Promise.resolve(),
    PUB_SUB_EVENTS: { cartUpdate: "cart-update", cartError: "cart-error" },
    CartPerformance: {
      createStartingMarker: () => ({}),
      measure: (_name: string, fn: () => unknown) => fn(),
      measureFromMarker: () => {},
      measureFromEvent: () => {},
    },
  };
  windowStub.self = windowStub;
  sandbox.self = windowStub;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/product-form.js" });

  if (!capturedClass) {
    throw new Error(
      "loadProductForm: theme/assets/product-form.js executed but customElements.define was never called " +
        "— the sandbox stubs above may be out of date with the real file."
    );
  }

  return {
    ProductForm: capturedClass,
    caratCartPricing: windowStub.CaratCartPricing as { setPaymentMode: (...args: unknown[]) => Promise<unknown> },
  };
}
