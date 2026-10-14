# MVP1 storefront copy — drafts for owner review

**Status: DRAFT. Nothing here is published.** These are proposed bodies for
the Shopify pages that currently have none. Paste into Shopify Admin only
after review.

---

## How to read this document

Every block is tagged, because the three kinds carry very different risk:

| Tag | Meaning | What review it needs |
|---|---|---|
| 🔒 **LOCKED** | Already in the repository as canonical policy, quoted here only so you can see what the page will show beneath the framing. **Do not retype it into Shopify.** The page renders it live from `policy_version`. | None — changing it is a policy change, made in the repo, not here |
| ✍️ **EDITORIAL** | New customer-facing prose. Describes only things already true in the repo. Creates no new obligation. | Your read for tone and accuracy |
| ⚖️ **LEGAL — NEEDS COUNSEL** | New legal language. A real commitment to customers once published. | A lawyer, and your explicit decision |
| ❓ **OPEN** | A blank I could not fill from the repo. Needs a business answer before the page can go live. | You |

**Why the policy pages read the way they do.** Each of the six quotes its
terms live from the same `policy_version` rows a customer accepts at
checkout, through `sections/policy-terms.liquid`. That is deliberate: a page
that retyped a term would drift from the sentence we hold evidence of, and
the first anyone would notice is a dispute where our own page contradicts
our own record. **So the bodies below add framing above the quoted block and
never restate a term.** Where a draft sentence below looks like it is
getting close to restating one, that is a bug in the draft — say so and I
will cut it.

The canonical terms are written in the first person ("I understand that…"),
because that is what they are: the words shown at the moment of acceptance.
On a standalone page that reads oddly without framing. Fixing that is most
of what these bodies are for.

**Three rules every line below obeys**, from `CLAUDE.md`:
- Never the words *card fee*, *surcharge* or *cash discount*, and never the
  internal percentage.
- Group Buy surfaces lead with one Regular/Card price and note that lower
  pricing is available with Bank Payment — never both prices side by side.
- Material terms are never hidden, softened or buried.

---

# Part 1 — the six policy pages

## 1.1 Returns and Cancellations (`policy-returns`)

✍️ **EDITORIAL — proposed body**

> Most things we sell can be returned. A few cannot, and we say which on the
> product itself before you buy, never afterwards.
>
> If you want to return a Buy Now purchase, start by emailing
> orders@caratforus.com. We will tell you whether the item qualifies, and if
> it does we will issue a return authorisation with the address and the
> deadline. Please do not send anything back before you have that — an
> unannounced parcel is one we cannot match to an order or insure.
>
> Return shipping is arranged and paid by you, and must be tracked and
> insured for the full value. That is not us being difficult: an uninsured
> parcel that disappears leaves neither of us with a remedy.
>
> The exact terms you agreed to are below.

🔒 **LOCKED — rendered beneath, not retyped:** *Returning a Buy Now purchase*
(1 term, group `returns`).

❓ **OPEN:** the body above deliberately does not state the RMA window, the
restocking figure, or how outbound shipping is treated, because those are in
the locked term and restating them is how the two drift. Confirm you are
happy for the page to carry no numbers of its own.

---

## 1.2 Warranty (`policy-warranty`)

✍️ **EDITORIAL — proposed body**

> Every piece carries a one-year limited warranty against manufacturing
> faults. It covers workmanship — a setting that fails, a clasp that was
> never right. It does not cover accidents, ordinary wear, loss, or damage
> from repairs done elsewhere.
>
> To make a claim, use the Warranty Claim form and include clear photographs
> of the problem. We may ask you to send the piece in so we can look at it
> properly; if we do, inbound shipping is arranged and paid by you, and must
> be tracked and insured.
>
> Once we have inspected it we will tell you what we are going to do about
> it. The terms you agreed to are below.

🔒 **LOCKED — rendered beneath:** *Making a warranty claim* (1 term, group
`warranty`).

⚖️ **LEGAL — NEEDS COUNSEL:** the exclusion list ("accidents, ordinary wear,
loss, or damage from repairs done elsewhere") is a summary of the warranty's
scope. It matches `docs/WARRANTY-CLAIMS.md`, but an exclusion list on a
public page is the sort of thing a customer later relies on. Have it read.

**Not said, on purpose:** the internal local-jeweller repair option. Locked
policy makes it an internal choice, not a customer entitlement, so it must
not appear here.

---

## 1.3 Luxury Steals (`policy-luxury-steals`)

✍️ **EDITORIAL — proposed body**

> Luxury Steals are a small number of pieces offered at a price we cannot
> repeat. When one sells, it is gone — we are not holding more in the back.
>
> **Everything in Luxury Steals is final sale.** No returns, no exchanges,
> no cash refunds, no merchandise credit. Please buy from this section only
> if you are certain, and ask us anything you want to know first; we would
> much rather answer questions than have you stuck with something.
>
> Final sale does not take away your warranty. If a Luxury Steal turns out
> to have a manufacturing fault, the one-year limited warranty applies to it
> exactly as it does to anything else we sell.
>
> You will be asked to confirm you understand this before you can buy. The
> wording is below.

🔒 **LOCKED — rendered beneath:** *Luxury Steals are final sale* (1 term,
group `luxury-steals`).

**Why the warranty paragraph is there:** `docs/LUXURY-STEALS.md` is explicit
that final sale must not be used to deny a legitimate covered claim. A page
that says "final sale" four times and never says that reads as though it
does.

---

## 1.4 Group Buy (`policy-group-buy`)

✍️ **EDITORIAL — proposed body**

> A Group Buy is simple: the more people who order, the lower the price
> everybody pays. You order at today's price, and if the group reaches the
> next tier before the campaign closes, you move down to it too. You never
> pay more than the price you ordered at.
>
> Your order counts toward the group's progress straight away. If you pay by
> bank, it counts from the moment you place it, not from when the money
> arrives.
>
> The price shown on a campaign is the Regular/Card price. A lower price is
> available when you pay by bank, and you choose which before you order.
>
> When the campaign closes, the final tier is settled and the price is
> fixed. If you ordered earlier at a higher tier, we work out the difference
> and refund it to the way you paid, after review.
>
> Group Buy orders can be cancelled only on the terms below, which you will
> be asked to confirm before ordering.

🔒 **LOCKED — rendered beneath:** *Cancelling a Group Buy order*, *Asking to
hear if a Group Buy returns*, *Requesting a new Group Buy* (3 terms, group
`group-buy`).

**Checked against rule 13:** one price named (Regular/Card), the bank
alternative noted without a figure, no side-by-side pair, no percentage, and
none of the forbidden fee words.

❓ **OPEN:** the body does not mention the 48-hour bank payment window or the
automatic extension. Those are in the payment-instructions email and the
checkout flow, where they are actionable. Say if you want them on the page
too — I would rather add them deliberately than have you find them missing.

---

## 1.5 Custom Jewelry (`policy-custom-jewelry`)

✍️ **EDITORIAL — proposed body**

> Tell us what you have in mind and we will design it with you. The
> conversation happens by email, at whatever pace suits you — there is no
> form that decides your piece for you.
>
> When you are ready for us to start designing, there is a $49 Design
> Deposit. It pays for the design work, and it comes off the price if you go
> ahead. If we finish the design we agreed on and you decide against it, we
> refund the $49 — no questions asked.
>
> You will see renders before anything is made, and nothing goes into
> production until you have approved the final design in writing. That
> approval is the point of no return, because from then on we are making one
> specific thing for one specific person.
>
> **A finished custom piece is final sale.** It is yours, made to your
> approved design, and we cannot resell it.
>
> The three things you will be asked to agree to are below.

🔒 **LOCKED — rendered beneath:** *The $49 Design Deposit*, *Approving your
final design*, *Custom jewelry is final sale* (3 terms, group
`custom-jewelry`; the final-approval term serves at **v2**).

**Both deposit sentences are grounded, not invented.** README "$49 Design
Deposit": *"Credit it toward the final jewelry price if the customer
proceeds"* and *"If CaratForUs completes the agreed design/CAD stage and the
customer declines to proceed, refund the $49 with no questions asked."*

The refund sentence is included deliberately. It is a commitment in the
customer's favour, and leaving a term like that off the page while quoting
the restrictive ones would be hiding a material term — just in the
direction nobody complains about.

**Not said, on purpose:** the third deposit rule — that abandoning before
the design stage completes makes a refund discretionary. It is a genuine
term, but stating it flatly on a marketing page reads as a threat, and the
nuance ("may depend on work completed") does not compress into a sentence.
❓ Decide whether it belongs here or only in the deposit acknowledgment.

---

## 1.6 Let Us Beat Your Quote (`policy-quote-match`)

✍️ **EDITORIAL — proposed body**

> Found the same piece cheaper somewhere else? Send us the quote and we will
> look at it properly.
>
> Not every quote works the same way, and this is the part worth reading
> before you send one. A **recent written custom quote** from a real
> competitor, for something genuinely comparable, is the kind we can offer a
> guarantee on. Older quotes, active online listings and other companies'
> group buys we will still review and still often beat — but they come with
> no guarantee attached, because we cannot verify them the same way.
>
> We will tell you which category yours falls into before you decide
> anything.
>
> We compare like with like: the same metal, the same stone specification,
> the same workmanship. A lower number for a different piece is not a lower
> price for the same piece, and we will show you our reasoning rather than
> simply saying no.
>
> The six terms that govern this are below.

🔒 **LOCKED — rendered beneath:** *What we'll match*, *Proving a competitor
quote is genuine*, *A recent custom quote*, *An older quote*, *A competing
Group Buy*, *An active online listing* (6 terms, group `quote-match`).

**Checked against the amendment,** which controls: only qualifying verified
recent custom quotes get the guarantee/fallback; online listings and
competing Group Buys are review-only. The draft says exactly that and
promises nothing for the review-only categories.

**Not said, on purpose:** the 90-day fallback expiry. It is in the locked
terms below and restating a deadline is the highest-risk kind of
duplication.

---

# Part 2 — About

✍️ **EDITORIAL — proposed page**

> ## About CaratForUs
>
> Fine jewelry is sold strangely. The same ring can cost three times as much
> on one side of a street as the other, and almost nobody can tell you why.
> Buy it from overseas and the price finally makes sense — right up until
> something is wrong with it, and you discover there is nobody to call.
>
> CaratForUs exists in the gap between those two experiences. We price
> honestly, we tell you exactly what you are getting, and when something
> needs sorting out you are dealing with us, here, not with a time zone.
>
> **We inspect before you receive.** Every piece is checked by us before it
> ships, so the first person to find a problem is us and not you.
>
> **We are one accountable seller.** Not a marketplace, not a middleman
> passing you down the chain. If it came from us, it is ours to put right.
>
> **We tell you what it is.** Metal, weight, stone specification, and
> whether an image is a CAD render, a photograph of the actual piece, or an
> AI visualisation. Labelled, every time.
>
> **We support it after you have it.** Domestic support, and a one-year
> limited warranty against manufacturing faults.
>
> That is the whole proposition: better value, better protection, a better
> buying experience.

**Grounding:** every claim traces to README "Core Value Proposition" and
"Product Visuals / Technical Details". No factory, country or supply-chain
reference, per the README's positioning guidance.

❓ **OPEN:** this page has no founder story, no photograph and no founding
year, because I have none of those. An About page usually wants one. Give me
two or three sentences about why you started this and I will work them in.

---

# Part 3 — Why Buy From Us

✍️ **EDITORIAL — proposed page**

> ## Why buy from us
>
> ### The price makes sense
> We work from the actual cost of the metal and the stones, plus a margin we
> can defend. No invented list price to discount from. When you pay by bank
> transfer instead of card, the price is lower — because our costs are, and
> we pass that through rather than keeping it.
>
> ### You see it before it ships
> Every piece is inspected before it leaves us. Renders are labelled as
> renders, photographs as photographs, and AI visualisations as AI
> visualisations, so what you are looking at is never in doubt.
>
> ### Somebody answers
> Email orders@caratforus.com and a person here replies. Returns, warranty
> claims and questions are handled by the same company that sold you the
> piece.
>
> ### It is covered
> One year, against manufacturing faults. Every outbound shipment is insured
> for its full value and tracked, and anything over $100 needs a signature —
> yours, not a doorstep.
>
> ### Buy it your way
> Buy it now at today's price. Join a Group Buy and let the price fall as
> more people join. Or have something made that does not exist yet.

**Grounding:** README "Core Value Proposition", "Shipping, Insurance &
Signature" ($100 signature threshold, full-value insurance, tracking),
`docs/BANK-CARD-PRICING.md`.

**Checked:** "the price is lower when you pay by bank transfer" states the
bank price is lower without naming a percentage and without the forbidden
words. This is the approved way to describe it.

---

# Part 4 — Terms of Service

⚖️ **LEGAL — NEEDS COUNSEL. DO NOT PUBLISH AS-IS.**

I can draft the shape of this, but a Terms of Service is the contract
between you and every customer, and several clauses that belong in one are
business decisions I have no basis to make. **What follows is a skeleton
with the decisions marked, not finished copy.**

**Sections it needs, and where the content comes from:**

| Section | Source | Status |
|---|---|---|
| Who we are, how to reach us | orders@caratforus.com | ✍️ ready |
| What we sell; that specifications are as described | README | ✍️ ready |
| Pricing, and that prices change | `docs/BANK-CARD-PRICING.md` | ✍️ ready |
| Payment methods, and that bank payment must be received and verified before an order is secured | README, Group Buy §24 | ✍️ ready |
| Order acceptance — that placing an order is an offer we may decline | — | ❓ needs your decision |
| Group Buy mechanics, tier settlement, refunds after review | README | ✍️ ready |
| Returns, warranty, final-sale categories — **by reference to the policy pages, not restated** | the six pages | ✍️ ready |
| Shipping, insurance, the $100 signature rule, title and risk of loss | README | ❓ when does title pass? |
| Limitation of liability | — | ⚖️ counsel |
| Warranty disclaimer beyond the express one-year warranty | — | ⚖️ counsel |
| Governing law and venue | — | ❓ which state? |
| Dispute resolution — arbitration, or courts? | — | ❓ a real business decision |
| Changes to these terms | — | ⚖️ counsel |

❓ **The four I cannot answer for you:**
1. **Governing law and venue** — which US state.
2. **Arbitration or not.** Binding arbitration with a class-action waiver is
   common in US ecommerce and is a genuine trade-off. This is yours.
3. **When title and risk of loss pass** — on handover to the carrier, or on
   delivery. It decides who bears an insured loss in transit, so it must
   agree with how you actually handle claims.
4. **Order acceptance** — whether you reserve the right to decline an order
   after it is placed, which matters for mispriced items.

Once those four are settled I can write the full document in one pass.

---

# Part 5 — Privacy Policy

⚖️ **LEGAL — NEEDS COUNSEL. DO NOT PUBLISH AS-IS.**

Same position. But unlike the Terms, most of a privacy policy is a
*statement of fact* about what the system actually does — and that I can
establish from the repository. Here is what is true today, which is the raw
material a lawyer needs:

**What is collected, from the code:**

| Data | Where from | Why |
|---|---|---|
| Name, email, shipping address | Shopify checkout | Fulfilling orders |
| Payment details | **Shopify / the payment processor — never stored by us** | Taking payment |
| Bank payment reference and status | Group Buy and Buy Now bank checkout | Matching received funds to an order |
| Order and campaign history | Shopify + our database | Support, returns, settlement |
| Acknowledgment evidence — the exact text shown, the caption pressed, the timestamp, and **IP address and user agent** | `acknowledgment` table | Proving what a customer was shown and agreed to |
| Email address alone | Group Buy demand capture | Telling you if a campaign returns |
| Photographs you upload | Warranty claims, custom jewelry intake | Assessing a claim; designing a piece |
| Competitor quotes you send | Let Us Beat Your Quote | Reviewing the quote |

**Points worth a lawyer's attention, flagged rather than drafted:**

- **IP address and user agent are retained with acknowledgments.** This is
  deliberate and defensible — it is dispute evidence — but it is personal
  data and a privacy policy must disclose it plainly.
- **Retention.** The acknowledgment and evidence tables are append-only by
  design: rows cannot be deleted. ❓ That interacts with deletion requests
  and needs a stated, lawful answer, not silence.
- **Deletion and access requests.** ❓ No process exists. One is needed
  before publishing a policy that promises one.
- **Processors to name:** Shopify, the payment processor, the email provider
  (Resend), Fly.io (hosting and database), and the object storage used for
  uploads. ❓ Confirm the list is complete.
- ❓ **Which privacy regimes apply** — CCPA/CPRA if you have California
  customers, and GDPR if you sell into the EU/UK. This decides how much of
  the document exists at all.

**What I will not do:** write a privacy policy that promises a deletion
process the system cannot perform. The append-only evidence tables are a
deliberate, correct design decision, and the policy has to tell the truth
about them.

---

# Part 6 — what I need from you

In the order that unblocks the most:

1. **About** — two or three sentences on why you started CaratForUs. This
   is the only thing standing between the About page and publication.
2. **Custom Jewelry §1.5** — should the page mention that abandoning before
   the design stage completes makes the refund discretionary?
3. **Group Buy §1.4** — should the page state the bank payment window, or
   leave it to checkout and the email?
4. **Terms of Service** — the four decisions in Part 4.
5. **Privacy Policy** — which regimes apply, and whether a deletion process
   exists or needs building.

Items 1–3 are small and unblock five pages. Items 4 and 5 are genuinely
separate work with a long lead time, and should not hold up the six policy
pages.
