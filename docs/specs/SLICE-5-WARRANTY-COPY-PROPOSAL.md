# Slice 5 — Warranty Claim Customer-Facing Copy (PROPOSAL)

## Status

**DRAFT — PROPOSED COPY, NOT YET APPROVED.** This is a proposal for the owner
to review, not a specification of shipped behavior. Nothing in this document
is a locale string, a component, or a pinned constant — see "How this gets
adopted" at the end for what happens after approval.

Author: Backend & Pricing Engineer, at the Tech Lead's request following
task 5-1 (schema + status state machine).
Depends on: `docs/WARRANTY-CLAIMS.md` §9 (customer-facing principles, six
required statements) and §12 (not yet promised, six prohibitions). Read in
full before reviewing this draft; every line below is written against those
two lists specifically, not general ecommerce convention.

## How to read this document

Each surface below gives the proposed text, then a **Satisfies / Avoids**
line naming the exact §9 statement(s) the text carries and the exact §12
prohibition(s) it was written not to trip — so the owner can check the
mapping directly against the policy rather than re-deriving it from the
prose. §9's six statements are numbered S1-S6 below for reference; §12's six
prohibitions are numbered P1-P6.

**S1** warranty limited to covered manufacturing defects · **S2** form +
authorization required before sending · **S3** claim/authorization does not
itself establish coverage · **S4** customer pays tracked, insured shipping ·
**S5** CaratForUs evaluates after receipt · **S6** CaratForUs determines the
remedy for a valid covered claim.

**P1** no turnaround time · **P2** no repair-over-replacement/refund
guarantee · **P3** no prepaid inbound shipping · **P4** no automatic
jeweller reimbursement · **P5** no post-warranty paid repair service · **P6**
no blanket wear/accidental-damage coverage.

---

## 1. Claim form intro

Shown at the top of the Warranty Claim Form, before any field.

> **Warranty Claim**
>
> Use this form to report a suspected manufacturing defect on jewelry
> covered by CaratForUs's 1-year limited manufacturing warranty. The
> warranty covers defects in materials, construction, setting, or assembly
> under normal use — for example, a defective solder joint, a workmanship
> failure, a setting defect, or a defective clasp or mechanism.
>
> It does not cover normal wear, scratches, dents, impact damage, prongs
> worn or bent from use, stone loss caused by damage or wear, misuse,
> improper care, sizing changes, or unauthorized repairs, alterations, or
> modifications.
>
> This form is not a general return request, and it is not itself a
> decision about your item. **Please don't send your item to us yet** — we
> review every claim first and will follow up with next steps.

**Satisfies:** S1 (the coverage/exclusion paragraph, drawn directly from
`WARRANTY-CLAIMS.md` §1, sets the scope before the customer describes
anything, rather than leaving "manufacturing defect" undefined). Also
opens S2 ("don't send it yet"), completed by surface 4 below.
**Avoids:** P1 (no timeframe anywhere in the intro); P6 (the exclusion list
states plainly that wear/accidental damage are excluded, so the form itself
does not read as blanket coverage).

---

## 2. Accuracy certification

The checkbox/acknowledgment at the end of the form, before submit. This is
one of §2's required intake fields, not one of §9's six statements directly
— included here because it is one of the two acknowledgments captured as
evidence per criterion 154.

> I certify that the information and description I have provided in this
> claim are accurate and complete to the best of my knowledge.

**Proposed affirmative-action label:** "I Certify This Is Accurate"

**Satisfies:** §2's "customer certification that submitted information is
accurate" (not a §9 item; listed for completeness of the two required
acknowledgments). **Avoids:** nothing to avoid here — the text makes no
claim about coverage, timing, or remedy, so none of P1-P6 apply, but it is
reviewed to confirm that stays true of any revision too.

---

## 3. Coverage-is-not-established acknowledgment (criterion 154 — the material one)

The second, separate checkbox/acknowledgment, shown distinctly from the
accuracy certification above — not combined into one checkbox, so the
customer affirmatively agrees to each fact on its own.

> **Submitting This Claim Does Not Establish Coverage**
>
> I understand that submitting this warranty claim does not mean CaratForUs
> has determined that my item is covered under the warranty. CaratForUs
> will review the information I've provided and, if appropriate, authorize
> my item for inspection. Whether my item is covered is decided only after
> CaratForUs receives and inspects it.

**Proposed affirmative-action label:** "I Understand & Agree"

**Satisfies:** S3, directly and as its primary purpose ("claim
submission/inspection authorization does not itself establish coverage") —
this is the exact sentence criterion 154 exists to pin as evidence. Also
reinforces S5 ("CaratForUs evaluates the item after receipt").
**Avoids:** P1 (no "we'll get back to you soon"); P2 (no mention of remedy
at all, so there is nothing here that could read as a repair promise); P3/P4
(no shipping or jeweller content belongs on this acknowledgment — kept to
coverage only, deliberately narrow).

**Why this gets its own screen/step rather than sharing text with #1 or #2:**
the header alone ("Submitting This Claim Does Not Establish Coverage") is
doing real work — a customer skimming past a paragraph will still see that
line. Bundled into the general form intro, it would be one sentence among
several and easier to skim past; as its own explicit, separately-affirmed
acknowledgment, it can't be missed and it's captured as its own evidence
row, distinct from the accuracy certification.

---

## 4. Submission confirmation

Shown on-screen immediately after submit, and in the confirmation email.

> **We've received your warranty claim**
>
> Thank you — we've received warranty claim **[claim reference]**. Here's
> what happens next:
>
> - We'll review the information and photos you submitted.
> - **Please don't send your item to us yet.** If we need more information
>   from you, we'll reach out using the contact information you provided.
> - If we determine your item should be sent in for inspection, we'll email
>   you specific authorization and shipping instructions first — including
>   that shipping the item to us is your responsibility, using tracked,
>   insured shipping.
> - Submitting this claim does not mean your item is covered under the
>   warranty. Whether it's covered is decided after CaratForUs receives and
>   inspects it.
>
> _[REMOVED BY ARCHITECT REVIEW — see note below.]_

**ARCHITECT REVIEW, 2026-09-25 — one line cut before this reached the owner.**
The draft ended this confirmation with *"You can check your claim status at any
time using your claim reference."* That promises a **customer-facing claim
status page, which is not in slice 5's scope.** §9's task list has an intake
route (5-3), a STAFF admin surface (5-4) and a storefront form (5-5) — nothing
a customer can log into to watch their claim.

The policy does not require one either: `WARRANTY-CLAIMS.md` §11 case 11 asks
that claim evidence be "retrievable for support/dispute review" — support, not
self-service.

Shipping this sentence would create an expectation the product cannot meet, on
the surface a worried customer reads most carefully, and the failure mode is
them hunting for a page that does not exist instead of waiting for our email.
That is the same class of error as the §12 prohibitions: a commitment made by
a helpful-sounding sentence rather than by a decision.

If the owner WANTS a customer status page, that is a scope addition to
consider on its merits, not something to inherit from a line of copy.

**Satisfies:** S2, as its primary purpose (explicit "don't send it yet,"
paired with "we'll email you authorization first" — the two halves of "a
claim form and authorization are required before sending the item"). Also
repeats S3 and previews S4/S5 so the confirmation stands on its own even if
the customer never revisits the form.
**Avoids:** P1 — deliberately no "within X business days" or "we'll review
this shortly." The bullet says "We'll review the information and photos you
submitted" with no time component at all, on your instruction that even
"promptly" is a speed commitment. P3 — the preview of shipping instructions
already states the customer's responsibility, so nothing here can be
skimmed as "we'll send you a label."

---

## 5. Authorized-inspection instructions (criterion 158)

Sent only once a claim reaches `authorized_for_inspection` (see
`app/app/domain/warranty/claimStatus.ts`) — never before. This is the one
surface `WARRANTY-CLAIMS.md` §4 and criterion 156/158 are most exacting
about, so it is written to state the shipping terms without any softening
language ahead of them.

> **Your Item Is Authorized for Inspection**
>
> Your warranty claim, **[claim reference]**, has been authorized for
> inspection. Please read the following before you ship anything:
>
> - **You are responsible for the cost of shipping your item to
>   CaratForUs.**
> - **Your shipment must include tracking.**
> - **Your shipment must be insured for the appropriate value of your
>   item.**
> - Please ship to the address below, using a shipping method that meets
>   both requirements above. Keep your tracking number and insurance
>   confirmation — we may ask you for them.
>
> [Shipping address and any carrier-specific instructions]
>
> Authorizing your item for inspection means we're ready to evaluate it —
> it does not mean CaratForUs has determined it's covered under the
> warranty. After we receive and inspect your item, we'll determine whether
> it's covered and, for a valid covered claim, the appropriate resolution —
> which may be repair, replacement, refund, or another appropriate
> resolution CaratForUs determines.

**Satisfies:** S4, as its entire purpose, stated as three separate bolded
sentences rather than one softened paragraph — "you pay," "tracked," and
"insured for the appropriate value" each stand alone so none can be
skimmed past. Also carries S3 one more time (authorization for inspection
still isn't a coverage decision) and S6 (the closing sentence names all
three remedies plus "another appropriate resolution," in no particular
order, with CaratForUs as the explicit subject of "determines" — never the
customer).
**Avoids:** P3 — "you are responsible for the cost" is the first bolded
line, ahead of anything else, so there is no path through this email that
reads as a prepaid label. P2 — repair is listed alphabetically-adjacent to
replacement and refund, not first or emphasized, and the sentence's verb is
"determines," never "will repair" or "we'll fix it." P4 — no mention of a
local jeweller anywhere in this document, on any surface, per criterion
165; that path is never customer-facing until CaratForUs chooses it for a
specific resolved claim, and even then the communication is a one-off, not
copy pinned in advance. P1 — no promised evaluation or shipping timeframe.

---

## What this proposal deliberately does not draft

- **A remedy-decision notification** (telling the customer their claim was
  approved/denied, or what remedy was chosen). That's downstream of the
  five intake/authorization surfaces above, sits closer to task 5-4's staff
  admin surface, and needs its own review against S6/P2 specifically once
  that workflow is built — flagging so it isn't forgotten, not drafting it
  speculatively here.
- **Any status-page/tracking copy** beyond the one line in surface 4 — same
  reasoning; task 5-3/5-4's scope.
- **Anything about the local-jeweller option**, anywhere, on any surface —
  per criterion 165 this is never customer-facing copy at all, drafted or
  otherwise, until CaratForUs authorizes it for one specific resolved claim
  and communicates that arrangement directly.

## How this gets adopted, once approved

Nothing here is wired to a route, component, or locale key. Once the owner
approves (or revises) this wording, the two acknowledgment texts (surfaces
2 and 3) should be pinned the way `app/app/domain/luxurysteals/
acknowledgmentText.ts` pins the Luxury Steals Final Sale acknowledgment —
exact text, an affirmative-action label constant, a `policy_version` slug,
and a version number bumped on any future change, referenced by
`WarrantyClaim.accuracyCertificationAcknowledgmentId` /
`coverageNotEstablishedAcknowledgmentId` (task 5-1's schema). The other
three surfaces (form intro, submission confirmation, authorization email)
are storefront/notification copy for task 5-3/5-5 to place in `theme/
locales` and pin the way `app/app/theme/ownerApprovedCopy.test.ts` pins the
Bank Payment cart copy — approval date recorded in that file's comment, one
test per string asserting the locale matches exactly.
