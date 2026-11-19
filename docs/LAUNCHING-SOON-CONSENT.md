# Launching Soon signup — email and SMS marketing consent

Owner decision 2026-11-18. Supersedes nothing in `docs/LAUNCHING-SOON-SIGNUP.md`
except where noted; that document still describes the confirmation emails and
the `customers/create` trigger, which are unchanged.

---

## What was actually there first

The brief said to inspect before changing, and the inspection changed the plan
twice.

| | Found |
|---|---|
| Live form | `snippets/first-access-v2-form.liquid`, via `sections/first-access-v2.liquid` |
| Where it renders | the COMING SOON **homepage** (`templates/index.json`) **and** `/pages/first-access` |
| Fields | first name, last name (both required), email (required), mobile (optional), 6 interest chips |
| First name | native `contact[first_name]` → `Customer.firstName` |
| Email | native `contact[email]` |
| Phone | collected, **discarded by Shopify's native form**, re-sent to `/apps/carat/first-access-phone` and stored as `custom.first_access_mobile` — never `Customer.phone` |
| `first-access` tag | hidden `contact[tags]`, plus interests folded in by the script |
| `customers/create` | subscription `2105460752602` → `firstAccessSignupHandler` |
| Confirmation email | subject **"You're on the CaratForUs list"**, greets by first name, falls back to **"Hi there,"** |
| Internal notification | `orders@caratforus.com` |
| Architecture | **both** — native form/customer/tags, plus a custom proxy route, webhook handler and email |

Two findings mattered more than the rest.

**The page is not the one the template name suggests.** `/pages/first-access`
has `templateSuffix: first-access-v2`, so it renders V2 — while
`templates/page.first-access.json` still names the V1 section and is dead.
V1 survives only at `/pages/first-access-v1` as an archived reference. An edit
to the obvious-looking file would have changed nothing a visitor sees.

**Email consent was being asserted, not collected.** The form carried:

```html
<input type="hidden" name="contact[accepts_marketing]" value="true">
```

Every signup was recorded in Shopify as email-marketing `SUBSCRIBED` without
the customer agreeing to anything, with no wording shown and therefore no
wording to produce later. SMS consent did not exist in any form — correctly,
since the form's own comment insisted a phone number is not permission to text.

A third finding, incidental but worth recording: the fence test guarding all of
this (`firstAccessPhoneFence.test.ts`) scanned `first-access.js`, the **V1**
asset. It had been watching a file no visitor loads. It now scans both, and V2
is the one that matters.

## What changed

### The form

The hidden field is gone. In its place, two independent, **unchecked**
checkboxes, neither required, with the Privacy Policy and Terms linked beside
them:

| | Control | Wording |
|---|---|---|
| Email | checkbox bound to `name="contact[accepts_marketing]"` | *Email me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions.* |
| SMS | checkbox with **no** `name`, read by the script | *Text me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions. Message frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe.* |

**Email consent is native; SMS cannot be.** `contact[accepts_marketing]` is a
field Shopify's own customer form understands, so an unchecked box is omitted
by the browser and Shopify records no subscription — no code decides that. This
is the simplest Shopify-native answer and needs no scope, no mutation and no
custom logic. Shopify has **no** equivalent `contact[...]` field for SMS, so
that box deliberately carries no `name`: a named input would be posted and
ignored, which is how a consent gets quietly lost.

The mobile field stays optional and its label stays exactly
`Mobile number (optional)` — owner decision 2026-11-05, which an earlier draft
of this work reopened for no benefit and then reverted. The checkbox directly
below already explains what a number is for.

Ticking SMS with no number is **refused with a message**, not silently dropped:
Shopify will not hold an SMS consent for an account with no phone, so the
consent would vanish. The script says so and focuses the number field.

### Where consent is recorded

| Channel | Permission (operative) | Proof (ours) |
|---|---|---|
| Email | Shopify `emailMarketingConsent`, set by the native form | `Acknowledgment` row, slug `first-access-email-marketing-consent` |
| SMS | Shopify `smsMarketingConsent` via `customerSmsMarketingConsentUpdate`, `SUBSCRIBED` / `SINGLE_OPT_IN` | `Acknowledgment` row, slug `first-access-sms-marketing-consent` |

**Shopify holds the permission; we hold the proof of how it was obtained.**
Neither substitutes for the other. Shopify's record is what a sending platform
reads and what a STOP reply unsubscribes — so consent has to live there, and
nothing here duplicates it. What Shopify has no field for is *the sentence the
customer read*, which for a marketing permission is the part most worth being
able to produce later. That is what the acknowledgment adds, with the policy
version, the timestamp, the customer reference, and the user agent.

`SINGLE_OPT_IN`, not `CONFIRMED_OPT_IN`: one ticked box on one web form, with
no second confirmation step. Claiming more would overstate the evidence held.

The **same instant** is written to Shopify and to the acknowledgment. Two
timestamps a second apart on one consent makes a trail harder to defend than no
trail.

`policy_version` is append-only by trigger, so a later rewording adds version 2
and leaves version 1 pointing at what existing subscribers actually agreed to.

### `Customer.phone` — a carve-out, not a reversal

Owner decision 2026-11-05 said the number goes to a metafield and "never to
`Customer.phone`", because mapping it was "deferred until the SMS/marketing
platform is chosen". Both halves of that reasoning expired:

- the platform question is settled **for consent** — it is Shopify, whichever
  sender is chosen later, because that is where STOP is honoured;
- Shopify **requires** a phone on the account before it will hold SMS consent
  (the mutation's own documentation), so a consent without `Customer.phone` is
  not expressible.

The half that has **not** expired is the important one: **a phone number is not
permission to text.** Every usable number still goes to the metafield;
`Customer.phone` and the consent happen only with an explicit opt-in. A
customer who types a mobile and leaves the box unchecked ends up exactly where
they would have before this change.

The two writes have a fixed order — phone, then consent — because the reverse
is not expressible. If the phone lands and the consent fails, the result is a
number we may not text, which is the safe direction and the pre-existing state.

### The confirmation SMS

Sent from the **proxy route**, immediately after Shopify confirms `SUBSCRIBED`
— not from `customers/create`, which sends the confirmation email. At webhook
time the SMS consent does not exist yet: it arrives on the separate request, so
a handler asking "does this customer have SMS consent?" there would be racing
the request that grants it.

136 characters, one GSM-7 segment, pinned by a test. It identifies the brand
(it is the first text from an unknown number), says what they joined, and
repeats the rates line and HELP/STOP. **No offer, no code, no link** — this is
the confirmation of a subscription, not the first campaign, and a link in an
unexpected SMS is what both carriers and customers read as spam.

### ⚠️ No SMS provider is configured — this is the one owner action outstanding

**Consent is recorded and correct today. Nothing can send a text yet.**

Shopify does not offer transactional SMS to apps; its SMS marketing is
delivered through installed apps rather than an API an app may call. Sending
therefore needs an account with a provider (Twilio or similar), which needs
credentials and a payment method — the owner's to arrange.

So the seam is built and the send is gated: `resolveSmsPort` reports
`configured: false` with a reason, the route logs
`firstaccess.sms_confirmation_unconfigured`, and the signup completes normally.
Nothing claims a text was sent.

**This ordering is deliberate.** A customer who opts in today is properly
subscribed in Shopify today and becomes reachable the moment a provider exists
— rather than being asked again later because we declined to write down what
they had already told us.

To finish it: set `SMS_API_KEY` and `SMS_FROM`, and add one adapter behind
`SmsPort`. No flow changes — the consent gate, the message copy and the
evidence are all independent of who sends.

## What was preserved

- **The `first-access` tag**, still set by the same hidden field.
- **The confirmation email**, subject and first-name personalisation and the
  `Hi there,` fallback, all untouched.
- **The internal notification** to `orders@caratforus.com`.
- **The existing subscriber.** Verified after deploy: email still
  `SUBSCRIBED` / `SINGLE_OPT_IN` with its original `2026-11-04` timestamp, all
  seven tags intact, mobile metafield intact — and **no SMS consent**, which
  they never gave. A number on file is not a permission, and back-filling one
  would have been exactly the defect this work removes.
- **No duplicate subscribers.** The flow never creates a customer; Shopify's
  native form does, matching on email. Evidence is idempotent per customer per
  channel, so a resubmit or the script's reload-handoff path cannot pile up
  rows.
- **COMING SOON is still live. LAUNCH is still unpublished.**

## Verified on the live site

The five changed theme files went to the live theme after a 434-file backup
(`.theme-backups/coming-soon-188329230554-20261119/`), with explicit `--only`
and `--nodelete`; the push log mentions no deletion.

Rendered form, fetched from `caratforus.com/pages/first-access`:

| Check | Result |
|---|---|
| hidden `accepts_marketing` | **gone** |
| email consent | `type=checkbox`, `name="contact[accepts_marketing]"`, unchecked, not required |
| SMS consent | `type=checkbox`, **no `name`**, unchecked, not required |
| both sentences | rendered verbatim |
| Privacy Policy + Terms | linked |
| `first-access` tag | still set |
| mobile | still optional |

The minified live asset keeps everything that has to survive minification:
`CONSENT_COPY_VERSION="2026-11-18"`, `emailConsent`, `smsConsent`,
`consentCopyVersion`.

Production policy rows: both slugs at version 1, content hashes matching their
text.

## What keeps it honest

- `marketingConsentCopy.test.ts` — reads the **real** theme locale JSON and the
  **real** migration SQL off disk and compares them to the module byte for
  byte. Three places hold this wording and only the locale is what a customer
  sees; if the module drifts, every consent record stores a sentence nobody was
  shown. Also asserts the form has no hidden consent field, pre-checks neither
  box, requires neither, and renders from the locale rather than inline.
- `firstAccessPhoneFence.test.ts` — the mutation allow-list (exactly
  `metafieldsSet`, `customerUpdate`, `customerSmsMarketingConsentUpdate`, and
  nothing else), `=== true` on both consents, `Customer.phone` written only
  inside the SMS function, no email-consent write, consent recorded before any
  send, and no log line carrying the number.
- `signupSms.test.ts` — one GSM-7 segment, brand first, HELP and STOP present,
  no link or offer.
- `marketingConsentEvidence.test.ts` (integration) — the row stores the
  policy's own text, the channels stay independent for one customer, evidence
  is idempotent per channel, and the policy rows refuse being edited.
