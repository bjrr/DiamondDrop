---
name: architecture-review
description: Review proposed CaratForUs architecture or a major cross-cutting change before implementation, with explicit Shopify-native boundaries, policy compliance, cost, security, and delegation plan.
---

# Architecture Review

Use for initial architecture approval and any major cross-cutting design change.

1. Read `CLAUDE.md`, `README.md`, and all applicable locked policy documents under `docs/`.
2. Inspect the repository's actual current implementation/state.
3. Review the proposal against:
   - Shopify-native vs custom boundaries;
   - MVP1 scope and owner-approved requirements;
   - data model and immutable evidence/versioning needs;
   - financial determinism and auditability;
   - webhook/event idempotency;
   - authentication/authorization/privacy;
   - deployment/operability/recurring cost;
   - testability and rollback/migration risk.
4. Identify unnecessary frameworks, services, microservices, queues, databases, or headless complexity.
5. Identify any locked-policy conflict or unresolved owner decision.
6. Produce a responsibility matrix for Shopify, backend, frontend, persistence, and third parties.
7. Produce a phased vertical-slice plan with acceptance criteria and dependencies.
8. Assign each slice to the least expensive capable agent/model tier; reserve the architect for cross-domain/high-risk review.
9. Explicitly state what the architecture will not build in MVP1.
10. End with one of: APPROVE, APPROVE WITH CONDITIONS, or DO NOT APPROVE, followed by concrete reasons.

Do not write broad scaffolding during architecture review unless the owner has already approved the design.