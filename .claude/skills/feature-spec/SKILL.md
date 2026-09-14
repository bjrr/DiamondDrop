---
name: feature-spec
description: Convert an approved CaratForUs business requirement into an implementation-ready feature specification for delegated agents.
---

# Feature Spec

Use this before delegating non-trivial implementation.

1. Read `CLAUDE.md`, relevant `README.md` sections, and every applicable locked policy under `docs/`.
2. State the customer/business outcome in one paragraph.
3. Define explicit acceptance criteria, including boundary/failure cases.
4. Identify the authoritative policy source for every high-risk rule.
5. Define native Shopify vs custom responsibilities.
6. Identify affected domains, data/entities, APIs/webhooks, metafields/metaobjects, files/areas, and migrations/configuration if known.
7. Define evidence/audit records required by the feature.
8. Define security/privacy/access-control requirements.
9. Define accessibility and customer-facing error states.
10. Define required automated tests before coding starts.
11. Define non-goals and Post-MVP exclusions.
12. Assign work to the smallest appropriate agent/model tier and avoid overlapping file ownership.
13. List unresolved owner decisions. If a decision is required for correctness, stop before implementation.

Output a concise implementation brief with:
- Outcome
- Authoritative requirements
- Acceptance criteria
- Native Shopify vs custom boundary
- Data/integration impact
- Security/evidence requirements
- Test plan
- Agent ownership
- Non-goals
- Open decisions

Do not invent policy or silently resolve conflicts.