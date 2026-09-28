import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/group-buy-campaign.js` into a minimal Node
 * `vm` sandbox — same technique and same reasoning as
 * `warrantyClaimFormSandbox.ts` / `bankPaymentCheckoutFormSandbox.ts` (see
 * those files' own header comments). Only enough of a `document`/`window`
 * stub is provided to let the file PARSE AND EXECUTE top-to-bottom without
 * throwing (its module-load-time `initAll()` call finds zero
 * `[data-carat-gb-campaign]` roots against the stub and does nothing), so
 * every test below exercises the exposed `_internal` PURE functions
 * directly rather than any DOM wiring.
 */
const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

export interface GroupBuyVariant {
  id: number | string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  available?: boolean;
  [key: string]: unknown;
}

export interface CampaignProgressLikeData {
  groupBuyRegularCardPriceMinorUnits: string;
  groupBuyBankPaymentPriceMinorUnits: string;
  [key: string]: unknown;
}

export interface GroupBuyCampaignModule {
  _internal: {
    formatMoney(minorUnitsString: string, moneyFormat: string): string;
    formatCountdown(seconds: number | null): string | null;
    isPositiveMinorUnits(value: unknown): boolean;
    activePriceMinorUnits(data: CampaignProgressLikeData, mode: "card" | "bank"): string;
    parseCampaignOptionsJson(raw: string | null): { schemaVersion: number; tableView: { columns: string[] } } | null;
    buildTableColumns(
      productOptionNames: string[],
      campaignOptions: { tableView: { columns: string[] } } | null
    ): string[];
    buildTableHeaderLabels(columns: string[]): string[];
    resolveVariantForOptionValues(variants: GroupBuyVariant[], selectedValues: string[]): GroupBuyVariant | null;
    firstAvailableOrFirstVariant(variants: GroupBuyVariant[]): GroupBuyVariant | null;
    canSubmitOrder(state: {
      variant: GroupBuyVariant | null;
      paymentType: "card" | "bank" | null;
      signedIn: boolean;
      acknowledged: boolean;
    }): boolean;
  };
}

export function loadGroupBuyCampaign(): GroupBuyCampaignModule {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "group-buy-campaign.js"), "utf8");

  const windowStub: { CaratGroupBuyCampaign?: GroupBuyCampaignModule } = {};

  const documentStub = {
    // 'complete' so the module's load-time `if (document.readyState ===
    // 'loading')` branch is skipped and `initAll()` runs synchronously.
    // `querySelectorAll` returns an empty array-like, so `initAll()`
    // iterates zero roots and never touches real DOM wiring — only enough
    // to reach the `window.CaratGroupBuyCampaign = { _internal: ... }`
    // assignment at the bottom of the file.
    readyState: "complete",
    addEventListener: () => {},
    querySelectorAll: () => [],
  };

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    window: windowStub,
    fetch: () => Promise.reject(new Error("groupBuyCampaignSandbox: fetch should not be called by _internal tests")),
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "theme/assets/group-buy-campaign.js" });

  const module = windowStub.CaratGroupBuyCampaign;
  if (!module) {
    throw new Error(
      "loadGroupBuyCampaign: theme/assets/group-buy-campaign.js executed but did not define " +
        "window.CaratGroupBuyCampaign — the sandbox stubs above may be out of date with the real file."
    );
  }
  return module;
}
