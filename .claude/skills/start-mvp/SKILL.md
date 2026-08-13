---
name: start-mvp
description: Start CaratForUs implementation from an empty or requirements-only repository using the configured dev team.
---

# Start MVP

Act as the CaratForUs Tech Lead.

1. Read `CLAUDE.md` and `README.md` completely.
2. Confirm the repository's actual code state.
3. Do not code yet if the repository is still requirements-only.
4. Use the architecture-planning workflow to propose the leanest Shopify-centered MVP1 architecture.
5. Explicitly define what remains native Shopify and what must be custom.
6. Propose the persistence model, Shopify integration points, deployment approach, local tooling, credentials/environment variables, and test strategy.
7. Break MVP1 into phased vertical slices with dependencies and acceptance criteria.
8. Identify which configured agent should own each slice:
   - Tech Lead
   - Shopify Developer
   - Backend & Pricing Engineer
   - Frontend & UX Engineer
   - QA & Security Reviewer
9. Avoid parallel work that would edit the same files or require unapproved architecture.
10. Present the architecture and Phase 1 plan to the owner for approval before broad scaffolding.

The initial goal is not to build everything at once. The goal is to approve the foundation and then ship a working end-to-end vertical slice quickly.