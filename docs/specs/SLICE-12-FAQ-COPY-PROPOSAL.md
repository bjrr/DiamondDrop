# Slice 12 — FAQ copy

**Status: DRAFT, awaiting owner approval.** Nothing here is live. No FAQ
surface exists yet, so no customer can reach any of this.

Ten categories, per README "FAQ / Trust Architecture": Group Buys, Pricing &
Refunds, Production & Delivery, Materials & Stones, Ring Sizing, Custom
Jewelry, Warranty & Repairs, Returns & Cancellations, Payments, and Shipping
& Insurance.

---

## How to read this

Every answer below is marked:

- **[LOCKED]** — the facts come from a locked policy document or the README,
  cited. I have restated them in plain language; check the restatement, not
  the facts.
- **[NEW]** — I wrote it. It makes no promise the locked documents do not
  already make, but the words are mine and need your eye.
- **[NEEDS YOUR FACTS]** — I did not write a real answer because I do not
  have the information, and guessing would invent a promise. These are listed
  with what I need.

**Material terms are quoted, not paraphrased.** Where an answer touches a term
a customer acknowledges, the page shows the authoritative sentence from
`policy_version` via `/apps/carat/policies` and the FAQ answer is the
explanation around it. That is why several answers below end by pointing at
the policy page rather than restating the rule a second time — see
`SLICE-12-CONTENT.md` §2.

**Nothing below promises a date.** Not production time, not repair time, not
delivery. `WARRANTY-CLAIMS.md` §12 and your standing instruction both forbid
it, and it is the single easiest promise to make by accident.

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

### Q: When do I get a refund, and how long does it take? **[LOCKED, partial]**

> Refunds go back to the way you paid. A Group Buy tier-adjustment refund is
> calculated automatically but approved by a person before it is sent.

> ⚠️ **[NEEDS YOUR FACTS]** — I have deliberately not stated how long a refund
> takes. If you want a timeframe here, give me one you are willing to stand
> behind; otherwise this answer ships as written.

---

## 3. Production & Delivery

### Q: How long will my piece take? **[NEEDS YOUR FACTS]**

I have not drafted this. There is no locked production timeframe anywhere in
the documents, and `WARRANTY-CLAIMS.md` §12 plus your standing instruction
both forbid inventing one.

**What I need:** either a range you will stand behind per purchase path (Buy
Now, Group Buy, Custom), or a decision that the answer is "we tell you when
your order is confirmed and keep you updated by email", which is honest and
promises nothing.

### Q: How do I know where my order is? **[LOCKED]**

*(README "Shipping, Insurance & Signature")*

> Every shipment has tracking, and we send it to you.

---

## 4. Materials & Stones

### Q: What are CaratForUs pieces made from? **[NEEDS YOUR FACTS]**

Not drafted. The repository defines metals and purities as pricing inputs, but
nothing locked says what you want to *claim* to customers about materials,
stone sourcing, treatment disclosure or certification — and those are claims
with legal weight.

**What I need:** which metals and purities you offer publicly; whether stones
are natural, lab-grown or both; what certification you supply and from whom;
and your position on treatment disclosure.

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

### Q: Can you resize a ring I already bought? **[NEEDS YOUR FACTS]**

Not drafted. Nothing locked says whether you offer resizing, at what cost, or
with what effect on warranty — and `WARRANTY-CLAIMS.md` §1 excludes "sizing
changes" from warranty coverage, so a wrong answer here is expensive.

**What I need:** do you offer resizing, is it paid, and what does it do to the
warranty.

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

### Q: Do you ship internationally? **[NEEDS YOUR FACTS]**

Not drafted. Nothing locked says where you ship, or how duties and import tax
are handled — and `BANK-CARD-PRICING.md` §8 mentions duties as a real charge,
so customers will ask.

**What I need:** which countries, and who pays duties.

---

## Summary of what I need from you

| # | Needed | Why I did not write it |
|---|---|---|
| 1 | Refund timeframe, or a decision to state none | Any number is a promise |
| 2 | Production/delivery timeframes, or "we tell you when confirmed" | No locked timeframe exists; forbidden to invent |
| 3 | Materials, stone origin, certification, treatment disclosure | Claims with legal weight; nothing locked |
| 4 | Whether you resize, at what cost, and the warranty effect | Warranty excludes sizing changes — a wrong answer is expensive |
| 5 | Countries shipped to, and who pays duties | Nothing locked |
| 6 | Contact channels (email only, or a form) | A form implies an inbox someone watches |

Everything else above is ready to ship once you have read it.

The three **⚠️ warnings** are not drafting notes — they are the places where a
later innocent edit would breach a locked policy, and they should survive into
whatever system holds this content.
