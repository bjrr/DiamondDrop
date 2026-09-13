# CaratForUs — Claude Code Project Instructions

## Mission
Build CaratForUs MVP1 as a lean Shopify-centered jewelry commerce business with three purchase paths: Buy Now, Group Buy, and Custom Jewelry, plus the Luxury Steals limited-availability merchandising program.

## Source of truth
- Read `README.md` before planning or implementing product behavior. It contains the approved business and product requirements.
- Also read any locked policy documents under `docs/` that apply to the feature being built.
- `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` is the authoritative specification for Buy Now returns, RMA handling, late-return remedies, and dispute-evidence requirements. If it conflicts with an older Buy Now return-policy summary in `README.md`, the policy document controls.
- `docs/LET-US-BEAT-YOUR-QUOTE.md` is the authoritative MVP1 specification for competitor custom-quote, live online-item, and competing Group Buy submissions; quote-age eligibility; match/beat and fallback rules; verification; service-term comparisons; and required customer acknowledgments.
- `docs/LUXURY-STEALS.md` is the authoritative MVP1 specification for the Luxury Steals limited-availability sale section, inventory/scarcity behavior, special discretionary-return remedy, customer disclosures/acknowledgments, and evidence requirements.
- Locked policy documents and `README.md` business rules override assumptions, generic ecommerce conventions, and speculative enhancements.
- Do not silently change a locked business decision. Flag conflicts for owner approval.
- Build MVP1 only unless explicitly asked to work on backlog/Post-MVP functionality.

## Engineering principles
1. Prefer native Shopify capabilities for commodity commerce: storefront primitives, cart, checkout, orders, customer accounts, payments, and standard commerce behavior.
2. Custom-build only CaratForUs-specific logic or UX that Shopify cannot reasonably provide.
3. Keep the architecture inexpensive, understandable, maintainable, and appropriate for a low-margin startup.
4. Avoid premature microservices, headless commerce, complex event infrastructure, and unnecessary SaaS dependencies.
5. Financial calculations must be deterministic, auditable, versioned where required, and protected by tests.
6. Never use floating-point arithmetic for money. Use integer minor units or an appropriate decimal/money representation.
7. Group Buy campaign prices and their cost assumptions freeze when the campaign opens as specified in README.md.
8. Buy Now pricing may update from current costs according to the approved pricing rules.
9. Preserve transaction evidence and material customer acknowledgments required by README.md and applicable locked policy documents.
10. Never expose secrets, supplier-private cost data, admin-only margins, or credentials to storefront clients.

## Required development process
For non-trivial work:
1. Read the relevant README requirements and any applicable locked policy document under `docs/`.
2. Inspect existing implementation before proposing changes.
3. State a concise implementation plan and acceptance criteria.
4. Implement the smallest complete vertical slice.
5. Add/update automated tests for business-critical behavior.
6. Run relevant lint/typecheck/tests/build.
7. Review the diff for regressions, security, money/math errors, and accidental Post-MVP scope.
8. Summarize what changed, validation performed, and unresolved risks.

Do not claim tests passed unless they were actually run successfully.

## Git discipline
- Keep changes focused.
- Do not rewrite unrelated files.
- Do not force-push, delete branches, reset shared work, or perform destructive Git operations without explicit owner approval.
- Never commit secrets or `.env` values.
- Use descriptive commits and branches when requested.
- When multiple agents work concurrently, assign clear file/domain ownership and avoid editing the same files simultaneously.

## Architecture ownership
The Tech Lead owns cross-cutting architecture. Domain agents may recommend architecture changes but should not independently introduce major frameworks, databases, payment approaches, or Shopify architecture changes.

## Critical domains
Treat these as high-risk and require tests/review:
- money and price calculations
- precious-metal and gemstone cost calculations
- variant weights and ring-size pricing bands
- Group Buy tiers and qualifying-unit counts
- campaign freeze/close behavior
- cancellations and tier rollback before close
- final-price/refund calculations
- Buy Now RMA eligibility windows, receipt deadlines, restocking-fee calculations, and merchandise-credit issuance
- Luxury Steals inventory depletion, sold-out behavior, discretionary merchandise-credit handling, and special acknowledgment evidence
- return/refund/dispute audit history
- Let Us Beat Your Quote eligibility, 7-day quote-age calculation, live-listing verification, competing Group Buy treatment, and 10%-off fallback issuance
- competitor-offer authenticity/comparability review and evidence retention
- quote-match acknowledgment/version evidence and duplicate-benefit prevention
- Shopify order/webhook idempotency
- custom-design approval evidence
- policy/acknowledgment versioning
- refunds/payment processor references
- authentication/authorization and admin-only data

## Product boundaries
### Buy Now
Use current calculated pricing and native Shopify purchasing wherever practical. Preserve the applicable transaction snapshot and policies. Implement discretionary returns and RMA behavior exactly as defined in `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`.

### Luxury Steals
Luxury Steals is an MVP1 limited-availability, extreme-value merchandising program built on normal Shopify Buy Now checkout/inventory wherever practical. Implement inventory scarcity, sold-out behavior, special discretionary merchandise-credit-only return treatment, material disclosures, required acknowledgment evidence, and claim/warranty separation exactly as defined in `docs/LUXURY-STEALS.md`. Do not silently apply standard Buy Now discretionary-return rules to a Luxury Steal transaction.

### Group Buy
This is custom CaratForUs functionality. Implement frozen campaign pricing, configurable tiers, unit-based qualification, selected-variant pricing, campaign progress, cancellation-before-close behavior, final-price determination, refund ledger, and evidence requirements exactly as specified in README.md.

### Custom Jewelry
MVP1 is email-driven for consultation/revisions. The site provides the lightweight intake form, $49 Design Deposit workflow, reusable Shopify custom approval/purchase template, and the **Let Us Beat Your Quote!** acquisition flow defined in `docs/LET-US-BEAT-YOUR-QUOTE.md`. Do not build the Post-MVP customer project portal. Quote-match review remains manual in MVP1; automate intake, evidence capture, eligibility calculations, acknowledgment storage, and workflow status where practical, but do not auto-commit CaratForUs to a competitor price.

## Customer experience
- Mobile-first and accessible.
- Keep forms and checkout friction low except where explicit acknowledgment is materially required.
- Never hide material final-sale, cancellation, pricing, return, restocking, warranty, RMA, Luxury Steals, quote-match eligibility, or guarantee terms.
- Required Luxury Steals and quote-match acknowledgments must be explicit, unambiguous, versioned, and retained as evidence; do not pre-check or silently infer agreement.
- Clearly label CAD renders, actual photos/videos, and AI visualizations according to README.md.

## Security and privacy
- Validate all server-side inputs.
- Verify Shopify webhook authenticity using the supported mechanism.
- Make webhook/event processing idempotent.
- Apply least privilege to Shopify/API scopes.
- Keep PII collection to what the feature actually requires.
- Log important business events without logging secrets or unnecessary sensitive payment data.
- Do not collect or store raw payment-card data beyond what the approved payment platform exposes and permits.

## Team
Project agent definitions live under `.claude/agents/`:
- `tech-lead.md`
- `shopify-developer.md`
- `backend-pricing-engineer.md`
- `frontend-ux-engineer.md`
- `qa-security-reviewer.md`

Reusable workflows live under `.claude/skills/`.

## Initial state
This repository begins essentially from requirements, not an established application. Before scaffolding, the Tech Lead must propose the lean Shopify-centered architecture, Shopify/native-vs-custom boundaries, persistence model, deployment approach, local tooling, required credentials/environment variables, and phased MVP implementation plan for owner approval.

Do not begin a large scaffold simply because the repository is empty.