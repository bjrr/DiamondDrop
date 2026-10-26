# Privacy Policy — REVISED DRAFT, NOT PUBLISHED

> **Status:** draft for owner and counsel review. Do not publish.
> Every factual claim below traces to `LAUNCH-DATA-INVENTORY.md`, which was
> verified against the live production store, app and database. `[COUNSEL]`
> marks a legal judgement. Nothing is asserted that I could not verify.

**Effective date:** [TO BE SET ON PUBLICATION]
**Last updated:** [TO BE SET ON PUBLICATION]

---

## 1. Scope

This policy explains what personal information CaratForUs collects, why, who
we share it with, and what choices you have.

**We sell only in the United States.** This policy is written for US
customers.

`[COUNSEL]` No GDPR framing, as instructed. Confirm this is still right if
international sales are ever enabled.

## 2. What we collect

### Information you give us

- **Contact and order details** — name, email address, shipping address,
  billing address, and what you ordered.
- **Account information** if you create a customer account.
- **Messages you send us** through the contact form, by email, or in a
  warranty claim, custom-jewelry request or quote submission.
- **Photographs you upload** with a warranty claim or custom-jewelry
  request.
- **Quote evidence** you submit under Let Us Beat Your Quote.

### Information created by your transaction

- **Order, payment-status and fulfilment records**, including which payment
  method you chose and whether a bank payment was received and verified.
- **Acknowledgment records.** When you accept a material term — Final Sale,
  a return policy, a cancellation term — we record which exact version of
  that text you accepted and when. This is how we can show what you actually
  agreed to.
- **Claim, return and warranty records**, including our inspection findings
  and the remedy chosen.

### Payment information we do **not** receive

**We never see or store your full card number.** Card payments are handled
by Shopify's checkout and its payment processor.

For bank payments (Zelle or domestic wire), **you send funds to us** — we do
not collect or store your online-banking credentials. We see what your bank
or payment service includes with the transfer.

### Information we do **not** collect

**We do not record your IP address or your browser user agent** when you
accept a term on our site. Our systems have the capability to, and we
deliberately do not use it.

> ⚠️ This corrects an earlier statement. Previous draft copy
> (`MVP1-STOREFRONT-COPY.md` Part 5) said acknowledgments retain IP address
> and user agent. **That was wrong.** Production holds 23 acknowledgments,
> **none** with an IP address or user agent recorded.

## 3. Cookies, analytics and advertising

**We do not run any analytics, advertising or tracking pixels of our own.**
There is no Google Analytics, Google Tag Manager, Meta pixel, TikTok pixel,
Klaviyo, Segment or Hotjar on this site. We verified this against the live
theme.

Our store runs on **Shopify**, and Shopify operates its own first-party
analytics and the cookies necessary to run a storefront, a cart and a
checkout. That is part of operating on their platform. Shopify's own privacy
practices apply to what they collect: https://www.shopify.com/legal/privacy

`[COUNSEL]` Confirm this accurately characterises the controller/processor
relationship for Shopify's platform analytics, and whether the cookie
disclosure needs to be more granular.

## 4. Why we use your information

- To take, fulfil and ship your order.
- To take and verify payment, including confirming a bank payment arrived.
- To run Group Buy campaigns — tracking progress, deadlines and settlement.
- To handle returns, warranty claims, custom-jewelry projects and quote
  submissions.
- To contact you about your order.
- To keep records we are required to keep, and records we need to resolve a
  dispute or chargeback.
- To detect and prevent fraud, and to keep the site secure.

**We do not send marketing email unless you ask us to.**

## 5. Who we share it with

We share personal information only with the service providers who make the
business run. **This is the complete list**, verified against our live
production configuration:

| Provider | What they do | What they receive |
|---|---|---|
| **Shopify** | Our store, checkout, orders and customer accounts | Name, email, addresses, order history, account details |
| **Fly.io** | Hosts our application and database | The records described in this policy |
| **Resend** | Sends our transactional email | Your email address and the contents of the message |
| **Cloudflare R2** | Stores photographs you upload | Warranty-claim and custom-jewelry images |

Card payments are processed through Shopify's checkout and its payment
processor.

We may also disclose information when the law requires it, to enforce our
terms, to protect against fraud, or in connection with a sale or
reorganisation of the business.

### We do not sell your personal information

**We do not sell your personal information, and we do not share it for
cross-context behavioural or targeted advertising.** We verified this: there
is no advertising or analytics integration in production, and no advertising
provider receives data from us.

The providers above process data **on our behalf and under our
instructions**, to deliver a service we asked them for. That is ordinary
service-provider processing, not a sale.

## 6. How long we keep it, and what we delete

We keep personal information for as long as we need it for the purpose we
collected it, and then for as long as the law requires or allows.

**We keep certain records even after a relationship ends**, because we need
them for:

- completed transactions and their payment records;
- returns, RMAs and the evidence behind a refund decision;
- warranty claims and inspection findings;
- fraud prevention and security;
- tax, accounting and regulatory obligations;
- actual or anticipated legal claims, and dispute or chargeback records.

### Our evidence records

Some of our records are deliberately **append-only** — they cannot be edited
or deleted after they are written. That design exists so that what we
decided, and why, can be shown accurately later: it protects you in a
dispute as much as it protects us.

**Most of these records identify you only by reference** — an internal
pointer to your customer or order record — rather than by storing your name
or address directly. When we delete or de-identify your customer record,
those pointers no longer identify you.

`[COUNSEL]` **This is the one real tension, and it is live.** See
`LAUNCH-DATA-INVENTORY.md` §B4. One append-only table
(`shipment_address_change_event`) stores postal addresses directly and cannot
be deleted from at the database level. **It is currently empty**, so the
question can be settled before it ever holds real data. Three options are set
out in the inventory. Counsel should pick one, and the public wording above
should be checked against whichever is chosen.

**A database constraint is not, by itself, a legal reason to keep personal
data.** Where we keep something, it is because one of the purposes listed
above applies — not merely because a table is append-only.

## 7. Your choices and rights

**Depending on where you live and subject to applicable law, you may have
certain rights regarding your personal information.** These may include the
right to know what we hold, to get a copy, to correct it, and to ask us to
delete it.

### How to ask

- Our **contact form**: `/pages/contact`
- **Email:** orders@caratforus.com

**We will respond within the time required by applicable law.** We may need
to verify your identity before acting on a request, so that we do not
disclose your information to someone else.

### About deletion

We will **delete or de-identify your personal information when the law
requires us to**, subject to the retention needs in Section 6. Where we must
keep a record, we will tell you, and we will reduce what identifies you where
we reasonably can.

**We will not promise to delete everything unconditionally**, because for
some records — tax, dispute and warranty evidence — that would not be
truthful.

`[COUNSEL]` Which state privacy statutes actually bind us at launch volume
should be confirmed. The wording above describes our real practices without
claiming a specific statute applies.

## 8. Children

Our store is not directed to children under 13, and we do not knowingly
collect their personal information.

## 9. Security

We use access controls, encryption in transit, and least-privilege access to
our systems and to Shopify. Our bank-payment details are held as
server-side secrets and are never stored alongside customer records. No
system is perfectly secure, but we take this seriously.

## 10. Changes

We may update this policy. The effective date above shows when it last
changed.

## 11. Contact

**Email:** orders@caratforus.com
**Contact form:** `/pages/contact`

> **Note on the live policy:** the current published version contains the
> broken sentence *"please call  or email us at orders@caratforus.com"* — a
> reference to a phone number that does not exist. This draft removes it.
> See the delivery note; the discrete fix to the live page is still
> outstanding because neither Shopify app holds a shop-policy scope.

---

## What changed from the live policy

| Area | Change | Why |
|---|---|---|
| Broken phone sentence | Removed | References a telephone number that does not exist. **No number invented.** |
| IP address / user agent | Removed the claim that we collect them | Verified false — 23 acknowledgments, 0 with either |
| Service providers | Replaced generic list with the four actually used | Instruction: inventory real production use, don't copy a template |
| Cloudflare R2 | Named correctly | Code uses the S3-compatible client; the endpoint is R2, not AWS |
| Analytics | Stated plainly that we run none, and that Shopify runs its own | Verified against the live theme |
| Sale / targeted advertising | Explicit "we do not", with the service-provider distinction | Instruction: don't call ordinary processing a sale |
| Deletion | Honest conditional wording | Instruction: do not promise unconditional deletion |
| Append-only records | Explained in plain language, with the reference-not-identity point | Instruction: don't use `no_delete` as the legal justification |
| Rights | Owner's exact sentence | Instruction |
| Contact channels | Form + orders@caratforus.com only | Instruction: no phone, SMS, chat, hours, or fabricated privacy address |
| GDPR framing | None | US-only |
