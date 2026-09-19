# CaratForUs — Claude Code Project Instructions

## Mission
Build CaratForUs MVP1 as a lean Shopify-centered jewelry commerce business with three purchase paths: Buy Now, Group Buy, and Custom Jewelry, plus the Luxury Steals limited-availability merchandising program.

## Source of truth
- Read `README.md` for approved business/product requirements, then read every applicable locked policy under `docs/` before implementing the relevant domain.
- `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` is authoritative for Buy Now discretionary returns, RMA windows, customer-paid tracked/insured return shipping, outbound-shipping treatment, remedies and dispute evidence.
- `docs/LUXURY-STEALS.md` is authoritative for Luxury Steals inventory/scarcity, Final Sale, acknowledgment, claim/warranty separation and evidence.
- `docs/LET-US-BEAT-YOUR-QUOTE.md` plus `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md` govern competitor submissions. **The amendment controls any conflict:** only qualifying verified recent custom quotes receive the guarantee/fallback; active online listings and competing Group Buys are review-only with no guarantee/fallback; fallback expires 90 calendar days after issuance.
- `docs/WARRANTY-CLAIMS.md` is authoritative for the 1-year limited manufacturing warranty claim workflow, customer-paid tracked/insured inbound warranty shipping, inspection, remedy selection and internal-only local-jeweler option.
- `docs/CASH-CARD-PRICING.md` is authoritative for cash-first pricing, the derived +5% card price, cash-equivalent methods, Group Buy cash/card treatment, and customer-facing price display.
- Locked policy documents override conflicting README summaries, assumptions and generic ecommerce conventions.
- Do not silently change a locked business decision. Flag conflicts for owner approval.
- Build MVP1 only unless explicitly asked to work on backlog/Post-MVP functionality.

## Engineering principles
1. Prefer native Shopify capabilities for commodity commerce: storefront primitives, cart, checkout, orders, customer accounts, payments, and standard commerce behavior.
2. Custom-build only CaratForUs-specific logic or UX that Shopify cannot reasonably provide.
3. Keep architecture inexpensive, understandable and maintainable for a low-margin startup.
4. Avoid premature microservices, headless commerce, complex event infrastructure and unnecessary SaaS dependencies.
5. Financial calculations must be deterministic, auditable, versioned where required and protected by tests.
6. Never use floating-point arithmetic for money. Use integer minor units or appropriate decimal/money representation.
7. Group Buy campaign prices/cost assumptions freeze when campaign opens as specified in README.md.
8. Buy Now pricing may update from current costs according to approved rules.
9. Preserve transaction evidence and material acknowledgments required by README and locked policies.
10. Never expose secrets, supplier-private cost data, admin-only margins or credentials to storefront clients.
11. **Cash-first pricing is mandatory.** Markup, gross-margin/minimum-profit floors, Group Buy tiers, overrides, recalculation, campaign freezes and refund economics operate on the authoritative cash-equivalent price. Only after that price is final may the card price be derived as cash × the versioned card-uplift rate (MVP1 5%).
12. **Customer display is card-first.** Publish/show the derived credit-card price as the primary price and show the cash-equivalent price as the discounted price for ACH, wire, Zelle or check. Do not describe the cash discount as a fixed 5% percentage. PayPal/Venmo are not in the locked cash-equivalent list.
13. Card-processing expense must not be folded into the current cash gross-margin or $100 minimum-profit floors unless a later explicit owner decision changes `docs/CASH-CARD-PRICING.md`.

## Architect-led development model
The Tech Lead is the Principal Architect and should reserve the top-tier model for architecture, decomposition, ambiguity, cross-domain integration, high-risk policy/financial review, and final technical approval.

Routine implementation should be delegated to lower-cost specialized agents whenever the task is sufficiently specified:
- Tech Lead / Principal Architect — `opus`
- Shopify Developer — `sonnet`
- Backend & Pricing Engineer — `sonnet`
- Frontend & UX Engineer — `sonnet`
- Test Engineer — `haiku`
- QA & Security Reviewer — `sonnet`

Do not use the architect for repetitive implementation when a bounded specialist task can be safely delegated. Escalate model tier only when complexity, ambiguity, failed attempts, or risk warrants it.

## Required development process
For non-trivial work:
1. Read relevant README requirements and applicable locked policy documents.
2. Inspect existing implementation.
3. Use `/feature-spec` to create explicit acceptance criteria, native-vs-custom boundaries, tests, and agent ownership.
4. Delegate implementation to the smallest appropriate specialist agent.
5. Require the specialist to use the relevant implementation skill (`/backend-feature`, `/frontend-feature`, `/shopify-integration`, or `/implement-feature`).
6. Delegate deterministic automated test work to the Test Engineer where appropriate using `/test-business-rules` and/or `/integration-test`.
7. Run relevant lint/typecheck/tests/build.
8. Use `/review-code` and `/security-review` where applicable.
9. Require `/handoff` from every delegated task.
10. Have the architect inspect high-risk diffs/evidence before acceptance.
11. Use `/ship-feature` as the final release gate.

Do not claim tests passed unless actually run successfully.

## Git discipline
- Keep changes focused; do not rewrite unrelated files.
- No force-push, branch deletion, shared reset or destructive operations without owner approval.
- Never commit secrets or `.env` values.
- Use descriptive commits/branches when requested.
- Coordinate agent file/domain ownership to avoid simultaneous conflicting edits.

## Architecture ownership
The Tech Lead owns cross-cutting architecture. Domain agents may recommend changes but must not independently introduce major frameworks, databases, payment approaches or Shopify architecture changes.

Before broad scaffolding or major cross-domain changes, use `/plan-architecture` followed by `/architecture-review` and obtain owner approval when required.

## Critical domains
Require tests/review for:
- money, metal/gem cost calculations, variant weights and ring-size bands;
- Group Buy tiers, qualifying units, freeze/close, cancellations, final-price/refund calculations;
- Buy Now RMA windows, receipt deadlines, customer-paid tracked/insured return shipping, restocking/refund/credit calculations;
- Luxury Steals inventory, sold-out behavior, Final Sale enforcement and acknowledgment evidence;
- warranty claim intake, authorization, customer-paid tracked/insured inbound shipping, inspection, repair/replacement/refund remedy and local-jeweler authorization records;
- return/refund/warranty/dispute audit history;
- Let Us Beat Your Quote recent-custom-quote eligibility, online-listing/Group-Buy review-only treatment, 90-day fallback expiration and duplicate-benefit prevention;
- competitor authenticity/comparability evidence;
- Shopify webhook idempotency/authenticity;
- custom-design approval evidence;
- policy/acknowledgment versioning;
- authentication/authorization/admin-only data.

## Product boundaries
### Buy Now
Use current calculated pricing and native Shopify purchasing wherever practical. The authoritative calculated price is cash-equivalent; derive the customer-facing card price afterward under `docs/CASH-CARD-PRICING.md`. Implement discretionary returns/RMA exactly per `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`.

### Luxury Steals
Built on normal Shopify Buy Now checkout/inventory wherever practical. **All Luxury Steals are Final Sale: no discretionary returns, exchanges, cash refunds or merchandise-credit returns.** Follow `docs/LUXURY-STEALS.md`; Final Sale must not automatically deny legitimate covered claims.

### Group Buy
Custom CaratForUs functionality. Freeze the campaign **cash** base price, apply/validate tier multipliers against cash floors, then derive the card price for display. Customer-facing Group Buy display is card-first with the discounted cash-equivalent price alongside it. Implement configurable tiers, unit qualification, selected-variant pricing, progress, cancellation-before-close, final-price determination, refund ledger and evidence per README and `docs/CASH-CARD-PRICING.md`.

### Custom Jewelry / Let Us Beat Your Quote
MVP1 consultation/revisions remain email-driven. Provide lightweight intake, $49 Design Deposit, reusable Shopify approval/purchase template and quote-acquisition flow. Read both quote documents; the amendment controls conflicts. Review remains manual; automate intake/evidence/eligibility calculations/acknowledgments/status but never auto-commit CaratForUs to competitor pricing.

### Warranty
Provide a dedicated Warranty Claim Form and auditable claim workflow per `docs/WARRANTY-CLAIMS.md`. Customer pays tracked, appropriately insured inbound shipping after authorization for inspection. CaratForUs determines repair, replacement, refund or other appropriate remedy after inspection. The possible local-jeweler repair path is internal-only until CaratForUs selects/authorizes it for a specific claim; do not advertise it as a customer entitlement.

## Customer experience
- Mobile-first and accessible.
- Keep friction low except where explicit acknowledgment is materially required.
- Never hide material final-sale, cancellation, pricing, return, shipping, warranty, RMA, Luxury Steals or quote eligibility terms.
- Required acknowledgments must be explicit, unambiguous, versioned and retained; never pre-check or silently infer acceptance.
- Clearly label CAD renders, actual photos/videos and AI visualizations per requirements.

## Security and privacy
- Validate server-side inputs.
- Verify Shopify webhook authenticity and make event processing idempotent.
- Least-privilege Shopify/API scopes.
- Minimize PII.
- Log important business events without secrets/unnecessary sensitive payment data.
- Never collect/store raw card data beyond approved platform exposure.

## Team
Project agents live under `.claude/agents/`:
- `tech-lead.md` — principal architect / final technical approval
- `shopify-developer.md` — Shopify/theme/integration implementation
- `backend-pricing-engineer.md` — backend/domain/pricing implementation
- `frontend-ux-engineer.md` — storefront/UI implementation
- `test-engineer.md` — lower-cost deterministic automated test implementation
- `qa-security-reviewer.md` — independent QA/security review

Reusable workflows live under `.claude/skills/`, including architecture, feature-specification, backend/frontend/Shopify implementation, business-rule testing, integration testing, security review, code review, structured handoff, and release validation.

## Initial state
This repository begins essentially from requirements, not an established application. Before broad scaffolding, the Tech Lead must propose the lean Shopify-centered architecture, native-vs-custom boundaries, persistence model, deployment approach, local tooling, required credentials/environment variables and phased MVP implementation plan for owner approval.

Do not begin a large scaffold simply because the repository is empty.