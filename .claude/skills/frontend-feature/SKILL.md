---
name: frontend-feature
description: Implement an architect-approved CaratForUs customer-facing feature with mobile-first accessibility, policy-safe UX, and Shopify-compatible behavior.
---

# Frontend Feature

Use for delegated storefront/theme/UI implementation.

1. Read `CLAUDE.md`, the architect-approved feature spec, relevant `README.md`, and applicable locked `docs/` policies.
2. Inspect existing components/theme patterns before editing.
3. Implement only the assigned acceptance criteria; do not invent business rules.
4. Prefer Shopify-native/theme behavior when it meets the requirement.
5. Keep authoritative money, eligibility, and workflow decisions on the server/application; frontend may render returned state but must not become the source of truth.
6. Make material terms conspicuous and required acknowledgments unchecked/non-bypassable where specified.
7. Handle loading, empty, sold-out, expired, unavailable, validation, upload, and server-error states.
8. Use semantic HTML, labels, keyboard-accessible controls, visible focus, and non-color-only status communication.
9. Validate mobile and desktop layouts and primary keyboard flows.
10. Add/update component/UI tests where practical and run applicable lint/typecheck/tests/build.
11. Do not introduce a new frontend framework or heavy dependency without architect approval.

Required handoff:
- files changed;
- customer behavior implemented;
- responsive/accessibility checks performed;
- tests/commands and results;
- Shopify/theme limitations;
- policy files used;
- unresolved issues;
- architect-review items.