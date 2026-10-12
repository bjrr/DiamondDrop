# Slice 13 — demand capture copy

**Status: DRAFT, awaiting owner approval.** Nothing below is live. The intake
route returns `503 copy_pending_approval` until these are approved and
provisioned, so no customer can reach any of this wording today.

This resolves `STOREFRONT-COPY-PROPOSAL.md` §1.7, which recorded: *"In locked
MVP1 scope, but it belongs to Slice 13 ... No copy drafted."* It is now Slice
13, and everything except the words is built and tested.

---

## What needs deciding

Four strings, in two pairs. Each pair is one disclosure (stored as a versioned
`policy_version` row, so a later change is a new version with its own
acknowledgment trail) and one affirmative-action label (the words on the
control the customer actually presses, recorded as evidence of what they saw).

Nothing here promises a date, a price, a quantity, or that a campaign will
return at all — because none of those is something we can honour. That is the
main thing to check as you read.

---

## 1. Bring It Back / Notify Me If It Returns

Shown on a past Group Buy, under the campaign's final result.

### 1.1 Disclosure (policy `group-buy-bring-it-back-notification`)

> We'll email you once if this Group Buy runs again. We can't promise it will,
> or what the price will be — a new campaign is priced from costs at the time
> it opens. We use your email for this notice only, and you can ask us to
> remove it at any time.

Three things this deliberately does **not** say: that it will return, when, or
at what price. A past campaign's price was frozen against costs that have since
moved, and the archive already states what that price was — an expectation that
it would be repeated is the misunderstanding most likely to arise here.

"Once" is a commitment the system can keep: the signal is marked notified and
never re-selected.

### 1.2 Affirmative-action label

> Email me if this runs again

---

## 2. Request a New Group Buy

A short form, not a design brief. README: *"do not turn either into a
custom-design questionnaire."* The implementation caps the note at 500
characters and collects nothing else — no name, no phone, no budget, no
uploads.

### 2.1 Disclosure (policy `group-buy-new-campaign-request`)

> Tell us what you'd like to see run as a Group Buy. We read every request,
> but we can't promise to run any particular one, and we'll only email you
> about this request. If you want a one-off piece made for you, start a Custom
> Jewelry request instead — that's a different process.

The last sentence is there because this form will otherwise collect custom
design briefs. Pointing at the right door is cheaper than declining them later.

### 2.2 Affirmative-action label

> Send my request

---

## 3. Confirmation shown after either submission

> Thanks — we've got it.

Deliberately identical for a new submission and a repeat. The endpoint is
public and unauthenticated: a confirmation that said "you're already on the
list" would let anyone check whether a given address is watching a given
campaign.

---

## Open questions for the owner

1. **Is a tickbox required, or is the disclosure enough?** The implementation
   supports either without change — the acknowledgment records the text shown
   and the label pressed in both cases. A tickbox is more defensible for email
   consent; a button alone is lower friction, which the README asks for. The
   labels above are written as button captions, on the assumption that the
   submit button IS the affirmative action. Say the word and they become
   tickbox labels instead.

2. **Removal requests.** §1.1 says "you can ask us to remove it at any time".
   There is no self-service removal in MVP1, so this is a promise staff fulfil
   by hand. If you would rather not make it, the sentence comes out — but then
   the disclosure says nothing about how someone stops hearing from us.

3. **Anything in §1.1 or §2.1 you want worded differently.** These are drafts,
   not recommendations I am attached to.

---

## What happens once approved

The two disclosures are provisioned by a versioned migration (exactly as the
Custom Jewelry Version 2 acknowledgment was), the label constant is filled in,
and the one test asserting the 503 changes to assert a 200. No other code
changes.
