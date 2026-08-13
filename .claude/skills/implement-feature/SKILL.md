---
name: implement-feature
description: Implement a CaratForUs MVP1 feature safely from approved README requirements through tests and review.
---

# Implement Feature

1. Read `CLAUDE.md` and locate the exact relevant requirements in `README.md`.
2. Inspect existing code and tests. Do not assume the repository structure.
3. Restate the feature's acceptance criteria and identify whether Shopify-native functionality should be used instead of custom code.
4. Identify affected domains/files and high-risk behavior (money, campaigns, refunds, acknowledgments, webhooks, auth).
5. Make the smallest complete implementation that satisfies MVP1. Do not add backlog features.
6. Add or update automated tests, especially for business rules and failure/boundary cases.
7. Run the relevant formatter/linter, typecheck, tests, and build available in the repository.
8. Review the diff for security, financial correctness, accessibility, unnecessary dependencies, and README conflicts.
9. Report changed files, behavior, tests actually run, results, and unresolved risks.

If the requested behavior conflicts with a locked README decision, stop and ask for owner resolution rather than silently choosing one.