# Slice 12 — FAQ copy

**Status: APPROVED by the owner 2026-10-12.** All six previously undecided
answers are resolved and incorporated verbatim; the rest stands as drafted.

Ten categories, per README "FAQ / Trust Architecture": Group Buys, Pricing &
Refunds, Production & Delivery, Materials & Stones, Ring Sizing, Custom
Jewelry, Warranty & Repairs, Returns & Cancellations, Payments, and Shipping
& Insurance — plus Contact, which is its own Slice 12 page.

**ONE THING STILL GATES PUBLICATION:** `support@caratforus.com` must be
provisioned and tested. The owner was explicit that an unprovisioned address
is a setup task, never a reason to substitute a different one.

---

## How to read this

Every answer below is marked:

- **[LOCKED]** — the facts come from a locked policy document or the README,
  cited. I have restated them in plain language; check the restatement, not
  the facts.
- **[NEW]** — I wrote it. It makes no promise the locked documents do not
  already make, but the words are mine and need your eye.
- **[OWNER-APPROVED 2026-10-12]** — the owner's own wording, used verbatim.
  These were the six questions I refused to answer without facts. Do not
  restyle them for consistency with the surrounding voice; they are decisions,
  not drafts.

**Material terms are quoted, not paraphrased.** Where an answer touches a term
a customer acknowledges, the page shows the authoritative sentence from
`policy_version` via `/apps/carat/policies` and the FAQ answer is the
explanation around it. That is why several answers below end by pointing at
the policy page rather than restating the rule a second time — see
`SLICE-12-CONTENT.md` §2.

**EXACTLY ONE TIMEFRAME IS PROMISED, AND IT IS DELIBERATE.** Decision 5
commits to initiating an approved refund within 5 business days — counted
from approval, after receipt and inspection, and ending at *initiate* rather
than at funds landing.

Nothing else here promises a date. Not production, not delivery, not repair.
`WARRANTY-CLAIMS.md` §12 forbids a warranty turnaround outright, decision 1
forbids a blanket production SLA, and a date is the single easiest promise to
make by accident — which is why the one real commitment is fenced on all
three sides.

---

## 1. Group Buys

### Q: What is a Group Buy? **[NEW]**

> A Group Buy is one piece, offered to a group at a price that falls as more
> people join. Each campaign has tiers: when enough units are ordered, the
> next tier unlocks and everyone in that campaign gets the better price —
> including people who ordered earlier.

### Q: If the price drops after I order, do I pay the lower price? **[LOCKED]**

*(README "Group Buy payment timing and close settlement")*

> Yes. When the campaign closes, every paid order gets the final unlocked
> tier price. If you paid more than that, we calculate the difference and
> refund it to the payment method you used. Refunds are reviewed and approved
> by our team before they go out, so they are not instant.

### Q: Can the price go back up, or the count go down? **[LOCKED]**

*(README "Group Buy Cancellation / Final Sale" — monotonic progress)*

> No. Once a tier unlocks it stays unlocked. If someone later cancels or does
> not pay, the published count does not fall and nobody gets repriced upward
> because of it.

### Q: Can I cancel a Group Buy order? **[LOCKED]**

*(README "Group Buy Cancellation / Final Sale")*

> Before the campaign closes, cancellation needs our approval — ask us. Once
> the campaign closes, the order is committed and there is no discretionary
> cancellation. Defects, wrong specifications, shipping damage, warranty
> matters and fulfilment failures are handled separately and are not affected
> by this.

### Q: I chose Bank Payment. How long do I have to pay? **[LOCKED]**

*(README "Group Buy payment timing and close settlement")*

> You have 48 hours, plus one automatic 48-hour extension. After 96 hours an
> unpaid order may be set aside internally — your order still counts toward
> the campaign's published progress. While the campaign is still open you can
> email us to reactivate the same order at the price you originally locked in.
> After the campaign closes, reactivation is at our discretion.

---

## 2. Pricing & Refunds

### Q: Why are there two prices? **[LOCKED]**

*(`BANK-CARD-PRICING.md` §6, §7 — and note the forbidden wording there)*

> Paying by bank costs us less to accept, so we pass that through. The Bank
> Payment Price is what you pay with Zelle, ACH, a bank transfer or a wire.
> The Regular/Card Price is what you pay by card. Both are shown before you
> order, and the product page tells you the exact dollar saving.

> ⚠️ **Do not let any revision of this answer introduce a percentage, or the
> words "surcharge", "card fee", "cash discount", or "cash price".**
> `BANK-CARD-PRICING.md` §6 forbids all of them by name. Dollar amounts only,
> and the term is always "Bank Payment Price".

### Q: Does the Bank Payment Price apply to tax and shipping too? **[LOCKED]**

*(`BANK-CARD-PRICING.md` §8, merchandise-only scope)*

> No — it applies to the merchandise. Tax, shipping, duties and other charges
> are not part of the saving.

### Q: When do I get a refund, and how long does it take? **[OWNER-APPROVED 2026-10-12 — decision 5]**

> Refunds go back to the way you paid. A Group Buy tier-adjustment refund is
> calculated automatically but approved by a person before it is sent.
>
> Once an eligible return has been received, inspected when required, and
> approved, CaratForUs will initiate the approved refund within 5 business
> days. Your bank or payment provider may take additional time to post the
> funds to your account. Refund eligibility and amount remain governed by the
> applicable return policy.

> ⚠️ **THE FIVE DAYS START AT APPROVAL, NOT AT REQUEST.** The owner was
> explicit: this wording must not be used to imply that submitting an RMA or a
> return request starts the clock. The sequence is received → inspected where
> required → approved → *then* five business days to initiate. Any rewrite
> that drops one of those steps changes what we have promised.
>
> **And it ends at "initiate".** We do not promise when the customer's bank
> makes the money visible, because we do not control it.

---

## 3. Production & Delivery

### Q: How long will my piece take? **[OWNER-APPROVED 2026-10-12 — decision 1]**

> Production and delivery timing varies by item. Ready-to-ship,
> made-to-order, Custom Jewelry, and Group Buy pieces may have different
> timelines. The applicable estimate will be shown on the product, campaign,
> or final approval page before purchase. Once your order ships, we'll send
> tracking information. Unless CaratForUs expressly states otherwise in
> writing, production and delivery dates are estimates and are not
> guaranteed.

> ⚠️ **NO BLANKET SLA, EVER.** The owner's decision is explicit: do not invent
> a universal "X–Y weeks" statement, and do not let one appear here later by
> way of a "helpful" clarification. Timing is per item.
>
> **THIS ANSWER CREATES AN OBLIGATION ON OTHER SURFACES.** It tells customers
> the estimate "will be shown on the product, campaign, or final approval page
> before purchase". Where an estimate applies, that surface must actually
> carry it — see the implementation note below.

### Q: How do I know where my order is? **[LOCKED]**

*(README "Shipping, Insurance & Signature")*

> Every shipment has tracking, and we send it to you.

---

## 4. Materials & Stones

### Q: What are CaratForUs pieces made from? **[OWNER-APPROVED 2026-10-12 — decision 2]**

> The materials and stones used in each piece are identified on the product
> page or, for Custom Jewelry, in the final design and specification package.
> Where applicable, we disclose the metal type and purity, gemstone type, and
> whether a diamond is natural or lab-grown. We source from multiple
> suppliers, so origin can vary by item. If an independent grading report,
> certification, treatment, sourcing statement, or specific origin applies to
> a piece, it will be stated for that item.

> ⚠️ **NO CATALOG-WIDE CLAIM, IN EITHER DIRECTION.** The owner enumerated what
> this answer must never imply: that every diamond is certified; that every
> diamond is natural; that every diamond is lab-grown; that every gemstone is
> untreated; that every item comes from a particular country; or
> "conflict-free" or any other sourcing certification without evidence
> supporting that specific claim.
>
> These are claims with legal weight and CaratForUs sources from multiple
> suppliers. **Product-specific facts control.** A later edit that tightens
> this into something reassuring and general is the failure mode.

### Q: Are the product images photographs of the actual item? **[LOCKED]**

*(README "Product Visuals / Technical Details"; CLAUDE.md "Clearly label CAD
renders, actual photos/videos and AI visualizations")*

> We label every image for what it is: a CAD render, an actual photograph, or
> an AI visualisation. Where an image is not a photograph of the exact item
> you will receive, it says so.

---

## 5. Ring Sizing

### Q: How do I find my ring size? **[NEW]**

> Use our ring size guide. If you are between sizes or unsure, ask us before
> ordering — it is much easier to get the size right the first time than to
> change it afterwards.

### Q: Can I return or exchange a ring that does not fit? **[LOCKED]**

*(`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §7, §8)*

> For a Buy Now purchase, a size or fit problem is a discretionary return and
> follows the Returns policy, including the time limits there. But a ring that
> has been resized, engraved, or otherwise altered after delivery is not
> eligible for a discretionary return. Custom Jewelry and Luxury Steals have
> their own rules — see those sections.

### Q: Can you resize a ring I already bought? **[OWNER-APPROVED 2026-10-12 — decision 3]**

> Many rings can be resized, but some designs cannot be safely resized or
> have limited sizing ranges. Contact CaratForUs before having sizing work
> performed so we can confirm whether your ring is eligible and whether any
> charge applies. Resizing itself is not a manufacturing defect. Damage caused
> by unauthorized third-party resizing, repair, alteration, or modification is
> not covered by the limited warranty. Work performed or expressly authorized
> by CaratForUs does not automatically void the rest of the warranty.

> ⚠️ **TWO OPPOSITE ERRORS ARE BOTH FORBIDDEN HERE.** Do not promise free
> resizing — it is design-dependent and may carry a charge. And do not state
> that resizing automatically voids the whole warranty: the owner's decision
> is narrower than `WARRANTY-CLAIMS.md` §1's "sizing changes" exclusion reads
> on its own, and work CaratForUs performs or authorises does **not**
> automatically void the rest of the cover.
>
> This answer also sits next to the returns rule: a ring **already resized
> after delivery** is not eligible for a discretionary return
> (`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §8). Both facts are true and
> neither cancels the other.

---

## 6. Custom Jewelry

### Q: How does a custom piece work? **[LOCKED]**

*(README "Custom Jewelry — MVP1 Locked Direction")*

> Tell us what you have in mind and we will talk it through by email. When we
> are ready to start real design work we charge a $49 Design Deposit, which
> comes off your final price. You approve the final design and specifications
> on a page we build for you, and then you buy it.

### Q: Is the $49 Design Deposit refundable? **[LOCKED]**

*(README "$49 Design Deposit")*

> If we finish the agreed design stage and you decide not to go ahead, we
> refund the $49, no questions asked. If you stop the process before that
> stage is finished, a refund is not automatic and depends on the work already
> done.

### Q: Can I change my mind after approving the design? **[LOCKED]**

*(README "Final Approval / Purchase")*

> Once you have approved the final design and specifications and bought the
> piece, the order is final sale — except for covered defects, incorrect
> specifications, shipping damage, or the piece materially not matching the
> design and specifications you approved.

---

## 7. Warranty & Repairs

### Q: What does the warranty cover? **[LOCKED — reuses approved wording]**

*(`WARRANTY-CLAIMS.md` §1; the examples sentence is the owner-approved
rewrite in `STOREFRONT-COPY-DECISIONS.md` §2.2, used verbatim)*

> Every CaratForUs piece carries a 1-year limited manufacturing warranty
> covering qualifying defects in materials, construction, setting or assembly
> under normal use. Examples may include defective solder joints, structural
> workmanship failures, setting defects, and defective clasps or mechanisms
> under normal use.

### Q: What is not covered? **[LOCKED]**

*(`WARRANTY-CLAIMS.md` §1)*

> Normal wear, scratches, dents, impact damage, prongs bent or worn through
> use, stone loss caused by damage or wear, misuse, improper care, sizing
> changes, repairs or modifications by anyone else, and loss or theft.

### Q: How do I make a claim? **[LOCKED]**

*(`WARRANTY-CLAIMS.md` §3, §4, §9)*

> Use the warranty claim form and tell us what happened, with photos. **Do not
> send us the item yet** — we review the claim first and tell you whether to
> send it in for inspection. If we do authorise an inspection, you pay to ship
> it to us, tracked and insured for its value, following the instructions we
> give you.
>
> Authorising an inspection does not mean we have decided the issue is
> covered. We decide that after we have the piece in hand.

### Q: What happens if my claim is covered? **[LOCKED]**

*(`WARRANTY-CLAIMS.md` §6 — note the remedy is ours to choose)*

> We decide the right resolution — repair, replacement, refund, or something
> else appropriate to the situation.

> ⚠️ **Do not let any revision promise repair specifically, a turnaround time,
> a prepaid inbound label, or paid repairs after the warranty ends.**
> `WARRANTY-CLAIMS.md` §12 forbids all four. The internal local-jeweller
> option must never appear on a customer-facing page at all (§7).

### Q: My item was final sale. Can I still claim? **[LOCKED]**

*(`WARRANTY-CLAIMS.md` §1; `LUXURY-STEALS.md` "Important separation")*

> Yes. Final sale means you cannot return something because you changed your
> mind. It does not remove the warranty, and it does not affect a defect,
> wrong item, shipping damage or not-as-described claim.

---

## 8. Returns & Cancellations

### Q: Can I return a Buy Now purchase? **[LOCKED]**

*(`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §2, §3, §4, §5)*

> Yes, within limits, and you need an approved RMA first — do not send
> anything back before we approve it.
>
> **Within 7 days of delivery:** request an RMA and get it back to us by day
> 14 after delivery. If it passes inspection, we refund the merchandise to
> your original payment method.
>
> **Days 8 to 30:** you choose either a refund to your original payment method
> with a 50% restocking fee, or 100% merchandise credit. Once we approve it,
> we need the item within 10 days.
>
> **After day 30:** no discretionary return.
>
> The clock starts on the carrier-confirmed delivery date, not your order date.

### Q: Who pays return shipping? **[LOCKED]**

*(`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §6)*

> You do, and the return must be tracked and insured for the value of what you
> are sending. We do not provide a prepaid return label for a discretionary
> return, and the item is your risk until it reaches us.
>
> If the problem is a defect, the wrong item, shipping damage, or the piece
> not matching its description, that is a different process — tell us and we
> will handle it under that claim instead.

### Q: What cannot be returned? **[LOCKED]**

*(`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §7, §8; `LUXURY-STEALS.md`)*

> Anything engraved, resized, altered or personalised after delivery. Anything
> worn beyond trying it on, damaged, or missing its original packaging,
> certificates or documentation. Luxury Steals, which are final sale. Custom
> Jewelry once you have approved the design.

### Q: Will I get the shipping I paid back? **[LOCKED]**

*(`BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §6, outbound shipping)*

> Expedited or optional shipping you paid for separately is not refunded on a
> discretionary return. If the return is because we got something wrong, that
> is handled under that claim instead.

### Q: Are Luxury Steals really final sale? **[LOCKED]**

*(`LUXURY-STEALS.md` "FINAL SALE" and "Important separation")*

> Yes. Luxury Steals cannot be returned or exchanged because you changed your
> mind, chose the wrong size, or prefer something else, and there is no
> merchandise credit for those reasons either.
>
> That is the only thing final sale means. If the item is defective, is not
> what you ordered, arrives damaged, is materially not as described, or has a
> warranty issue, those are all handled normally.

---

## 9. Payments

### Q: What can I pay with? **[LOCKED]**

*(`BANK-CARD-PRICING.md` §7)*

> Cards, or one of the bank methods that qualify for the Bank Payment Price:
> Zelle, ACH, bank transfer or wire. We cannot accept personal cheques,
> cashier's cheques, certified cheques or money orders.

### Q: How does paying by bank work? **[LOCKED]**

*(README "Group Buy payment timing"; `BANK-CARD-PRICING.md` §8;
`STOREFRONT-COPY-DECISIONS.md` §1.5 for the Group Buy sentence)*

> You place the order and we email you payment instructions with the exact
> amount and where to send it. Your order is not confirmed until we have
> received and verified the payment. For a Buy Now order, stock is not held
> for you before then.

> ⚠️ **The stock sentence is Buy Now only** (CLAUDE.md rule 22: inventory is
> not reserved until a person verifies received funds). It must not be
> generalised to Group Buy, where a pending Bank Payment order counts toward
> campaign progress the moment it is placed — saying nothing is held would
> contradict the campaign page.

### Q: Is my order confirmed as soon as I place it? **[LOCKED]**

*(CLAUDE.md rule 22)*

> If you paid by card, yes. If you are paying by bank, the order is open but
> not guaranteed until the money arrives and we verify it — we will tell you
> when that happens.

### Q: Do you store my card details? **[LOCKED]**

*(CLAUDE.md "Never collect/store raw card data beyond approved platform
exposure")*

> No. Card payments are handled by Shopify's checkout; we never see or store
> your full card details.

---

## 10. Shipping & Insurance

### Q: Is my order insured? **[LOCKED]**

*(README "Shipping, Insurance & Signature"; D30)*

> Yes. Every outbound shipment is tracked and insured.

### Q: Will I have to sign for it? **[LOCKED]**

*(README "Shipping, Insurance & Signature"; D31)*

> If the shipment is worth more than $100, yes — signature confirmation is
> required and it cannot be waived. At $100 or less it may ship without one.

### Q: Can I change my delivery address after ordering? **[LOCKED]**

*(README "Shipping, Insurance & Signature")*

> Ask us as soon as possible. We ship to the address approved at checkout
> unless a change is reviewed and recorded, and we cannot always make a change
> before a parcel leaves.

### Q: Where do you ship, and do I pay duties? **[OWNER-APPROVED 2026-10-12 — decision 4]**

> CaratForUs currently ships within the 50 United States and Washington, D.C.
> We do not currently offer international shipping. Because our current
> shipping program is domestic, international customs duties and import fees
> do not apply. Applicable sales tax, when required, is calculated during
> checkout.

> ⚠️ **DOMESTIC ONLY AT LAUNCH, AND THE LIST IS EXACT.** The owner's decision
> names the 50 states and D.C. Do not add international shipping, APO/FPO
> addresses, or U.S. territories — and do not add duties handling — until
> those operational paths have actually been approved. Each is a separate
> approval, not an obvious extension of this one.
>
> Tracking, insurance and signature rules are unchanged by this decision.

---

## 11. Contacting us

Not one of the README's ten FAQ categories, but Contact is its own Slice 12
page and the answer below is the same on both surfaces.

### Q: How do I get in touch? **[OWNER-APPROVED 2026-10-12 — decision 6]**

> Need help? Contact CaratForUs through our Contact Us form or email us at
> support@caratforus.com. For an existing order, claim, return, Group Buy, or
> Custom Jewelry project, please include the applicable order or reference
> number so we can locate it.

> ⚠️ **TWO CHANNELS ONLY.** Do not advertise telephone, SMS, live chat, or
> support hours until those channels actually exist and are staffed. An
> unstaffed channel on a contact page is worse than no channel.
>
> 🚦 **LAUNCH BLOCKER — `support@caratforus.com` MUST BE PROVISIONED AND
> TESTED BEFORE THIS ANSWER IS PUBLISHED.** The owner's instruction is
> explicit: if it is not live, that is a setup task to complete, **not** a
> reason to substitute a different address. See `SLICE-12-CONTENT.md` §4.

---

## Summary of what I need from you

**ALL SIX RESOLVED by owner decision 2026-10-12.** Kept as a record of what
was asked and what came back, because the answers above are terse and the
reasons they are worded the way they are matter.

| # | Was needed | Owner decision |
|---|---|---|
| 1 | Refund timeframe, or a decision to state none | 5 business days to **initiate**, counted from approval — not from request |
| 2 | Production/delivery timeframes | No blanket SLA. Per-item estimate shown on the product/campaign/approval surface; estimates, not guarantees |
| 3 | Materials, stone origin, certification, treatment disclosure | No catalog-wide claim in either direction. Product-specific facts control |
| 4 | Whether you resize, at what cost, and the warranty effect | Yes, eligibility varies by design, may carry a charge. Unauthorised third-party work is not covered; CaratForUs-authorised work does **not** void the rest |
| 5 | Countries shipped to, and who pays duties | 50 US states + D.C. only. No international, so no duties |
| 6 | Contact channels | Contact Us form and `support@caratforus.com`. No phone, SMS, chat or hours |

---

## The ⚠️ fences

Not drafting notes. Each marks a place where a later innocent edit would
breach a locked policy or an owner decision, and they should survive into
whatever system holds this content:

1. **Pricing** — no percentage, and never "surcharge", "card fee", "cash
   discount" or "cash price" (`BANK-CARD-PRICING.md` §6 forbids each by name).
2. **Warranty remedy** — no promise of repair specifically, no turnaround, no
   prepaid inbound label, no post-warranty paid repair
   (`WARRANTY-CLAIMS.md` §12); the internal local-jeweller option never
   appears customer-facing at all (§7).
3. **Bank Payment stock** — "stock is not held" is Buy Now only; generalising
   it to Group Buy would contradict the campaign page, where a pending Bank
   Payment order counts toward progress immediately.
4. **Refund timing** — five business days runs from *approval*, after receipt
   and inspection, and ends at *initiate*. Not from request, and not to funds
   landing.
5. **Production timing** — no blanket SLA, ever.
6. **Materials** — no catalog-wide claim in either direction; six specific
   implications are forbidden by name.
7. **Resizing** — not free, and not an automatic warranty void. Both errors
   are live.
8. **Shipping** — 50 states and D.C. exactly; international, APO/FPO, U.S.
   territories and duties each need their own approval.
9. **Contact** — two channels only, and the address must be live first.

---

## Obligations this FAQ creates elsewhere

Two answers promise something another surface has to deliver. Recording them
here because an FAQ that describes behaviour the product does not have is
worse than no FAQ.

1. **Per-item delivery estimates** (decision 1). The answer states the
   estimate "will be shown on the product, campaign, or final approval page
   before purchase". Where an estimate applies, that surface must carry it.
   Custom Jewelry already does — `approvedTimelineText` on the approval
   package, which is deliberately nullable and renders as absence rather than
   inventing a default. Buy Now product pages and Group Buy campaign pages
   have no equivalent field today, so an estimate there is editorial content
   per item, not a system guarantee.
2. **`support@caratforus.com`** (decision 6). Must be provisioned and tested
   before publication — flagged as a launch requirement in
   `SLICE-12-CONTENT.md` §4.
