# Slice 9 — Custom Jewelry intake

Status: **intake, uploads and confirmation email shipped and live-proven.**
Deposit/design-approval step is a deliberate follow-on, not an omission.

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
| *step B, a later deploy* | `DROP COLUMN claim_id` |

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

**Warranty upload live gate re-run after the generalization — 10/10.** The
owner's first regression requirement; the shared service still serves the
path it was extracted from.

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

## 6. Deliberate follow-ons

**The deposit / design-approval step.** Four things must be displayed, with
affirmative acceptance and the accepted text, version and timestamp pinned
*before* the card is charged:

1. the $49 amount;
2. that it is credited toward the final price;
3. that it is refunded if CaratForUs completes the agreed design stage and
   the customer decides not to proceed;
4. **conspicuously** — that a refund is *not* automatic if the customer
   abandons the project or stops responding before the agreed design stage is
   completed.

(4) is the sentence the owner kept off the intake form. A material condition
belongs where it can be acknowledged, not where it reads as a warning to
someone who has not been asked for anything yet.

**Video uploads.** The server accepts video (300 MB ceiling), but the
checksum it requires is computed in the browser and hashing a 300 MB file in
a phone tab is a hang. Photos only, 20 MB, until that is solved properly —
deferred rather than half-offered.

---

## 7. Owner action required to make the page reachable

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
