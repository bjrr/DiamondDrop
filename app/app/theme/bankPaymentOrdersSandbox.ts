import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/bank-payment-orders.js` into a minimal Node
 * `vm` sandbox — same technique and same reasoning as
 * `bankPaymentCheckoutFormSandbox.ts` and `caratCartPricingSandbox.ts` (see
 * the latter for why a hand-rolled sandbox rather than jsdom: this repo has
 * no DOM test environment configured).
 *
 * SCOPE, STATED PLAINLY. Only the pure `_internal` surface is exercised:
 * `formatDeadline`, `statusLabel`, `isLapsedGroupBuy`, `summarize` and
 * `messageKeyForFailure`. The DOM rendering (`renderInstructions`,
 * `renderBuyNowOrder`, `renderGroupBuyOrder`) is NOT covered here and is not
 * claimed to be — it is verified by the live production smoke test instead.
 * That split is the same boundary `caratCartPricing.test.ts` documents, and
 * it is flagged rather than quietly assumed.
 *
 * `window.bankPaymentOrdersStrings` is settable by the test because
 * `statusLabel` reads it at call time — which is exactly the behaviour worth
 * pinning: an unrecognised status must fall through to the raw value rather
 * than render an empty cell.
 */
const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

export interface BankPaymentOrdersWindow {
  bankPaymentOrdersStrings?: Record<string, string>;
  CaratBankPaymentOrders?: BankPaymentOrdersModule;
}

export interface BankPaymentOrdersModule {
  _internal: {
    formatDeadline(iso: string): string;
    statusLabel(flow: string, status: string): string;
    isLapsedGroupBuy(order: { inactivatedAt?: string | null; reactivatedAt?: string | null } | null): boolean;
    summarize(payload: unknown): {
      buyNow: unknown[];
      groupBuy: unknown[];
      isEmpty: boolean;
      coordinatesMissing: boolean;
    };
    messageKeyForFailure(status: number): string;
  };
}

export function loadBankPaymentOrders(): {
  module: BankPaymentOrdersModule;
  windowStub: BankPaymentOrdersWindow;
} {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "bank-payment-orders.js"), "utf8");

  const windowStub: BankPaymentOrdersWindow = {};

  const documentStub = {
    // 'complete' so the module's load-time branch runs `init()` synchronously.
    // `init()` immediately returns because `querySelector` finds no section —
    // which is the point: no fetch is attempted by these tests.
    readyState: "complete",
    addEventListener: () => {},
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
  };

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    window: windowStub,
    fetch: () =>
      Promise.reject(
        new Error("bankPaymentOrdersSandbox: fetch should not be called by _internal tests")
      ),
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/bank-payment-orders.js" });

  const module = windowStub.CaratBankPaymentOrders;
  if (!module) {
    throw new Error(
      "loadBankPaymentOrders: theme/assets/bank-payment-orders.js executed but did not define " +
        "window.CaratBankPaymentOrders — the sandbox stubs above may be out of date with the real file."
    );
  }
  return { module, windowStub };
}
