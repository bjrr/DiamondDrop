---
name: backend-feature
description: Implement an architect-approved CaratForUs backend feature with deterministic business rules, auditability, and focused tests.
---

# Backend Feature

Use for delegated server-side/domain/persistence work.

1. Read `CLAUDE.md`, the architect-approved feature spec, relevant `README.md`, and applicable locked `docs/` policies.
2. Inspect existing code/tests and follow established patterns.
3. Confirm exact acceptance criteria and affected domain boundaries before editing.
4. Implement the smallest complete backend slice.
5. Keep money/eligibility logic server-authoritative and deterministic.
6. Use integer minor units or approved decimal/money types; centralize rounding.
7. Make state transitions explicit, auditable, and idempotent where events/webhooks/retries are involved.
8. Preserve immutable/versioned snapshots and acknowledgment/evidence records where required.
9. Validate untrusted inputs at boundaries and enforce authorization on admin/internal operations.
10. Add focused unit/domain tests plus integration tests where persistence/Shopify boundaries matter.
11. Run formatter/lint/typecheck/tests/build that apply.
12. Do not redesign architecture, add dependencies, or expand scope without architect approval.

Required handoff:
- files changed;
- behavior implemented;
- commands/tests run and results;
- migrations/config/env impact;
- policy files used;
- assumptions/unresolved issues;
- architect-review items.