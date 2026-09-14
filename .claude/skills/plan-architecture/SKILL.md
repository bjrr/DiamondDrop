---
name: plan-architecture
description: Plan CaratForUs architecture before scaffolding or major cross-cutting changes, including delegation/model strategy.
---

# Plan Architecture

Use this before initial scaffolding or any major architecture change.

1. Read `CLAUDE.md`, `README.md`, and all relevant locked policy documents under `docs/`.
2. Inspect the repository's actual current code/configuration state.
3. Separate responsibilities into:
   - native Shopify;
   - Shopify theme/extensions/configuration;
   - custom application/backend;
   - persistence/database;
   - third-party services that are truly necessary.
4. Optimize for MVP1 cost, simplicity, maintainability, owner operability, and testability.
5. Provide:
   - recommended stack and alternatives considered;
   - native-vs-custom responsibility matrix;
   - data model/core entities and versioned evidence records;
   - Shopify APIs/webhooks/metafields/metaobjects needed;
   - deployment and local-development approach;
   - environment variables/credentials required;
   - testing strategy;
   - phased vertical-slice milestones;
   - agent ownership and recommended model tier for each slice;
   - recurring-cost implications;
   - security/privacy/data-retention considerations;
   - migration/rollback considerations;
   - unresolved decisions requiring owner approval.
6. Explicitly explain why any major dependency/framework/service is needed.
7. Prefer native Shopify and a small application surface over headless/microservice complexity.
8. Reserve the top-tier architect model for cross-domain design, high-risk decisions, and final review; delegate bounded implementation to Sonnet/Haiku agents where safe.
9. Do not scaffold or make broad code changes until the owner approves the architecture when approval is required.
10. Do not include Post-MVP features merely because they make the architecture more elegant.

Pair this skill with `/architecture-review` before broad scaffolding.