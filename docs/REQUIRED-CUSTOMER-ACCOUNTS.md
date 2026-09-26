# Required Customer Accounts — Locked Owner Decision

## Status

**LOCKED OWNER REQUIREMENT — APPROVED 2026-09-26**

This document is authoritative for customer authentication at purchase and for customer self-service post-purchase workflows. It supersedes any earlier architecture or implementation that allowed guest purchase, guest order lookup, or guest magic-link access to warranty/RMA forms.

## 1. Core Rule

CaratForUs requires an authenticated Shopify customer account for **every purchase**.

**Guest checkout and guest purchasing are not supported.**

Use Shopify customer accounts for authentication. Do not build a separate CaratForUs username/password system.

## 2. Purchase Paths Covered

The authenticated-account requirement applies to every customer purchase path, including:

- normal Buy Now / Card checkout;
- Buy Now Bank Payment checkout and draft-order creation;
- Luxury Steals;
- Community Group Buy;
- Custom Jewelry final approval/purchase;
- any future purchase path added to CaratForUs.

A custom/app-mediated purchase path must never become a loophole around the Shopify account requirement.

## 3. Native Shopify Checkout

Configure Shopify so customers must sign in before checkout.

The storefront may let a customer browse, configure products, and build a cart while signed out, but the customer must authenticate before completing a purchase.

If Shopify suppresses an accelerated checkout surface because sign-in is required, that is an accepted consequence of this owner decision.

## 4. App-Mediated / Bank Payment Checkout

The Bank Payment flow must require a signed Shopify customer identity before a Bank Payment request or draft order can be created.

Server-side authorization must use the authenticated Shopify customer identity (for App Proxy flows, the signed `logged_in_customer_id` or the equivalent verified Shopify session identity). Do not trust a customer ID, email address, or order number supplied only by the browser.

Anonymous Bank Payment checkout must fail closed.

Approved customer-facing gate copy:

> **Please sign in or create a CaratForUs account to continue.**

## 5. Warranty and RMA Self-Service

Warranty claims and Buy Now RMA/return self-service require an authenticated Shopify customer account.

For self-service:

- identify the customer from the authenticated Shopify identity;
- show or accept only orders and line items that belong to that customer;
- never reveal order information from order number + email alone;
- do not provide a guest magic-link fallback.

A customer who cannot access the account used for purchase must contact CaratForUs Customer Care. Staff may verify the purchaser and assist manually through an authenticated/admin workflow.

## 6. Guest Verification Flow Is Superseded

The previously designed guest flow — order number + email, emailed single-use verification token, verification page, token TTL, and guest order lookup — is no longer a CaratForUs requirement.

Implementation must:

- remove guest entry points from customer-facing warranty/RMA flows;
- stop creating new guest-verification tokens;
- stop sending guest verification emails;
- remove or retire guest-verification routes and code when no other approved workflow depends on them;
- preserve any historical records that must be retained for audit/evidence, but do not keep dead security-sensitive code merely because it was already built.

If a database migration is needed to remove unused guest-verification storage, it must be migration-safe and must not delete evidence that is legally or operationally required to be retained.

## 7. Fraud and Security

Required accounts are an identity and audit control, not a complete fraud-prevention system.

Keep the existing controls for payment verification, Shopify/payment-provider fraud screening, Bank Payment verification, shipping/address controls, acknowledgments, evidence, idempotency, and fulfillment review.

Do not describe an authenticated account as proof that a transaction is non-fraudulent.

## 8. Store Credit

Where CaratForUs issues Shopify Store Credit, it belongs to the authenticated Shopify customer account to which it is issued. The account requirement is therefore consistent with the locked merchandise-credit design.

## 9. Acceptance Cases

1. A signed-out shopper may browse, but cannot complete a Card checkout without authenticating.
2. A signed-out shopper cannot create a Bank Payment request or draft order.
3. A signed-out shopper cannot submit a self-service warranty claim or RMA against an order.
4. An authenticated customer can see/use only orders that belong to that Shopify customer identity.
5. Supplying another customer's order number/email never reveals that customer's order.
6. Luxury Steals, Group Buy, and Custom Jewelry purchase paths cannot bypass the account requirement.
7. Guest magic-link/token infrastructure is not reachable from the customer-facing product.
8. Existing payment, fraud, shipping, evidence, and fulfillment controls remain in force after account authentication.
9. A customer who cannot access the original account is directed to Customer Care for manual verification rather than a guest self-service bypass.

## 10. Implementation Note

This decision intentionally favors lower fraud exposure, stronger order-to-customer identity, and simpler post-purchase support over maximizing guest-checkout conversion. Any future reintroduction of guest purchasing or guest self-service requires a new explicit owner decision and a security/architecture review.
