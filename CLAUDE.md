# CaratForUs — Claude Code Project Instructions

## Mission
Build CaratForUs MVP1 as a lean Shopify-centered jewelry commerce business with three purchase paths: Buy Now, Group Buy, and Custom Jewelry, plus the Luxury Steals limited-availability merchandising program.

## Source of truth
- Read `README.md` for approved business/product requirements, then read every applicable locked policy under `docs/` before implementing the relevant domain.
- `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` is authoritative for Buy Now discretionary returns, RMA windows, customer-paid tracked/insured return shipping, outbound-shipping treatment, remedies and dispute evidence.
- `docs/LUXURY-STEALS.md` is authoritative for Luxury Steals inventory/scarcity, Final Sale, acknowledgment, claim/warranty separation and evidence.
- `docs/LET-US-BEAT-YOUR-QUOTE.md` plus `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md` govern competitor submissions. **The amendment controls any conflict:** only qualifying verified recent custom quotes receive the guarantee/fallback; active online listings and competing Group Buys are review-only with no guarantee/fallback; fallback expires 90 calendar days after issuance.
- `docs/WARRANTY-CLAIMS.md` is authoritative for the 1-year limited manufacturing warranty claim workflow, customer-paid tracked/insured inbound warranty shipping, inspection, remedy selection and internal-only local-jeweler option.
- `docs/BANK-CARD-PRICING.md` is authoritative for Bank Payment Price vs Regular/Card Price behavior, tiered card-price increases, $5 card-price rounding, eligible bank-payment methods, checkout treatment, and customer-facing savings. `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` is authoritative for the post-Slice-1 display, recalculation-failure, Group Buy payment-selection, and campaign-options JSON decisions. `docs/CASH-CARD-PRICING.md` is superseded history only.
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
11. **Bank Payment Price is the authoritative underlying selling price.** The existing pricing engine produces it; the bank-vs-card feature must not discount, increase, or round it. Markup, gross-margin/minimum-profit floors, Group Buy tiers, overrides, recalculation, campaign freezes and refund economics continue from that underlying value unless a separate locked rule says otherwise.
12. **Regular/Card Price is derived afterward from Bank Payment Price.** Select the card-pricing tier from Bank Payment Price only: < $500 +5.0%; $500–$999.99 +4.5%; $1,000–$2,499.99 +4.0%; $2,500–$4,999.99 +3.5%; $5,000+ +3.0%. Then round only the Regular/Card Price UP to the next $5 increment. The increase must never be below 3%.
13. **Customer price display is surface-specific.** Buy Now collection/search discovery leads with the lowest currently purchasable **Bank Payment Price** as "As low as $X"; the detailed product page and cart show the exact Regular/Card Price and Bank Payment Price for the selected configuration. Group Buy defaults to one visible Regular/Card Price with a note that lower pricing is available with Bank Payment, then requires an explicit Payment Type selection before ordering. Never display the internal percentage or wording such as card fee/surcharge/cash discount.
14. **Eligible Bank Payment methods are electronic only:** Zelle, ACH, bank transfer and wire. No personal, cashier's or certified checks, money orders, or other paper payments.
15. **Bank Payment savings are merchandise-only.** Do not include tax, shipping, duties or other non-merchandise charges in the savings figure.
16. **Pricing-failure safety.** A Buy Now recalculation failure keeps the last valid price live for at most 48 hours while admin is notified immediately; the first unresolved failure starts the timer. At 48 hours, only the affected variant becomes unavailable. A successful corrected recalculation restores it automatically. Open Group Buy pricing remains governed by the frozen campaign snapshot.
17. **Sync-failure safety.** If a valid approved price cannot be published to Shopify, the currently published Shopify price remains authoritative and sellable for up to 48 hours while retrying. Notify through email + persistent embedded-admin alert. Never mark `synced` before Shopify confirms success. After 48 hours unresolved, only the affected variant becomes unavailable; restore automatically on successful sync.
18. **Auto-publication.** After the real Shopify sync path passes money-critical integration tests, Bank Payment Price changes <=2% may auto-publish; >2% requires human approval. Common-input events may be bulk-approved. Bulk reject is forbidden; rejection is per item/variant and requires an explicit override price and reason.
19. **Overrides.** Manual price overrides expire on the next material pricing recalculation unless explicitly marked **Never Expire**.
20. **Cart/payment mode is money-critical.** One cart has one mode (Card or Bank Payment). Bank Payment itself is always allowed; the lower Bank Payment Price is controlled by per-product/variant **Bank Payment Discount Eligible** (default ON). Switching modes must reprice all eligible lines exactly and must be protected by enhanced unit/integration/tamper/regression tests.
21. **Buy Now actions.** PDP buttons are **Add to Cart** and **Add to Cart with Bank Payment Discount**. The latter switches the entire cart to Bank Payment mode. Normal Add to Cart preserves the current cart mode. Cart presents Card Checkout and Bank Payment Checkout. Buy Now and Group Buy must not share one cart/order.
22. **Buy Now Bank Payment commitment.** Bank Payment Price is guaranteed 24 hours. After 24 hours, an unpaid order stays open only while price is unchanged; any price change cancels it and sends cancellation email. Inventory is not reserved until manual admin verification of received funds. Checkout + confirmation email must state that order/availability is not guaranteed until payment is received and verified.

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
- Group Buy tiers, monotonic public progress, pending-bank-payment counting, freeze/close, cancellations, final-price/refund calculations;
- cart payment-mode switching, Bank Payment Discount eligibility, checkout-basis enforcement, and client-price tamper resistance;
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
Use current calculated pricing and native Shopify purchasing wherever practical. The authoritative calculated selling price is the Bank Payment Price. Derive the customer-facing Regular/Card Price afterward under `docs/BANK-CARD-PRICING.md`, using the Bank Payment Price to select the tier and rounding only the card price up to the next $5. Implement discretionary returns/RMA exactly per `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`.

### Luxury Steals
Built on normal Shopify Buy Now checkout/inventory wherever practical. **All Luxury Steals are Final Sale: no discretionary returns, exchanges, cash refunds or merchandise-credit returns.** Follow `docs/LUXURY-STEALS.md`; Final Sale must not automatically deny legitimate covered claims.

### Group Buy
Custom CaratForUs functionality. Freeze the campaign **Bank Payment Price** base, apply/validate Group Buy tier multipliers against the underlying pricing floors, then derive the Regular/Card Price using `docs/BANK-CARD-PRICING.md`.

Customer-facing Group Buy presentation is intentionally different from Buy Now: public/options-table prices are Regular/Card prices, with a note that lower Bank Payment pricing is available. After product options are chosen, Payment Type is required before ordering; Bank Payment changes the active displayed price to the Bank Payment Price, Card leaves it at Regular/Card Price. Do not show both prices side-by-side by default in the Group Buy table.

A placed Group Buy order counts toward public progress immediately, including pending Bank Payment orders. Public count and unlocked tier are **monotonic**: later nonpayment/cancellation never reduces the displayed count or rolls back a tier. Bank Payment gets 48 hours plus one automatic 48-hour extension. After 96 hours an unpaid order may become inactive internally; while campaign remains open, email-requested reactivation uses the same order and original locked price. At close, settlement uses the final unlocked tier and original payment basis; system calculates refunds, admin explicitly approves/processes them.

Group Buy option dimensions are campaign-specific and must not be hard-coded around rings. Preserve a seam for a versioned JSON campaign-options format; the formal JSON Schema is deferred until the Group Buy campaign creation/upload tool (expected Slice 6). Refunds must remain payment-basis aware. Implement configurable tiers, monotonic progress, selected-variant pricing, close settlement, refund ledger and evidence per README.

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