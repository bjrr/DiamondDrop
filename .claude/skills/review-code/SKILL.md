---
name: review-code
description: Review CaratForUs changes for requirement compliance, financial correctness, security, and regression risk.
---

# Review Code

1. Read `CLAUDE.md`, relevant `README.md` requirements, and the full diff.
2. Review requirement compliance before style.
3. Treat money, Group Buy, refund, webhook, custom-approval, and evidence code as high risk.
4. Check for:
   - incorrect money representation or rounding;
   - historical campaign data being recalculated from current costs;
   - tier threshold or qualifying-unit mistakes;
   - duplicate-event/idempotency issues;
   - missing authorization or secret/PII exposure;
   - client-side logic being treated as authoritative pricing;
   - missing policy/acknowledgment evidence;
   - Shopify-native functionality unnecessarily reimplemented;
   - accessibility regressions;
   - Post-MVP scope creep.
5. Inspect tests for meaningful boundary and failure cases rather than only happy paths.
6. Report findings by severity: blocker, high, medium, low.
7. For each finding, identify the affected area, business impact, and a concrete fix.
8. If there are no meaningful issues, say so and list the validation reviewed.