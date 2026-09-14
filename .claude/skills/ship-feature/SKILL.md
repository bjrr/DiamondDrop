---
name: ship-feature
description: Final release gate before commit/PR/deploy for a CaratForUs feature.
---

# Ship Feature

Before declaring a feature ready:

1. Confirm implementation matches the architect-approved feature spec, `README.md`, and applicable locked policy documents.
2. Ensure automated tests cover changed business behavior and meaningful failure/boundary/retry cases.
3. Run all relevant formatter, lint, typecheck, test, and build commands available in the project.
4. Run or review applicable integration tests across Shopify/frontend/backend/persistence boundaries.
5. Review money/rounding, Group Buy lifecycle, RMA/returns, Luxury Steals Final Sale, quote-match fallback, warranty claims, webhook idempotency, authorization, evidence retention, accessibility, and Post-MVP scope as applicable.
6. Inspect `git diff` and `git status` for accidental files, secrets, debug output, generated artifacts, stale policy text, or unrelated changes.
7. Ensure environment secrets appear only as documented variable names/examples, never credentials.
8. Verify migrations, Shopify metafields/metaobjects, webhook subscriptions/scopes, env vars, and manual setup are documented when changed.
9. Verify customer-facing material terms match the authoritative policy version.
10. Produce a concise release handoff using `/handoff`, including behavior delivered, files/areas changed, commands/results, setup/migrations, known limitations, and architect-review items.
11. If validation fails, do not call the feature ready. Fix it or report the blocker.

Prefer focused commits/PRs over bundling unrelated work.