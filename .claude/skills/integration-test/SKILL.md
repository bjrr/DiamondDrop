---
name: integration-test
description: Validate CaratForUs end-to-end behavior across frontend, backend, Shopify, persistence, webhooks, and policy evidence after delegated implementation.
---

# Integration Test

Use after frontend/backend/Shopify pieces are implemented for a vertical slice.

1. Read the architect-approved feature spec and applicable locked policies.
2. Map the full customer/admin/event journey across boundaries.
3. Verify data passed between storefront, Shopify, backend, and persistence remains consistent and versioned where required.
4. Exercise happy path plus boundary/failure/retry cases.
5. Verify duplicate webhooks/events do not duplicate orders, benefits, refunds, credits, claims, or other customer value.
6. Verify policy acknowledgment text/version/timestamp/configuration evidence is retained where required.
7. Verify authoritative pricing/eligibility state comes from the approved server/source rather than duplicated client logic.
8. Verify inventory/sold-out behavior and cart line-item configuration where applicable.
9. Verify customer-facing errors do not expose secrets/private cost data and provide a recoverable next step.
10. Run the actual available test commands and record exact results.
11. If a full automated environment is not yet available, document the smallest manual integration checklist needed and what remains unverified.

Do not call integration complete when one layer was only mocked unless the feature spec explicitly permits that for the current milestone.

Return a structured handoff with journeys tested, commands/results, failures, unverified assumptions, evidence checked, and architect-review items.