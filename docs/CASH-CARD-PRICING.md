# Cash / Card Pricing Policy — SUPERSEDED

## Status

**SUPERSEDED 2026-09-18 by `docs/BANK-CARD-PRICING.md`.**

Do not use this document for new implementation decisions.

The prior fixed-5% card-price rule and historical terminology remain relevant only for reproducing calculations created under the old versioned rule. Existing versioned rule ids must retain their historical behavior.

For all new pricing behavior, customer-facing terminology, tier selection, card-price rounding, savings display, and checkout requirements, use:

**`docs/BANK-CARD-PRICING.md`**

Key replacement decisions include:

- customer-facing **Bank Payment Price** replaces "cash price" / "cash-equivalent price";
- Bank Payment Price is the underlying calculated selling price and is unchanged by the bank-vs-card feature;
- Regular/Card Price uses tiered increases based on Bank Payment Price;
- card tiers are 5.0% / 4.5% / 4.0% / 3.5% / 3.0%;
- only Regular/Card Price is rounded, always upward to the next $5 increment;
- displayed savings are final rounded Card Price minus Bank Payment Price;
- percentages are internal only and are never displayed to customers;
- new behavior must use a new versioned pricing rule rather than changing the old rule's meaning.
