/**
 * LIVE GATE — does SHOPIFY ITSELF require a customer account at checkout?
 *
 * `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` §3 tells us to configure Shopify so
 * customers must sign in before checkout, and §9 case 1 makes it an
 * acceptance case. That is STORE CONFIGURATION, not code — so no unit test,
 * integration test or code review can ever prove it. Nothing in the
 * repository can.
 *
 * WHY THIS GATE EXISTS RATHER THAN A LINE IN A RUNBOOK. The required-accounts
 * audit closed three server-side bypasses, and every one of those fixes is
 * necessary but NOT sufficient: if the store still allows guest checkout, a
 * signed-out shopper completes a native Shopify card checkout regardless of
 * how correct our routes are. When this gate was first written (2026-09-26)
 * the live store returned `customerAccounts: OPTIONAL` and
 * `loginRequiredAtCheckout: false` — guest checkout was wide open while the
 * policy said it must not be. A runbook line would have recorded the
 * intention; only a gate catches the state.
 *
 * It also catches DRIFT. Store settings are edited by humans in an admin UI,
 * with no review, no diff and no history visible to us. This is the only
 * thing that would notice the setting being turned back.
 *
 * FIELD NAMES ARE INTROSPECTED, NOT RECALLED. Both were confirmed to exist on
 * `Shop` in Admin API 2026-07 before this was written:
 *   - `customerAccounts: ShopCustomerAccountsSetting` (REQUIRED|OPTIONAL|DISABLED)
 *   - `customerAccountsV2.loginRequiredAtCheckout: Boolean`
 * Guessing a plausible field name and reporting the resulting failure as a
 * finding is a mistake this project has made repeatedly; introspect first.
 *
 * RUN:  npx tsx tests/live/requiredCustomerAccounts.ts
 * SIDE EFFECTS: none. Two read-only queries. Safe to run any time.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

interface AccountsSettingResponse {
  data?: {
    shop?: {
      customerAccounts?: string;
      customerAccountsV2?: {
        customerAccountsVersion?: string;
        loginRequiredAtCheckout?: boolean;
        loginLinksVisibleOnStorefrontAndCheckout?: boolean;
      };
    };
  };
  errors?: unknown;
}

async function main() {
  console.log(`Required customer accounts — live configuration gate against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  const response = await (admin.graphql as AdminGraphql)(`#graphql
    query CaratRequiredCustomerAccounts {
      shop {
        customerAccounts
        customerAccountsV2 {
          customerAccountsVersion
          loginRequiredAtCheckout
          loginLinksVisibleOnStorefrontAndCheckout
        }
      }
    }
  `);

  // Admin API failures arrive on HTTP 200 with a top-level `errors` key, so
  // checking the status alone proves nothing.
  const body = (await response.json()) as AccountsSettingResponse;
  if (body.errors) {
    console.error("Admin API returned errors:", JSON.stringify(body.errors));
    process.exit(1);
  }

  const shop = body.data?.shop;
  const setting = shop?.customerAccounts;
  const v2 = shop?.customerAccountsV2;

  console.log(`  customerAccounts:            ${setting}`);
  console.log(`  customerAccountsVersion:     ${v2?.customerAccountsVersion}`);
  console.log(`  loginRequiredAtCheckout:     ${v2?.loginRequiredAtCheckout}`);
  console.log(`  loginLinksVisible:           ${v2?.loginLinksVisibleOnStorefrontAndCheckout}\n`);

  // §9 case 1 — a signed-out shopper may browse but cannot complete a
  // checkout without authenticating.
  check(
    setting === "REQUIRED",
    `customerAccounts is REQUIRED (got ${setting}) — OPTIONAL permits guest checkout, DISABLED removes accounts entirely`
  );

  // The v2 flag is the one that actually gates the checkout surface on stores
  // using new customer accounts, so BOTH are asserted rather than assuming
  // one implies the other.
  check(
    v2?.loginRequiredAtCheckout === true,
    `loginRequiredAtCheckout is true (got ${v2?.loginRequiredAtCheckout})`
  );

  if (failures > 0) {
    console.log(
      "\nGUEST CHECKOUT IS REACHABLE. Every server-side account check we have " +
        "is bypassed by the native Shopify checkout while this is so.\n" +
        "Fix in Shopify admin: Settings -> Checkout -> Customer accounts -> " +
        "require the customer to log in before checkout. This is an owner action; " +
        "it cannot be set from this repository."
    );
  }

  console.log(failures === 0 ? "\nLIVE GATE PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
