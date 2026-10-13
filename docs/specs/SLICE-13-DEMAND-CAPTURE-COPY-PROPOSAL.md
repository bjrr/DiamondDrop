# Slice 13 — demand capture copy

**Status: APPROVED by the owner 2026-10-12, and live.** The two disclosures
are provisioned by migration `20261012030000_group_buy_demand_capture_copy`;
the labels and confirmation are in
`app/app/domain/groupbuy/demandCaptureCopy.ts`.

**The owner's structural decision: the submit button IS the affirmative
action.** No consent tickbox. The disclosure is shown above the form and
pressing the button is the act — README requires low-friction interest
capture, and a tickbox is a step. The evidence is unaffected: each
acknowledgment records the exact disclosure shown *and* the exact caption
pressed, so a row can never describe words a customer did not see. The labels
in §1.2 and §2.2 are therefore button captions.

This resolves `STOREFRONT-COPY-PROPOSAL.md` §1.7, which recorded: *"In locked
MVP1 scope, but it belongs to Slice 13 ... No copy drafted."*

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

## Decisions

1. **Tickbox or button — DECIDED: button.** The submit button is the
   affirmative action; there is no consent tickbox. See the status note above.

2. **Removal requests — SHIPPED AS DRAFTED, and this is the one standing
   commitment in here.** §1.1 says "you can ask us to remove it at any time".
   There is no self-service removal in MVP1, so **staff fulfil this by hand**:
   a request to be removed means deleting that person's
   `group_buy_demand_signal` row. Nothing in the product does it for them, and
   nothing reminds them. If that turns out to be more than you want to own,
   the sentence comes out of a version 2 of the disclosure — but then nothing
   tells someone how to stop hearing from us, which is worse.

3. **Wording — approved as drafted.** §2.1 was not shown in the approval
   prompt's preview, only §1.1 was; it is live as written above. A revision is
   a new `policy_version`, not an edit, so say the word and it is one
   migration.

---

## What shipped

- `policy_version` rows for both slugs, version 1, by migration.
- Both disclosures and both captions registered in
  `requiredPolicyVersions.ts`, so `/health` reports a missing row at deploy
  time rather than letting customers quietly hit a 503 nobody notices.
- The intake route still fails closed on a missing row — reaching that now
  means the migration has not run in that environment.
