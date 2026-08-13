---
name: plan-architecture
description: Plan CaratForUs architecture before scaffolding or major cross-cutting changes.
---

# Plan Architecture

Use this before initial scaffolding or any major architecture change.

1. Read `CLAUDE.md` and all relevant `README.md` requirements.
2. Separate responsibilities into:
   - native Shopify;
   - Shopify theme/extensions/configuration;
   - custom application/backend;
   - persistence/database;
   - third-party services that are truly necessary.
3. Optimize for MVP1 cost, simplicity, maintainability, and owner operability.
4. Provide:
   - recommended stack and alternatives considered;
   - native-vs-custom responsibility matrix;
   - data model/core entities;
   - Shopify APIs/webhooks/metafields/metaobjects needed;
   - deployment and local-development approach;
   - environment variables/credentials required;
   - testing strategy;
   - phased implementation milestones;
   - recurring-cost implications;
   - security and data-retention considerations;
   - unresolved decisions requiring owner approval.
5. Explicitly explain why any major dependency/framework is needed.
6. Do not scaffold or make broad code changes until the owner approves the architecture when approval was requested first.
7. Do not include Post-MVP features merely because they would make the architecture more elegant.