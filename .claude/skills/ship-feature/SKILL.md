---
name: ship-feature
description: Final validation workflow before committing or opening a PR for a CaratForUs feature.
---

# Ship Feature

Before declaring a feature ready:

1. Confirm the implementation matches the approved `README.md` requirement and no locked decision changed.
2. Ensure tests were added or updated where business behavior changed.
3. Run all relevant formatter, lint, typecheck, test, and build commands available in the project.
4. Review for money/rounding, Group Buy lifecycle, webhook idempotency, authorization, evidence retention, accessibility, and Post-MVP scope creep as applicable.
5. Inspect `git diff` and `git status` for accidental files, secrets, debug output, generated artifacts, or unrelated changes.
6. Ensure environment secrets are represented only by documented variable names/examples, never real credentials.
7. Produce a concise release note containing:
   - user/business behavior delivered;
   - files/areas changed;
   - commands actually run and results;
   - migrations/configuration/manual setup required;
   - known limitations or follow-up work.
8. If validation fails, do not call the feature ready. Fix it or report the blocker.

Prefer a focused commit/PR over bundling unrelated work.