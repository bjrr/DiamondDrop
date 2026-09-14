---
name: test-business-rules
description: Design and run focused tests for CaratForUs pricing, Group Buy, returns, Luxury Steals, quote-match, warranty, and evidence rules.
---

# Test Business Rules

Use this for high-risk CaratForUs domain behavior.

1. Read `CLAUDE.md`, the feature spec, relevant `README.md`, and every applicable locked policy under `docs/`.
2. Identify invariants, exact expected outcomes, and boundary conditions before writing tests.
3. Cover, where relevant:
   - tier threshold exactly below/at/above boundary;
   - multiple quantities and different configurations;
   - cancellation before close and tier rollback;
   - campaign close locking final tier/pricing;
   - current costs changing without altering frozen campaign commitments;
   - exact ring-size cost vs customer-facing pricing-band behavior;
   - money rounding and minimum margin/profit floors;
   - duplicate webhook/event delivery and retries;
   - refund/credit calculation, failure, retry, and idempotency;
   - Buy Now RMA Day 7/8/30/31 and receipt-deadline boundaries;
   - customer-paid tracked/insured discretionary return shipping requirements;
   - Luxury Steals Final Sale and separate legitimate claim routing;
   - recent custom quote Day 7 vs Day 8 guarantee eligibility;
   - active online listing and competing Group Buy review-only/no-fallback behavior;
   - 90-day fallback expiration and duplicate-benefit prevention;
   - warranty claim submission vs inspection authorization vs covered-claim decision;
   - customer-paid tracked/insured warranty inbound shipping;
   - internal-only local-jeweler path not exposed as entitlement;
   - immutable order/policy/custom-approval snapshots;
   - required acknowledgments cannot be bypassed and evidence is retained.
4. Prefer deterministic tests with explicit expected values/dates/counts.
5. Add a regression test for every confirmed bug in these domains.
6. Run the relevant test suite and report exact commands and results.
7. If policy sources conflict or expected behavior is ambiguous, stop and escalate instead of guessing.

Do not substitute mocks for core arithmetic/business-rule tests when pure functions or deterministic domain tests are possible.