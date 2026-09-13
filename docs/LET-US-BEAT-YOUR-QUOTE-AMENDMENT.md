# Let Us Beat Your Quote! — Locked Owner Amendment

## Status
**LOCKED MVP1 REQUIREMENT — OWNER APPROVED 2026-09-13**

This amendment modifies `docs/LET-US-BEAT-YOUR-QUOTE.md`. Where the two documents conflict, **this amendment controls**. All portions of the original specification not changed here remain in force.

## 1. Active Online Listed Items — Review Only, No Guarantee
The prior rule making an active online listed item guarantee eligible is superseded.

Customers may still submit a currently available item from a verifiable jewelry seller's website. CaratForUs may review it and may voluntarily match or beat the jewelry price when the item is materially comparable and the economics make sense.

However:
- an active online listing is **not eligible for the guaranteed match-or-beat promise**;
- CaratForUs is under **no obligation** to match or beat the online listing;
- an active online listing **does not qualify for the 10%-off fallback benefit** if CaratForUs declines or cannot match/beat it;
- customer-provided screenshots alone do not establish a live offer; the live URL/offer should be verified where practical;
- CaratForUs should retain verification evidence when it chooses to make an offer.

There is no 7-day age rule for an active online listing because the listing is review-only. Its current availability and verifiability are the relevant review factors.

Recommended customer-facing acknowledgment for this path:

> **I understand CaratForUs will review this online offer and may choose to match or beat it, but there is no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot or chooses not to match or beat the price.**

Required action: **Submit Online Offer for Review**

## 2. Guarantee Remains for Qualifying Recent Custom Jewelry Quotes
The full guarantee remains limited to a genuine, verified, materially comparable **custom jewelry quote issued within the 7 calendar days immediately preceding submission**, subject to all other qualification and verification requirements in the original specification.

For such a qualifying recent custom quote, CaratForUs will:
1. match or beat the qualifying jewelry price; or
2. if CaratForUs cannot match or beat it, issue the approved fallback benefit below.

Older custom quotes remain review-only with no guarantee/fallback. Competing Group Buys remain review-only with no guarantee/fallback.

## 3. 10%-Off Fallback — 90-Day Locked Rules
When a qualifying recent custom jewelry quote satisfies the full guarantee and CaratForUs cannot match or beat the verified jewelry price, the fallback benefit is:
- **10% off one eligible CaratForUs purchase**;
- **maximum discount $100**;
- **valid for 90 calendar days from issuance**;
- **single use**;
- **non-transferable**;
- **no cash value**;
- **not stackable with another promotional discount unless CaratForUs expressly authorizes the combination**;
- redeemable on eligible regular Buy Now merchandise or Custom Jewelry;
- **not redeemable on Community Group Buys or Luxury Steals** unless a later locked policy expressly changes this.

The system must record issuance date/time, expiration date/time, submission/decision reference, customer reference, benefit/code/reference, redemption status, redemption order where used, and any manual override/reason.

Duplicate/retried issuance must not create multiple fallback benefits from the same qualifying outcome.

## 4. Updated Acceptance Cases
Implementation/QA must treat these cases as controlling:
1. Verified qualifying custom quote submitted on Day 7 -> guarantee eligible if all other requirements pass.
2. Custom quote submitted on Day 8 -> review-only; no guarantee/fallback.
3. Active verifiable online listing -> review-only; CaratForUs may voluntarily match/beat, but there is no guarantee/fallback.
4. Active competing Group Buy -> review-only; no guarantee/fallback.
5. Qualifying recent custom quote CaratForUs can match/beat -> guarantee fulfilled; no fallback issued.
6. Qualifying recent custom quote CaratForUs cannot match/beat -> one 10%-off benefit capped at $100 is issued and expires 90 calendar days after issuance.
7. Fallback cannot be used after expiration, more than once, transferred, converted to cash, or redeemed on Group Buys/Luxury Steals.
8. Duplicate processing cannot issue multiple benefits for one qualifying outcome.

## 5. Superseded Original Language
Any statement in `docs/LET-US-BEAT-YOUR-QUOTE.md` that says an active online listed item is guarantee eligible or can trigger the 10%-off fallback is superseded by this amendment.

The original general supporting copy should not be used in a way that implies online listings or competing Group Buys receive the recent-custom-quote guarantee. Customer-facing copy must clearly distinguish the three submission paths.