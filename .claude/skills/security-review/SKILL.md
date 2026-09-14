---
name: security-review
description: Perform focused CaratForUs security/privacy review for auth, Shopify webhooks, uploads, PII, secrets, admin data, evidence, and abuse-prone workflows.
---

# Security Review

Use for changes touching customer data, uploads, admin actions, payments/refunds, Shopify webhooks, warranty/return/quote submissions, or evidence storage.

1. Read `CLAUDE.md`, the feature spec, applicable policies, and the full diff.
2. Check authentication and authorization boundaries, especially admin-only operations.
3. Verify Shopify webhook authenticity and replay/idempotency handling.
4. Validate file-upload type/size/handling and prevent executable or unsafe content paths.
5. Check PII minimization, retention, logging, and accidental exposure.
6. Verify secrets/credentials are server-side only and absent from repo/client bundles/logs.
7. Verify private supplier costs, margins, internal notes, and admin-only data cannot reach storefront clients.
8. Check injection, unsafe redirects, insecure direct-object references, predictable private URLs, and trust of client-supplied prices/eligibility.
9. Check duplicate/retry abuse for refunds, credits, fallback discounts, warranty remedies, and Group Buy counts.
10. Check required acknowledgments/evidence cannot be forged merely by client-side state.
11. Confirm policies do not claim to override legal/card-network/payment rights.
12. Report findings by blocker/high/medium/low with concrete remediation.

Do not approve based only on framework defaults. Verify the actual code paths and data flow.