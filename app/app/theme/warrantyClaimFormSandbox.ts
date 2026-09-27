import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/warranty-claim-form.js` into a minimal Node
 * `vm` sandbox -- same technique and same reasoning as
 * `bankPaymentCheckoutFormSandbox.ts` (see that file's own header comment).
 *
 * SMALLER STILL. Only the three genuinely pure order-lookup helpers this
 * task added (`orderLookupMessageKeyForFailure`, `normalizeOrderLookupResult`,
 * `buildLineItemOptionLabel`) are exposed via `_internal` -- the rest of
 * `warranty-claim-form.js` (validate/buildRequestBody/handleSubmit/
 * wireOrderLookup's own DOM wiring) still reads `document`/`form` directly
 * and is out of scope for this sandbox, exactly the same scope boundary
 * `bankPaymentCheckoutFormSandbox.ts` documents for its own file. Only
 * enough of a `document`/`window` stub is provided to let the file PARSE
 * AND EXECUTE top-to-bottom without throwing (it calls
 * `document.addEventListener`/`document.querySelector` once at load time,
 * gated on `document.readyState`).
 */
const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

export interface WarrantyClaimFormModule {
  _internal: {
    orderLookupMessageKeyForFailure(status: number): string;
    normalizeOrderLookupResult(body: unknown): {
      resolved: boolean;
      order: { orderRef: string; orderName: string; lineItems: { lineRef: string; title: string; quantity: number }[] } | null;
    };
    buildLineItemOptionLabel(template: string, item: { title: string; quantity: number }): string;
  };
}

export function loadWarrantyClaimForm(): WarrantyClaimFormModule {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "warranty-claim-form.js"), "utf8");

  const windowStub: { CaratWarrantyClaimForm?: WarrantyClaimFormModule; caratWarrantyClaimFormLoaded?: boolean; location: { search: string }; warrantyClaimStrings?: Record<string, string> } = {
    location: { search: "" },
  };

  const documentStub = {
    // 'complete' so the module's load-time `if (document.readyState ===
    // 'loading')` branch is skipped and `init()` runs synchronously. `init()`
    // itself no-ops (`querySelector(FORM_SELECTOR)` returns `null` below),
    // so this never exercises real DOM wiring -- only enough to reach the
    // `window.CaratWarrantyClaimForm = { _internal: ... }` assignment at the
    // bottom of the file.
    readyState: "complete",
    addEventListener: () => {},
    querySelector: () => null,
  };

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    window: windowStub,
    URLSearchParams,
    fetch: () => Promise.reject(new Error("warrantyClaimFormSandbox: fetch should not be called by _internal tests")),
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/warranty-claim-form.js" });

  const module = windowStub.CaratWarrantyClaimForm;
  if (!module) {
    throw new Error(
      "loadWarrantyClaimForm: theme/assets/warranty-claim-form.js executed but did not define " +
        "window.CaratWarrantyClaimForm -- the sandbox stubs above may be out of date with the real file."
    );
  }
  return module;
}
