---
name: review-code
description: Review CaratForUs changes against architect-approved specs, locked policies, financial correctness, security, accessibility, and regression risk.
---

# Review Code

1. Read `CLAUDE.md`, the architect-approved feature spec, relevant `README.md`, applicable locked policy documents, and the full diff.
2. Review requirement/policy compliance before style.
3. Treat money, Group Buy, returns/RMA, Luxury Steals, quote-match, warranty claims, webhooks, custom approvals, and evidence code as high risk.
4. Check for:
   - incorrect money representation or rounding;
   - historical campaign data recalculated from current costs;
   - tier threshold or qualifying-unit mistakes;
   - duplicate-event/idempotency issues;
   - missing authorization or secret/PII/private-cost exposure;
   - client-side logic treated as authoritative pricing/eligibility;
   - missing policy/acknowledgment/evidence retention;
   - stale customer-facing policy text;
   - Shopify-native functionality unnecessarily reimplemented;
   - accessibility regressions;
   - unsafe upload/input handling;
   - accidental Post-MVP scope creep or unnecessary dependency growth.
5. Inspect tests for meaningful boundaries/failures/retries rather than only happy paths.
6. Check the implementation against current authoritative docs, not historical assumptions.
7. Report findings by severity: blocker, high, medium, low.
8. For each finding identify affected area, business/security impact, and concrete fix.
9. If there are no meaningful issues, say so and list the validation/evidence reviewed.
10. Use `/handoff` format for the architect-facing conclusion.