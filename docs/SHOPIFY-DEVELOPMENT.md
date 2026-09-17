# Shopify Development Environment

Last updated: 2026-09-17

This document records the non-secret Shopify development environment for CaratForUs. It must not contain client secrets, access tokens, passwords, signing secrets, or other credentials.

## Development store

- Store name: **CaratForUs Dev**
- Store domain: **caratforus-dev.myshopify.com**
- Store type: **Shopify development store**
- Shopify-generated test data: **enabled**
- Purpose: development, integration testing, and QA only; this is not the production merchant store.

## Shopify app

- Existing development app name: **caratforus-development**
- Embedded in Shopify Admin: **yes**
- Current Shopify dashboard configuration version observed on 2026-09-17: **caratforus-development-2 (Active)**
- Webhooks API version observed in the active dashboard configuration on 2026-09-17: **2026-07**

Do **not** create another Shopify app for this project. Link the existing repository to the existing `caratforus-development` app.

## Local project linking

From `app/`, use Shopify CLI to link the repository to the existing app:

```powershell
npx shopify app config link
```

If the CLI session cannot display the interactive app picker, use the existing app's public Client ID with the CLI-supported `--client-id` option, or run the command in an interactive terminal and select `caratforus-development`.

Never select **Create a new app** during this flow.

After linking, review the generated/updated `shopify.app.toml` before deployment. Reconcile its scopes, webhook declarations, URLs, and API version against `docs/ARCHITECTURE-MVP1.md` and the project's least-privilege requirements.

## Secrets and environment configuration

The Shopify **Client ID / API key is a public app identifier** and may be stored in the appropriate Shopify project configuration. The **Client Secret is sensitive** and must never be committed to GitHub.

Local secrets belong only in the git-ignored local environment file / environment variables. Hosted secrets belong in the deployment platform's secret store.

At minimum, Shopify integration will require the project's established environment variables such as:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_SCOPES`
- `SHOPIFY_APP_URL`
- `SHOPIFY_ADMIN_API_VERSION`
- `SHOPIFY_APP_PROXY_SUBPATH`

Do not commit real secret values.

## Architecture constraints

The existing architecture remains authoritative:

- React Router 7 application architecture is preserved.
- Shopify-native commerce is preferred for standard storefront/checkout/order behavior.
- The custom inbound webhook-processing boundary established by architecture decision D13 is preserved.
- Webhook HMAC verification continues to use the Shopify app secret server-side.
- App Proxy and Admin API integration must follow the authentication and least-privilege rules in `docs/ARCHITECTURE-MVP1.md`.
- Historical Group Buy pricing snapshots must never be changed by current Shopify price synchronization.

## Integration status

As of 2026-09-17:

- Development store: **created**
- Generated test data: **available**
- Existing Shopify development app: **created**
- App configuration: **active in Shopify dashboard**
- Repository/app CLI link: **pending verification in GitHub**
- App installation/OAuth on `caratforus-dev.myshopify.com`: **pending verification**
- Real Admin API price synchronization: **not yet verified**
- Production store: **not configured; not required for current development**

Update this status only after the corresponding integration has actually been verified. Do not infer successful OAuth, app installation, webhook delivery, or Admin API access merely from the existence of the app/store.
