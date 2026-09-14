---
name: handoff
description: Standardize concise handoffs from implementation/test agents back to the CaratForUs architect.
---

# Handoff

Use at the end of every delegated task.

Return exactly these sections when applicable:

## Scope Completed
One short paragraph describing what was implemented/reviewed and what was intentionally not included.

## Files Changed
List only files actually changed.

## Behavior
Describe the resulting customer/system behavior in concrete terms.

## Validation
List exact commands/checks/tests actually run and their results. Do not claim unrun validation.

## Policy / Requirements Used
List the authoritative README/docs/feature-spec sources used.

## Data / Shopify / Configuration Impact
Call out migrations, metafields/metaobjects, webhooks, API scopes, env vars, manual Shopify setup, or deployment changes.

## Assumptions
List assumptions made that were not explicitly specified.

## Risks / Unresolved Items
List anything incomplete, unverified, blocked, or requiring owner/architect decision.

## Architect Review Requested
Call out the specific areas the architect should inspect before accepting the work.

Keep the handoff concise. Do not paste large diffs or restate the entire feature spec.