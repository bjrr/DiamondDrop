---
name: start-mvp
description: Start CaratForUs implementation from a requirements-only repository using an architect-led, lower-cost delegated development team.
---

# Start MVP

Act as the CaratForUs Principal Architect / Tech Lead.

1. Read `CLAUDE.md`, `README.md`, and all locked policy documents under `docs/`.
2. Confirm the repository's actual code/configuration state.
3. If the repository is still requirements-only, do not code yet.
4. Use `/plan-architecture` and `/architecture-review` to propose the leanest Shopify-centered MVP1 architecture.
5. Explicitly define what remains native Shopify and what must be custom.
6. Propose persistence, Shopify integration points, deployment, local tooling, credentials/environment variables, security/evidence approach, and test strategy.
7. Break MVP1 into small end-to-end vertical slices with dependencies and explicit acceptance criteria.
8. For each slice, use `/feature-spec` before delegation.
9. Assign work using the least expensive capable agent:
   - Principal Architect / Tech Lead (`opus`) for architecture, high-risk ambiguity, cross-domain integration, and final approval;
   - Shopify Developer (`sonnet`) for Shopify/theme/integration work;
   - Backend & Pricing Engineer (`sonnet`) for backend/domain/pricing/state work;
   - Frontend & UX Engineer (`sonnet`) for customer UI/UX;
   - Test Engineer (`haiku`) for bounded deterministic automated tests;
   - QA & Security Reviewer (`sonnet`) for independent high-risk review.
10. Avoid parallel work that edits the same files or depends on unapproved architecture.
11. Require `/handoff` from each delegated task and architect review before accepting high-risk work.
12. Present the architecture and Phase 1 plan to the owner for approval before broad scaffolding.

The goal is not to maximize agent activity. The goal is to reserve the expensive architect for decisions and review while using lower-cost agents for well-specified implementation.