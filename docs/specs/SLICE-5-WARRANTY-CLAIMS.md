# Slice 5 — Warranty Claims

## Status

**DRAFT — implementation may begin. Two owner items are flagged in §11; neither
blocks the core workflow, and neither may be invented.**

Author: Principal Architect / Tech Lead
Date: 2026-09-25
Depends on: slice 0 (closed)
Started because slice 4 is blocked by D5/D7/D10 and `BUY-NOW-RETURNS` §14
expressly forbids inventing the tax treatment and credit terms those decisions
cover. Slice 5 depends only on slice 0 and carries no open decisions.

---

## 1. Outcome

A customer who believes their jewellery has a manufacturing defect can file a
claim with photographs and a description, and gets a clear, honest answer
about what happens next. They are never told to post the item anywhere until
CaratForUs has reviewed the claim and authorised an inspection. When they are,
the instructions state plainly that the inbound shipping is theirs to pay,
tracked, and insured.

CaratForUs inspects the item, decides whether the defect is covered, and
chooses the remedy. The customer does not choose it. Every step is recorded
well enough to defend a chargeback a year later.

Two things this slice must never do, both of which the policy is explicit
about: imply that filing a claim establishes coverage, and let Final Sale
status auto-deny a legitimate warranty claim.

## 2. Authoritative sources

| Area | Source |
|---|---|
| Everything warranty | `docs/WARRANTY-CLAIMS.md` — locked |
| Final Sale must not deny a covered claim | `docs/LUXURY-STEALS.md`; slice 3 criteria 141-142 |
| Evidence, acknowledgment, audit primitives | `docs/specs/SLICE-0-FOUNDATION.md` |
| Money, delegation, git discipline | `CLAUDE.md` |

`WARRANTY-CLAIMS.md` §11 lists eleven MVP1 acceptance cases. They are the spine
of §4 below, and §12's "Not Yet Promised" list is the spine of §8.

## 3. Acceptance criteria

Numbered continuing from slice 3.

### 3.1 Intake

**153.** A claim captures every field `WARRANTY-CLAIMS.md` §2 requires: order
number, purchaser contact, customer id where available, the exact item and
configuration, purchase and delivery dates where available, when the issue was
first noticed, the description, uploads, whether an impact or damage event
occurred, whether anyone has resized/repaired/altered the item since delivery,
any certificate or serial identifier, the accuracy certification, the
coverage-is-not-established acknowledgment, the submission timestamp, and a
claim reference.

**154.** Submitting a claim **does not** mark it covered, and the customer is
told so at submission — an explicit acknowledgment, captured as evidence via
the slice 0 `Acknowledgment` model, not merely displayed.

**155.** Server-side validation. A claim referencing an order or line that
cannot be resolved is refused rather than stored against a guess.

### 3.2 Authorisation before shipment — the gate that matters most

**156.** The system **never** issues shipping instructions before a claim
reaches `authorized_for_inspection`. Not in the confirmation, not in a status
page, not in an email. This is the policy's §3 requirement, and it is the one
a helpful-sounding template would break first.

**157.** Authorisation for inspection is recorded as an explicit act by an
authenticated staff member, with timestamp and identity — never inferred from
a status read.

**158.** Authorised instructions state, without softening: the customer pays
inbound shipping, it must be tracked, and it must be insured for the
appropriate value. Tracking and insurance references are retained on the claim
when supplied.

### 3.3 Inspection and coverage

**159.** Receipt is recorded — arrival date/time, package condition, item
condition, and inspection evidence — **before** any coverage decision. A
coverage decision on a claim with no recorded receipt is refused.

**160.** The coverage decision records its reason. "Denied" without a recorded
reason is not a valid state.

**161. Final Sale must never auto-deny.** A Luxury Steal line files, progresses
and is decided exactly like any other. Asserted directly, because this is the
erosion `LUXURY-STEALS.md` is most emphatic about and slice 3's criterion 142
forbids at the other end.

### 3.4 Remedy

**162.** For a covered claim CaratForUs selects repair, replacement, refund or
another appropriate resolution. **The customer never selects it** — there is no
input, anywhere, that lets them.

**163.** Remedy processing is idempotent: a retried or duplicated remedy event
cannot create duplicate customer value (§11 case 10). Enforced by a uniqueness
constraint, not by a read-then-write check.

**164.** Money in a refund remedy follows `CLAUDE.md` rules 5 and 6 — integer
minor units, no floating point, deterministic and tested.

### 3.5 The local-jeweller option — internal only

**165.** The local-jeweller path is **never** exposed on any customer-facing
surface: not in the form, not in status text, not in an email template, not in
an API response a storefront can read. A fence test enforces this rather than a
comment, because it is a promise that becomes a legal entitlement the moment it
is visible.

**166.** Where it is used, the claim retains jeweller selection, the
authorisation and approved scope/cost, communications, invoice and payment
evidence, and completion evidence.

**167.** Unauthorised third-party repair is not automatically reimbursable, and
nothing in the workflow implies it is.

### 3.6 Status workflow and evidence

**168.** The statuses in §8 are modelled as a state machine with explicit legal
transitions. An illegal transition is refused, not recorded — a claim cannot be
`resolved` without having been decided, nor decided without having been
received.

**169.** Every transition is appended to an immutable claim history: who, when,
from, to, and why. Append-only enforced by trigger, as with every other
evidence table.

**170.** The complete claim record is retrievable for support and dispute
review in one query (§11 case 11).

## 4. Data model

| # | Model | Purpose |
|---|---|---|
| M13 | `warranty_claim` | The claim: refs, dates, description, status, decision, remedy |
| M14 | `warranty_claim_event` | Append-only transition and evidence history (criterion 169) |
| M15 | `warranty_claim_upload` | Upload references — key, type, size, checksum. **Never the bytes** |
| M16 | `warranty_claim_remedy` | The remedy and its external references, uniquely constrained for criterion 163 |

Enums for status, coverage decision and remedy kind. `Acknowledgment` and
`AuditEvent` are reused unchanged.

## 5. Uploads — a port, not a direct dependency

`STORAGE_ENDPOINT`, `STORAGE_BUCKET` and the two credentials exist in the
environment schema and are **empty in every environment**. D4 resolved the
choice (Cloudflare R2, private bucket); the bucket itself does not exist yet.

So uploads go behind a port, exactly as the Shopify sync does: the domain
records upload *metadata* and never touches bytes. A production adapter lands
when credentials do. This is not a stub to be tidied later — separating
"a claim has an attachment" from "where the attachment lives" is correct
regardless, and it keeps the workflow testable and shippable now.

**Never store uploads in Postgres.** Photographs of jewellery in an
append-only evidence table is a migration and backup problem that only gets
worse.

## 6. Native Shopify vs custom

| Capability | Owner |
|---|---|
| Order, line item, customer, refund execution | **Shopify** |
| Claim workflow, coverage decision, remedy selection, evidence | **Custom** |
| Claim intake form | **Custom**, App Proxy resource route |
| Staff review surface | **Custom**, embedded admin |

Refunds, when a refund is the chosen remedy, execute through Shopify rather
than a parallel money path.

## 7. Test plan

Criteria 156, 161, 162, 163 and 165 are the money-and-policy-critical ones and
each gets a direct assertion:

- no shipping instruction is produced on any pre-authorisation surface
- a Luxury Steal claim reaches a coverage decision exactly like any other
- no customer-facing input can select a remedy
- a duplicated remedy event is refused by constraint
- no customer-reachable surface mentions the local-jeweller option

Plus: illegal status transitions refused; coverage refused before receipt;
denial without reason refused; append-only triggers reject UPDATE and DELETE;
money in minor units.

## 8. Non-goals — from `WARRANTY-CLAIMS.md` §12, not invented here

No guaranteed turnaround time. No guarantee of repair over replacement or
refund. No prepaid inbound label. No automatic reimbursement for a
customer-selected jeweller. No post-warranty paid repair service. None of these
may appear in copy, schema or API shape, because each becomes a promise the
moment it is representable.

## 9. Task breakdown

| Task | Agent | Owns |
|---|---|---|
| 5-1 — M13-M16 migrations, status machine, domain | Backend (`sonnet`) | `prisma/`, `app/domain/warranty/**` |
| 5-2 — repositories + upload port | Backend (`sonnet`) | `app/db/repositories/warranty*`, `app/jobs/warranty/**` |
| 5-3 — claim intake route + evidence | Backend (`sonnet`) | `app/routes/apps.carat.warranty-*` |
| 5-4 — staff admin surface | Backend (`sonnet`) | `app/routes/app.warranty-*` |
| 5-5 — storefront form | Shopify Dev (`sonnet`) | `theme/**/warranty-*` |
| 5-6 — tests | Test Eng (`haiku`) | `tests/` |
| 5-7 — QA + architect acceptance | QA (`sonnet`), Tech Lead (`opus`) | read-only |

## 10. Architecture review

**Boundary is right.** Shopify owns the order and the refund execution; we own
the claim workflow, the decision and the evidence. Nothing here reimplements
commerce.

**No new infrastructure.** Four tables, one port, one proxy route, one admin
surface. Acknowledgment, audit, append-only triggers and webhook plumbing all
exist and are live-proven.

**The structural risk is copy, not code.** Five of the twelve things this slice
must not promise are things a well-meaning sentence would promise by accident —
a turnaround time in a confirmation email, "we'll repair it" instead of "we'll
determine the appropriate remedy", a local jeweller mentioned helpfully. That
is why criterion 165 is a fence rather than a review note.

**Second risk: the authorisation gate is the one customers will push against.**
Someone will want to post the item immediately. Criterion 156 has to hold on
every surface, including ones added later.

**VERDICT: APPROVE WITH CONDITIONS.** Owner items in §11; neither blocks the
core workflow.

## 12. Closure status

Recorded 2026-09-25. **Implementation complete and QA-reviewed. NOT closed** —
three items below, one of which would stop a real customer.

### QA review

Independent review found **one medium finding and nothing else**. Everything
else was confirmed sound, and confirmed by checking rather than by re-reading
the claims: the reviewer independently recomputed the acknowledgment's sha256
against the migration's hardcoded hash, traced every jeweller import for
reachability rather than presence, and actively tried to defeat the status
machine — finding three independent layers blocking a coverage decision before
receipt.

**The finding: a fence that proved nothing.** The route-level criterion-165
guard asserted `"getWarrantyClaimForStaffReview" in warrantyClaimRoute`. That
namespace object holds the module's own EXPORTS, so it only asked whether the
route re-exports that name — never whether it imports and calls it, which is
the whole regression the criterion exists to prevent.

Worse than no test: it occupied the place a real guard belonged and reported
success, so nobody would look again. Replaced with a source-text fence, a
guard-the-guard test against renames, and **proof it fires** — a jeweller
reference appended to the route made it fail on exactly that assertion, where
the old fence stayed green through the identical change. Fixed in `98c12d2`.

The boundary was never actually broken.

### What blocks closure

| # | Item | Severity |
|---|---|---|
| 1 | ~~The form needs Shopify Order and Line Item IDs~~ **RESOLVED 2026-09-26 by D33, committed `90dfc9d`.** A customer now identifies their order the way they actually know it. Logged in: orders resolve from the signed App Proxy `logged_in_customer_id`, and only orders genuinely belonging to that customer. Guest: order number plus email, treated as a lookup request that discloses nothing, with a short-lived single-use emailed token — only redemption reveals order or line data. `apps.carat.warranty-order-lookup.tsx` / `apps.carat.warranty-order-verify.tsx`. | ~~Blocks real use~~ Closed |
| 2 | No Shopify **Page** exists with the `page.warranty-claim` template, so the form is not reachable at any URL. A manual admin step; we hold no content scope and one should not be added for this. | Blocks verification |
| 3 | ~~Copy beyond the acknowledgment is not owner-approved~~ **The acknowledgment text and its affirmative-action label `I Certify & Agree` are owner-approved and pinned with the policy version.** Remaining supporting copy is still drafted from the policy's own language and carries the unapproved marker. | Pre-launch |

Item 1 was a product decision rather than a defect, and the owner resolved it
as D33 — lookup by order number, with guest access gated behind an emailed
single-use token so the endpoint cannot be used to enumerate orders or email
addresses. Implemented and committed.

**RESOLVED 2026-09-26 — the page template was missing from the LIVE theme,
not from source.** The owner created the Shopify page and found only
"Default page" and "contact" offered in the template dropdown.

The cause was a deployment gap, not missing code. Themes on this store:
`CaratForUs (Dawn 16 + Slice 2)` is **live**; Slice 3 was verified on a
separate **unpublished** `CaratForUs (Slice 3 verification)` theme. So the
live theme carried Slice 2 only — no warranty template, no warranty section,
and none of Slice 3's luxury files either. Nine files existed in source and
had never reached the published theme.

Deployed by a TARGETED push (`--only`, 71 paths), not a full theme push,
because a full push would have overwritten merchant state. Excluded
deliberately: `config/settings_data.json` (holds the merchant's theme
settings and differed substantially from source), every pre-existing
`templates/*.json` (Shopify-normalised in-editor; our `product.json` would
have re-applied `media_position`/`gallery_layout` and changed the live
gallery), and `sections/header-group.json`/`footer-group.json` (local
carried settings live did not).

Verified AFTER the push by pulling back from live rather than trusting the
CLI's success message: `page.warranty-claim.json`,
`sections/warranty-claim-form.liquid`, `assets/warranty-claim-form.js` and
`snippets/luxury-product-gate.liquid` are present, and
`config/settings_data.json`, `templates/product.json` and
`sections/header-group.json` are byte-identical to their pre-push state.

Remaining owner steps: refresh the Warranty Claim page in Shopify Admin,
set template `warranty-claim`, set Visible, save.

**Only item 2 now blocks verification, and it is an owner action, not
engineering work.** Create the Shopify Page: Online Store → Pages → Add page;
Title `Warranty Claim`; handle `warranty-claim`; template `warranty-claim`;
leave the body empty (the template renders the form). We hold no content scope
and should not add one for a single manual step.

The verification email's dispatch outcome IS recorded durably: one
`audit_event` row per outcome — `sent`, `failed`, `skipped_unconfigured` —
keyed on `entityType: "warranty_order_lookup_verification"` and the
verification row's id, written from a path that never throws into the
request. A customer who never received a link is therefore distinguishable
from one who did, which is the question support actually has to answer.

(An earlier revision of this section and of commit `90dfc9d`'s message called
this a known gap. That was wrong. It was inferred from the Prisma model
carrying no email columns, without checking where the outcome is actually
written — the shared `audit_event` table, not a column on the verification
row. The code was already correct when both were written.)

Latent configuration trap, recorded rather than fixed: `resolveEmailPort()`
reports `configured: false` unless `STAFF_EMAIL_ALLOWLIST` is set, even for
this customer-facing email, which never consults the allowlist. Production
(`caratforus`) currently has all three of `EMAIL_API_KEY`, `EMAIL_FROM` and
`STAFF_EMAIL_ALLOWLIST` set, verified 2026-09-26, so this does not bite
today. It would bite silently in any environment that sets the two email
variables but not the allowlist, which is the same shape as the outage where
the acknowledgment policy version existed only in the seed. The
`skipped_unconfigured` audit row above is what makes it detectable.

### Carried forward

**When the R2 adapter lands, verify `storageKey` was issued for THIS claim.**
The intake schema currently accepts it as an opaque client-supplied string.
Not exploitable today — no bucket exists and the only implementation is the
recording port — but on the day a production adapter ships, an attacker-chosen
key would be trusted at face value. It needs a signed or nonce'd destination.

Uploads are omitted rather than faked, for the same reason: a control that
silently dropped a customer's photographs would be worse than none, because
they would believe their evidence was submitted.

### Verified

110+ files and 2000+ unit tests across the suite; warranty integration 78
tests across three files on fresh disposable databases; typecheck, lint,
money-safety clean; theme check zero errors. Nothing in this slice has been
exercised in a browser, because item 2 prevents it.

## 11. Owner items

| # | Item | Blocks |
|---|---|---|
| 1 | **R2 credentials** — bucket does not exist; all four storage variables empty in every environment | Upload *storage* only. The workflow, metadata and tests do not wait for it |
| 2 | **Customer-facing copy** — the form, the coverage-is-not-established acknowledgment, and the authorised-shipping instructions are material terms and need approval before shipping, as every such string has | Shipping the storefront form. Not the backend |

Neither is a reason to stop building. Copy will be drafted from
`WARRANTY-CLAIMS.md` §9's required statements and brought for approval rather
than shipped on assumption.
