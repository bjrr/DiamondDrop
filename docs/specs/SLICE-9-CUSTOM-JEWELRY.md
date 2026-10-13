# Slice 9 — Custom Jewelry intake

Status: **the whole deposit chain ships** — intake, inspiration uploads, the
confirmation email, the Design Deposit acceptance, issuing the invoice, and
recording payment. Uploads and the acceptance route's enforcement are
live-proven against production; the custom-line price field is live-verified
against the real store. A genuinely paid order has NOT been run end to end —
see §8.4.

Authoritative sources: `README.md` "Custom Jewelry — MVP1 Locked Direction";
`docs/REQUIRED-CUSTOMER-ACCOUNTS.md`; owner decisions 2026-10-05 (copy, the
account boundary, upload architecture) recorded verbatim below.

---

## 1. What a customer can do today

Submit a free custom jewelry enquiry at `/pages/custom-jewelry` — **with or
without an account** — describing the piece, an optional approximate budget,
optional timing, and how they would like to be followed up with. They may
paste inspiration links as plain text. If signed in, they may also attach up
to ten photos.

They receive a confirmation on the page and a confirmation email carrying a
project reference.

**No money moves.** The route takes no payment input, creates no draft order,
and `custom_jewelry_project` has no payment columns.

---

## 2. The account boundary (owner decision, 2026-10-05)

| Surface | Account |
| --- | --- |
| Custom Jewelry intake | **optional** |
| Uploading private files | **required** |
| Deposit / payment, final design approval or purchase | **required** |

Owner's words: *"do not force account creation merely to submit the
enquiry."* The README calls the initial request free and intentionally
low-friction, and `REQUIRED-CUSTOMER-ACCOUNTS.md` requires an account for
every PURCHASE path — a pre-purchase enquiry is not one.

**The upload gate is an abuse and storage control, not a purchase
requirement.** An endpoint minting presigned PUTs for anyone is free file
hosting on our account. A signed-out visitor is shown an invitation, not a
wall: the rest of the form stays usable and the inspiration-links field
exists precisely so they are not pushed into registering.

The App Proxy signature is still required on the anonymous route. "No
account" is not "no authentication of the caller" — the endpoint is reachable
only through the storefront.

---

## 3. Owner-approved copy

Two strings are approved verbatim and **pinned in two links rather than
copied three times**: `app/app/domain/customjewelry/intakeCopy.ts` holds the
constant, `intakeCopy.test.ts` pins the constant to the owner's wording, and
`app/app/theme/ownerApprovedCopy.test.ts` pins the storefront locale to the
constant.

**Post-submission confirmation:**

> Thanks — we've received your custom jewelry request and recorded it under
> {projectReference}. There's no charge for this enquiry. We'll be in touch by
> email.

**$49 Design Deposit disclosure** (shown on the intake form, always visible,
first thing after the intro):

> This enquiry is free. If we move forward with design/CAD work, there is a
> $49 Design Deposit. The deposit is charged when design/CAD work begins and
> is credited toward your final price. If CaratForUs completes the agreed
> design stage and you decide not to proceed, the $49 deposit is refunded.

**Follow-up choices**, in the approved order: *Schedule a consultation*;
*Please contact me*.

**Confirmation email** — `intakeConfirmationEmail.ts`, approved verbatim,
subject `We received your custom jewelry request ({projectReference})`.

### 3.1 What the copy must never acquire

**No response-time promise, anywhere.** Struck by the owner from the warranty
copy twice and from this surface explicitly. The tests reject "shortly",
"as soon as possible" (a turnaround promise wearing a vague coat), "business
day(s)", "promptly", "right away" and any `within N`.

**No abandonment / non-response rule on the intake form.** Owner's words:
*"Keep the intake welcoming."* It is **not dropped** — see §6.

**The refund clause must stay conditional.** Owner's words: *"Do not let the
initial intake wording imply the deposit is unconditionally refundable."* A
test asserts the clause *"If CaratForUs completes the agreed design stage and
you decide not to proceed"* survives any edit.

---

## 4. Uploads — one implementation, not two

Owner decision 2026-10-05: *"generalize the existing R2 upload-destination
architecture. Do not create a second independent Custom Jewelry
upload-destination implementation… Those guarantees should have one
implementation, not two copies that can drift."*

`app/app/db/repositories/uploadDestinationRepository.server.ts` is that one
implementation. It persists each destination, binds it to the authenticated
customer and to a `purpose`, and consumes it with a single atomic conditional
`UPDATE` whose WHERE clause *is* the verification. Every failure mode — never
issued, wrong owner, wrong customer, **wrong purpose**, expired, already
consumed — returns the same `false`, so callers can only render one generic
refusal and the service cannot become an oracle for guessing another
customer's storage key.

**Cross-purpose isolation is structural.** `purpose` is part of the
consumption match rather than something a caller remembers to check, so a
warranty-issued key simply finds no row on the Custom Jewelry path.

### 4.1 Migration sequence (forward-only, additive first)

| Migration | Phase |
| --- | --- |
| `20261005040000_upload_destination_generalize_expand` | add `purpose` + `owner_id` nullable, backfill `warranty_claim`/`claim_id`, self-verify the backfill |
| `20261007010000_custom_jewelry_project_upload` | the Custom Jewelry upload record table |
| `20261007020000_upload_destination_contract_step_a` | `purpose`/`owner_id` `NOT NULL`; `claim_id` relaxed to nullable; writer stops setting it |
| `20261008010000_upload_destination_contract_step_b` | `DROP COLUMN claim_id`, guarded |
| `20261008020000_custom_jewelry_deposit_policy_version` | the Design Deposit acknowledgment policy, version 1 |
| `20261008030000_custom_jewelry_deposit_acceptance` | the append-only deposit acceptance record |

**Step B's precondition is proven, not assumed**, and anchored on step A's
own recorded `finished_at` rather than a pasted timestamp. If a row issued
after step A still sets `claim_id`, the migration refuses with the count. If
step A is missing or unfinished, it **raises rather than passing** — `issued_at
> NULL` yields NULL and `count()` of no rows is 0, so the check would have
read "fine" precisely when it could not tell.

`uploadDestinationContractGuard.test.ts` makes that guard **fire**: it reads
the real `DO` block out of the migration file (extracted, never retyped, so a
copy cannot keep passing after the original is weakened) and runs it against
all three failure states and both legitimate ones. The permissive cases
matter as much as the refusals — without them the guard could be "always
raise" and every refusal test would still pass.

**Why step B is a separate deploy.** Fly runs `prisma migrate deploy` as a
release command that completes *before* any new machine starts, so the
previous deploy serves traffic against the new schema for the length of that
window. A single migration dropping `claim_id` would leave the running writer
populating a column that no longer exists.

**The table is deliberately not renamed to `upload_destination`.** The rename
would make the old code query a table that does not exist during that same
window — a real customer-visible failure on the upload endpoints, traded for
a name only developers read. A `COMMENT ON TABLE` carries the warning that
actually matters: do not add a second destination table for a new upload
flow; add a `purpose` enum value.

### 4.2 Why the upload RECORD tables are separate

`custom_jewelry_project_upload` is its own table, not rows in
`warranty_claim_upload`. The one-implementation mandate concerned the
destination **service** — the security properties. The record tables are
plain per-entity data with different foreign keys and different readers;
merging them would need a nullable FK per flow plus a discriminator deciding
which is valid, which is more fragile rather than less.

It is also **not append-only**, which is a considered difference from
warranty evidence. A warranty upload is dispute evidence about a claim; an
inspiration image is reference material for a conversation that has not
happened. The *approved design images at purchase* will be dispute evidence,
and that surface gets its own append-only table rather than this one being
retrofitted.

---

## 5. Verification

**Custom Jewelry upload live gate — 15/15 PASSED against production**,
2026-10-07. `tests/live/slice9.customJewelryUploadFlow.ts`. It imports no
application module and no database client: it speaks only to the deployed app
over HTTP and to R2 over HTTP, so what it proves, it proves about production.

```
destination-issued              anonymous-destination-refused
destination-persisted           anonymous-intake-allowed
presigned-put                   object-not-public
intake-accepts-valid-key        arbitrary-key-rejected
destination-bound-customer      reused-destination-rejected
no-partial-project              expired-destination-rejected
warranty-key-rejected-by-cj     cj-key-rejected-by-warranty
foreign-project-refused
```

**Warranty upload live gate — 10/10.** The owner's first regression
requirement. Re-run twice: after the generalization, and again after
`claim_id` was dropped. The shared service still serves the path it was
extracted from.

**Both gates re-run after EACH contract step**, not just at the end — 15/15
after step A constrained `purpose`/`owner_id` and the writer stopped
setting `claim_id`, and 15/15 again after step B dropped the column. A
schema change proven only before and long after is a schema change whose
intermediate state nobody checked.

Both cross-purpose probes are constructed so **`purpose` is the only thing
that differs** — same customer, and the warranty `claimId` reused verbatim as
the Custom Jewelry `projectId` so `ownerId` matches too. If `purpose` were
ever dropped from the consumption predicate, those two assertions are the
ones that would start passing keys through.

Integration coverage: `tests/integration/customjewelry/` exercises the same
properties through the **real routes**, per the owner's instruction *"Do not
accept 'shared code' as proof; both real customer paths must exercise it."*

### 5.1 A defect this work surfaced

Contract step A exposed an existing assertion that queried the destination
table by `claim_id` to prove **no row existed**. Once the writer stopped
setting that column the query could find nothing whether or not the route had
leaked a destination — it would have passed vacuously. Re-keyed onto
`purpose` + `owner_id`. A check that can only succeed is not a check.

---

## 6. The Design Deposit acceptance step — shipped

`POST /apps/carat/custom-jewelry-deposit-acceptance`. All four required
disclosures, affirmative acceptance, and an append-only record of what was
agreed.

**It authorizes; it does not charge.** No draft order, no payment provider,
and the project status deliberately stays `submitted` — a test asserts that.
`deposit_charged` means money arrived, and setting it at acceptance would
start design work against funds that may never be collected. Collection is
the remaining follow-on, with its own record: conflating "agreed to pay" with
"paid" is the failure this separation exists to prevent.

**An account is required here**, unlike the enquiry — the identity comes from
the signed `logged_in_customer_id` only, and someone else's project is
refused with the same generic 422 as a nonexistent one.

### 6.1 The four disclosures and where each came from

1. the $49 amount
2. that it is credited toward the final price
3. that it is refunded if CaratForUs completes the agreed design stage and
   the customer decides not to proceed

Those three are the **owner-approved intake wording, imported verbatim** from
`intakeCopy.ts` rather than restated — a test asserts byte-identity, because
the customer saw that exact sentence on the enquiry form and a second copy at
the point of charge is where drift does most damage.

4. **conspicuously** — that a refund is *not* automatic if the customer
   abandons the project or stops responding before the agreed design stage is
   completed

This is the sentence the owner kept off the intake form ("Keep the intake
welcoming"). It is rendered from the owner's own words, recast into first
person because the customer is certifying rather than being told — the same
grammatical split the warranty copy draws between `notice_body` and
`acknowledgment_text`.

**Nothing was added to it.** No grace period, no cure window, no definition
of "stops responding"; tests reject each by name. Inventing policy inside an
acknowledgment is how a customer ends up agreeing to a term nobody approved.

> **Owner confirmation pass outstanding on the first-person rendering of (4).**
> The substance is the owner's, quoted; the wording is engineering's. It is
> pinned and versioned, so a revision is a visible diff plus policy version 2
> — never a silent edit.

**Both conditions ship together**, in the order the owner stated them,
enforced by an assertion on their relative position: the refund condition
read alone is a promise, the abandonment rule read alone is a threat.

### 6.2 Why the record can be trusted afterwards

| Property | How it is guaranteed |
| --- | --- |
| Names the exact text shown | NOT NULL FK to `acknowledgment`, which carries the text, policy version, clicked label and timestamp |
| Amount matches the disclosure | `$49` in the copy and `4900n` minor units pinned to each other by test; amount then **frozen** on the row |
| Exists at most once | UNIQUE index on `project_id` — not a prior read. Race tested: both requests pass the read, one loses, exactly one acknowledgment survives |
| Cannot be altered | append-only UPDATE/DELETE/**TRUNCATE** triggers, all three |
| Cannot be destroyed with the project | `ON DELETE RESTRICT` on both FKs |
| Cannot be zero or negative | CHECK `amount_minor_units > 0` |
| Acceptance cannot be inferred | `z.literal(true)` — a missing or `false` flag cannot produce a parsed body at all |

The policy row is provisioned by **migration**, not seed, and registered in
`requiredPolicyVersions.ts` so a missing one surfaces at `/health` when a
deploy finishes. Not hypothetical: the Luxury Steals acknowledgment endpoint
returned 500 `policy_unavailable` on its first real production request for
exactly this reason. The migration fence was confirmed to cover the new entry
by corrupting the hash and watching it fail, rather than trusting a green run.

## 7. Issuing the deposit invoice — shipped

Staff action on `/app/custom-jewelry/:id`, reached from the queue at
`/app/custom-jewelry`. Creates a Shopify draft order for the authorized
amount, as a **custom line** — no product variant, so no store setup, and
nothing to ship.

### 7.1 The invariant: no invoice without an acceptance

`custom_jewelry_deposit_invoice.acceptance_id` is a **NOT NULL foreign key to
the acceptance**, not to the project. An invoice for a customer who never
agreed to the four disclosures is unrepresentable — a route that forgot to
check could not create one, and neither could a careless manual INSERT. The
issuing function checks too, but a test asserts the schema refuses it
independently, which is what makes the code check a convenience rather than
the guarantee.

`UNIQUE` on `acceptance_id`: two live payment links for one $49 is a customer
who can pay twice. A repeat attempt returns the existing invoice and never
reaches Shopify.

### 7.2 The amount comes from the acceptance, not from today's price

Those are different questions. The constant is what we charge now; the
acceptance is what *this* customer agreed to. The two are compared and a
divergence **refuses in both directions** — invoicing more than was authorized
is obviously wrong, and invoicing less is also wrong, because the record of
what the customer agreed to would stop describing what we are doing to them.
A price change therefore needs a fresh acceptance, not a quietly re-priced
invoice.

### 7.3 A separate adapter method, and a different price field

`createServiceDraftOrder` is deliberately not options on `createDraftOrder`:
loosening the money-critical Bank Payment input's required shipping address
and variant would leave every future reader working out which combination of
optional fields is legal for which caller.

It sends **`originalUnitPriceWithCurrency`**, not `priceOverride`. A custom
line has no catalogue price to override, and Shopify's own description says
the former is "for custom line items" and "ignored when variantId is
provided".

**That distinction already cost one live defect here.** The adapter first sent
`originalUnitPrice` on variant lines; Shopify neither errored nor coerced — it
silently ignored the field and charged the catalogue price — and no unit test
could have caught it, because a mocked client echoes back whatever it is
handed.

So it is **live-verified**: `tests/live/slice9.depositInvoicePriceField.ts`,
**5/5** against caratforus-dev. One real draft order, read back in a *separate*
query (the create response's echo comes from the same mutation, so it proves
reflection rather than persistence), asserting the line persisted at 49.00 with
no variant attached. The probe order is deleted in a `finally`, and the
cleanup is itself an assertion.

No shipping line — there is nothing to ship, and a zero one would imply a
delivery. No payment terms, the opposite choice from Bank Payment and for the
opposite reason: this is paid *through* Shopify, so the order becomes paid when
the customer pays.

### 7.4 Issuing is not collecting, and not contacting

The project status stays `submitted` (asserted) and **no email is sent**. The
Shopify invoice email's wording is partly ours (`customMessage`) and has not
been approved, so staff send it from the Shopify admin where they can see
exactly what goes out. The test's fake port **throws** if `sendInvoice` is
called, so an accidental send is a hard failure rather than something nobody
notices.

The ordering hazard is stated rather than hidden: the draft order is created
before the local record, so a crash between them leaves an orphaned draft
order. That is the correct way round — the reverse would record an invoice
that does not exist and tell a customer to pay something never sent. An
orphaned draft is unpaid, un-emailed, and tagged with the project reference:
a mess, not a loss.

## 8. Collecting the deposit — shipped

`orders/paid` → `webhooks.carat.orders-paid.tsx` →
`customJewelryDepositPaymentHandler.server.ts`. The money arriving is recorded
as a fact, and `deposit_charged` is set from that fact rather than from having
asked.

**A separate topic from `orders/create`**, deliberately: a deposit invoice is
paid through Shopify's own checkout, so the order exists before the money
does, and `orders/create` fires while it is still unpaid.

### 8.1 The tag is a hint; Shopify is the authority

The order inherits `carat-design-deposit` and `carat-project-<reference>` from
the draft order. Those are how the handler knows a delivery is worth looking
at and finds the candidate cheaply — and they are **not trusted for the
match**, because an order tag is editable by any Shopify admin user, and
matching money on an editable field is how the wrong deposit gets marked paid.

So the handler asks Shopify which order the invoice's draft order actually
became and requires it to be this one. Same discipline as every ownership
check here: the supplied value locates the record, the server-side lookup
decides.

**The amount must match too.** A draft order can be edited before payment, so
a total that is not the invoiced figure records nothing and does not advance
the project. The stored amount is the **observed** one, not a copy of the
invoice's — which is what makes their agreement a verified fact rather than an
assumption.

### 8.2 Which failures retry, and which do not

| Situation | Behaviour | Why |
| --- | --- | --- |
| Shopify lookup failed | **throws** → Shopify redelivers | a retry can succeed |
| No deposit tag | returns, silent | most orders here are Buy Now or Group Buy |
| Order/amount/ambiguity mismatch | returns + error log + audit event | a retry cannot fix data that is simply what it is; looping Shopify would bury the anomaly in redelivery noise |

Idempotent three times over: the receive layer dedupes by event id, the
payment table is UNIQUE on both `invoice_id` and `order_gid`, and the status
write is a fixed value rather than an increment.

### 8.3 The status only ever moves forward

The enum runs `submitted → deposit_charged → awaiting_approval → approved →
purchased → closed`. The handler originally wrote `deposit_charged`
unconditionally, which would drag a project **backwards** if a delayed or
redelivered `orders/paid` arrived after staff had advanced it. Nothing else
writes that column yet, which is the only reason it was not already live —
the next slice's staff action makes it reachable.

**`submitted` is the authoritative predecessor**, verified against the model
rather than inferred from the implementation: the enum has no
accepted/awaiting-payment state, accepting the terms and issuing the invoice
record their own append-only evidence rows and leave status alone (both
asserted), the staff list derives its three deposit stages from those rows,
and this handler is the only code in the app that writes the column.

The guard is a condition in the SQL `WHERE`, not a prior read — a
read-then-write loses to a concurrent staff action, and being correct under
exactly that race is the point. `updateMany` rather than `update`, so a
non-matching status is "nothing to do" instead of a thrown not-found that
would roll the payment back with it.

**The receipt survives a refused advancement.** The money genuinely arrived;
discarding it because the project had moved on would lose the payment record,
which is worse than a status needing a human. A refusal logs and writes an
audit event naming the status found.

### 8.4 Duplicate delivery is inert

| Case | Outcome |
| --- | --- |
| Same Shopify event id | deduped by the receive layer, handler never called |
| Redelivery, new event id | `invoice.payment` check returns early — no second payment, no second anomaly |
| Redelivery after a *refused* advancement | still one anomaly, not one per delivery |
| Two concurrent deliveries | UNIQUE indexes decide; loser treated as already-recorded, no error, no anomaly |
| Same order against a second invoice | refused by the UNIQUE `order_gid` index |

The third row is the subtle one: after a refused advancement the status will
**never** equal `submitted` again, so a handler re-deriving the anomaly from
"status ≠ predecessor" would write a fresh entry on every delivery and bury
the original in duplicates. The `invoice.payment` early return fires before
the status logic is reached.

The concurrent case used to return 500: both deliveries pass that check
before either writes, and the loser's `P2002` propagated — asking Shopify to
redeliver a payment the winner had already recorded correctly. It is now
treated as already-recorded with **deliberately no anomaly event**, because a
routine race must not produce something a human has to triage.

### 8.5 Two defects this work surfaced

**The handler would have ignored every payment, forever.**
`preserveShopifyBigIntIds` returns a doctored JSON *string*, not an object,
and it was passed straight to a Zod object schema — so every payload failed to
parse and the handler returned early. Invisible in production precisely
because "not ours, return silently" is the common path for this topic: a
handler doing nothing looks identical to one with nothing to do. Only a test
asserting the positive path could find it.

**Every non-deposit order paid for a session lookup it never needed.** The
route built the Admin client before the handler ran. A live test delivery for
an unknown shop therefore returned **500**, asking Shopify to redeliver an
order the handler would have ignored — and a transient session problem would
have done the same to real customer orders. The dependency is now a factory
called only after the tags say "deposit" *and* an invoice is found. Re-sent
the same delivery after deploying: **200**. Two tests count factory
invocations, because a lazily declared client that is still resolved eagerly
looks identical from outside until something upstream fails.

### 8.6 What is not proven

`webhookSubscriptions` returns nothing for this app — **not even
`orders/create`**, which demonstrably works. The query only sees API-created
subscriptions and is blind to the declarative ones in `shopify.app.*.toml`, so
its empty result is the wrong instrument, not evidence of absence. (Reading an
empty response as proof is a mistake this project has already made once, with
`read_customers`.)

Registration therefore rests on the app version having released successfully
with `orders/paid` declared — the same mechanism `orders/create` works by.
**End-to-end proof would require a genuinely paid order, which has not been
done.** The endpoint itself is proven: a real signed delivery reached the
handler through HMAC verification and was answered 200.

## 9. Deliberate follow-ons

**The customer-facing deposit page.** The acceptance route exists and is
live-proven, but there is no storefront page, because there is no staff action
that invites a customer to one — a page with no entry point would be
speculative. The natural pairing is "mark ready for design" → customer accepts
→ staff issue invoice.

**A real paid-order run** through the whole chain: accept → issue → pay →
`deposit_charged`, against the production store with a test customer. It
creates a genuinely paid $49 order, so it is a deliberate owner decision
rather than something to do unprompted.

**The customer-facing deposit page.** The acceptance route exists and is
live-proven, but there is no storefront page yet, because there is no staff
action that invites a customer to one — a page with no entry point would be
speculative. The natural pairing is "mark ready for design" → customer accepts
→ staff issue invoice.

**Video uploads.** The server accepts video (300 MB ceiling), but the
checksum it requires is computed in the browser and hashing a 300 MB file in
a phone tab is a hang. Photos only, 20 MB, until that is solved properly —
deferred rather than half-offered.

---

## 10. Owner action required to make the page reachable

The theme files are deployed; **the Shopify Page does not exist yet**, so
`/pages/custom-jewelry` 404s until it is created. We hold no content scope
and should not add one for a single manual step — the same conclusion reached
for the Warranty Claim page.

> Online Store → Pages → Add page
> Title: `Custom Jewelry`
> Handle: `custom-jewelry`
> Template: `custom-jewelry`
> Body: leave empty (the template renders the form)
> Visibility: Visible

If `custom-jewelry` is not offered in the template dropdown, the live theme
has not received the files — that exact deployment gap blocked the warranty
page once (see `SLICE-5-WARRANTY-CLAIMS.md` §"page template was missing from
the LIVE theme"). Verify by pulling back from live rather than trusting the
CLI's success message.

Theme pushes on this store must be **targeted** (`--only`), never a full
push: a full push overwrites merchant state —
`config/settings_data.json`, in-editor-normalised `templates/*.json`, and
`sections/header-group.json`/`footer-group.json`.
