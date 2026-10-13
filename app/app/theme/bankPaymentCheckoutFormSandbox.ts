import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/bank-payment-checkout.js` into a minimal
 * Node `vm` sandbox, same technique and same reasoning as
 * `caratCartPricingSandbox.ts` (see that file's header comment for why a
 * hand-rolled `vm` sandbox rather than jsdom — this repo has no DOM test
 * environment configured).
 *
 * SMALLER THAN caratCartPricingSandbox.ts ON PURPOSE. bank-payment-
 * checkout.js's `_internal` surface (normalizeValues, validateFormValues,
 * buildShippingAddress, buildRequestBody, buildRequestLines,
 * messageKeyForFailure) is pure — none of it touches `document` or `fetch`.
 * Only enough of a `document`/`window` stub is provided to let the file
 * PARSE AND EXECUTE top-to-bottom (it calls `document.addEventListener`
 * once at load time, gated on `document.readyState`) without throwing.
 * Real DOM interaction (opening the dialog, wiring the submit handler,
 * writing field errors) is NOT exercised here — same scope boundary
 * `caratCartPricing.test.ts` documents for cart.js, and flagged the same
 * way in the 2C-6 handoff rather than silently claimed as covered.
 */
const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

export interface BankPaymentCheckoutModule {
  _internal: {
    normalizeValues(rawValues: Record<string, unknown> | null | undefined): Record<string, string>;
    validateFormValues(
      values: Record<string, string>
    ): Array<{ field: string; messageKey: string }>;
    buildShippingAddress(values: Record<string, string>): Record<string, string>;
    buildRequestBody(
      values: Record<string, string>,
      lines: Array<{ shopifyVariantId: string; quantity: number }>
    ): {
      mode: "bank";
      email: string;
      shippingAddress: Record<string, string>;
      lines: Array<{ shopifyVariantId: string; quantity: number }>;
    };
    buildRequestLines(cart: unknown): Array<{ shopifyVariantId: string; quantity: number }>;
    messageKeyForFailure(status: number, body: unknown): string;
  };
}

export function loadBankPaymentCheckout(): BankPaymentCheckoutModule {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "bank-payment-checkout.js"), "utf8");

  const windowStub: { CaratBankPaymentCheckout?: BankPaymentCheckoutModule; location: { href: string } } = {
    location: { href: "https://example.myshopify.com/cart" },
  };

  const documentStub = {
    // 'complete' so the module's load-time `if (document.readyState === 'loading')`
    // branch is skipped and `init()` runs synchronously — this test does not
    // exercise init()'s listeners, only the returned `_internal` object, but
    // the module must still execute without throwing to return anything.
    readyState: "complete",
    addEventListener: () => {},
    getElementById: () => null,
  };

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    window: windowStub,
    fetch: () => Promise.reject(new Error("bankPaymentCheckoutFormSandbox: fetch should not be called by _internal tests")),
    FormData: class {
      get(): null {
        return null;
      }
    },
    routes: { cart_url: "/cart" },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/bank-payment-checkout.js" });

  const module = windowStub.CaratBankPaymentCheckout;
  if (!module) {
    throw new Error(
      "loadBankPaymentCheckout: theme/assets/bank-payment-checkout.js executed but did not define " +
        "window.CaratBankPaymentCheckout — the sandbox stubs above may be out of date with the real file."
    );
  }
  return module;
}
