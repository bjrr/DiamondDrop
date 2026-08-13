---
name: test-business-rules
description: Design and run focused tests for CaratForUs financial, Group Buy, refund, and evidence business rules.
---

# Test Business Rules

Use this for pricing, Group Buy, refund, custom-approval, and transaction-evidence work.

1. Read the exact approved rules in `README.md`.
2. Identify invariants and boundary conditions before writing tests.
3. Cover at minimum where relevant:
   - tier threshold exactly below/at/above boundary;
   - multiple quantities and different configurations;
   - cancellation before close and tier rollback;
   - campaign close locking the final tier;
   - current costs changing without altering frozen campaign commitments;
   - exact ring-size cost vs customer-facing pricing band behavior;
   - money rounding at each defined boundary;
   - minimum-margin/minimum-profit validation;
   - duplicate webhook/event delivery;
   - refund calculation, retry, failure, and idempotency;
   - immutable order/policy/custom-approval snapshots;
   - required acknowledgment cannot be bypassed in the intended flow.
4. Prefer deterministic tests with explicit expected values.
5. Add regression tests for every confirmed bug in these domains.
6. Run the relevant test suite and report the exact commands and results.

Do not substitute mocks for core arithmetic/business-rule tests when pure functions or deterministic domain tests are possible.