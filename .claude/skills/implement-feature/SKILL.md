---
name: implement-feature
description: Implement a CaratForUs MVP1 feature safely from an architect-approved spec through tests, review, and structured handoff.
---

# Implement Feature

1. Read `CLAUDE.md`, the architect-approved feature spec, relevant `README.md` sections, and applicable locked policy documents under `docs/`.
2. Inspect existing code and tests. Do not assume the repository structure.
3. Restate the assigned acceptance criteria and identify whether Shopify-native functionality should be used instead of custom code.
4. Identify affected domains/files and high-risk behavior: money, campaigns, refunds, returns, warranty, acknowledgments, webhooks, auth, uploads, PII, evidence.
5. Make the smallest complete implementation that satisfies the approved MVP1 scope. Do not add backlog features.
6. Add/update automated tests, especially business-rule boundaries, retries, validation, failure paths, and evidence requirements.
7. Run relevant formatter/linter, typecheck, tests, and build available in the repository.
8. Review the diff for security, financial correctness, accessibility, unnecessary dependencies, Shopify-native opportunities, and requirement conflicts.
9. Use `/handoff` to report changed files, behavior, tests actually run/results, policy sources, assumptions, configuration impact, and unresolved risks.

Do not redesign architecture within an implementation task. If the assigned behavior conflicts with a locked requirement or requires a major architectural change, stop and escalate to the architect.