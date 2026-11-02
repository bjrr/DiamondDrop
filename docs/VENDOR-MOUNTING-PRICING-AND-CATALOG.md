# Vendor Mounting Catalog & Pricing — Locked Requirements

Status: **LOCKED OWNER DECISIONS — 2026-11-02**

Scope: vendor-sourced ready mountings used by CaratForUs, including George's Mountings and future comparable suppliers.

This document is authoritative for vendor mounting import, structured pricing inputs, customer-facing price composition, and normal catalog visibility. `docs/BANK-CARD-PRICING.md` remains authoritative for deriving Regular/Card Price from Bank Payment Price. `docs/SET-YOUR-OWN-STONE.md` remains authoritative for compatibility and customer-owned-stone flow.

## 1. Shopify is the product source of truth

Use native Shopify Products, Variants, Product Media, Inventory and metafields/metaobjects as the operational product catalog.

Do not create a second merchant-editable vendor product catalog.

If application persistence needs a derived/read-through representation for matching, history or computation, Shopify remains the authoritative merchant-facing product source.

## 2. Preserve vendor facts; do not invent them

For each vendor mounting, preserve actual available source facts such as:

- design/title
- supported center shape(s)
- center-size configurations
- metals
- ring sizes offered by CaratForUs
- media
- supplier SKU
- actual supplier cost
- confirmed pavé counts
- hidden halo presence
- large stone count
- other vendor specifications needed for fulfillment

Do not estimate pavé counts or other specifications from photographs when the vendor does not state them.

A confirmed zero is valid. Missing required pricing data is not a zero and must fail closed.

## 3. Default/base ring size

The vendor's default/base ring size is the size explicitly stated in the original vendor title in a parenthesized `(Size X)` suffix.

Example:

`14K Emerald Solitaire — Flat Band Pave (Size 7)`

means default ring size = `7`.

At import time:

1. parse the vendor title once;
2. persist the result in Shopify PRODUCT metafield `carat.default_ring_size` (`number_decimal`);
3. independently verify stored value against the vendor source title;
4. use the structured metafield for all future pricing.

Runtime pricing must never infer default size from:

- current Shopify title
- first variant
- variant ordering
- ProductOption ordering
- customer-facing labels

The Shopify title may remove the `(Size X)` suffix after import without affecting pricing.

If the original vendor title does not state one unambiguous supported `(Size X)` value, do not guess; stop that mounting for review.

Supported standard range for the structured default is 1 through 11. Half sizes are supported. Do not infer quarter sizes unless a later owner decision changes the rule.

## 4. Ring-size selling-price adjustment

The title-defined default size always receives **+$0**, even when the default itself is above size 8.

For an offered requested ring size:

- requested size = default → **+$0**
- requested size < default → **+$25 flat**
- requested size > default and <= 8 → **+$40 flat**
- requested size > 8 and <= 11 → **+$100 flat**
- requested size > 11 → unavailable in the standard mounting flow

The lower-size fee is flat, not per half-size.

The +$100 amount is not cumulative with +$40.

These are CaratForUs selling-price adjustments, not supplier cost.

## 5. Supplier cost

`inventoryItem.unitCost` means the vendor's actual supplier cost to CaratForUs for that specific mounting configuration.

It must not include:

- 1.75 selling markup
- ring-size selling-price adjustment
- large-stone setting labor
- pavé labor
- hidden-halo amount
- stone-removal service
- Bank/Card uplift

If the vendor's actual supplier cost differs by center size, metal or another real configuration, preserve the actual difference. Do not smooth or normalize vendor pricing.

Do not derive supplier cost backward from Shopify selling price.

## 6. Internal mounting pricing components

The following are internal inputs used to calculate the finished mounting price.

### Large stones

Add **$70 per large stone that CaratForUs must set**.

Examples:
- solitaire: 1 → +$70
- three-stone: 3 → +$210
- five-stone: 5 → +$350

Small pavé/melee stones do not receive the $70-per-stone amount.

Use structured product data such as `carat.large_stone_setting_count`.

### Band pavé

Add **$10 per confirmed pavé diamond physically set into the shank/band**.

Use a structured field such as `carat.band_pave_diamond_count`.

Do not include:
- center stone
- large side stones already covered above
- hidden-halo stones
- center halo stones

Use vendor-stated counts. Do not estimate from images.

### Hidden halo

If the mounting includes a hidden halo, add **+$100 flat**.

Use structured data such as `carat.hidden_halo`.

Do not additionally charge $10 per hidden-halo diamond.

## 7. Bank Payment Price formula for vendor mountings

For each vendor mounting variant:

**Bank Payment Price =**

`inventoryItem.unitCost × 1.75`

`+ ($70 × large_stone_setting_count)`

`+ ring-size adjustment`

`+ ($10 × band_pave_diamond_count)`

`+ ($100 if hidden_halo)`

Do not silently default missing required inputs.

Persist the Bank Payment Price using the existing CaratForUs pricing architecture (currently `carat.bank_payment_price_minor_units` where applicable).

## 8. Regular/Card Price

Derive Regular/Card Price from Bank Payment Price according to `docs/BANK-CARD-PRICING.md`:

- under $500 → +5.0%
- $500–$999.99 → +4.5%
- $1,000–$2,499.99 → +4.0%
- $2,500–$4,999.99 → +3.5%
- $5,000+ → +3.0%

Then round only the Regular/Card Price **up to the next $5 increment**.

The tier is chosen from Bank Payment Price, never from the card-price output.

## 9. Customer-facing mounting price

Customers see the mounting as one finished price.

Do **not** itemize these internal components:

- $70 large-stone setting labor
- $10-per-band-pavé labor
- $100 hidden-halo amount
- $25/$40/$100 ring-size adjustment
- supplier markup
- supplier cost

These are components of the mounting price, not customer-facing fees.

The only separately itemized customer-owned-stone service currently approved is the $50 prong-set stone-removal service defined in `docs/SET-YOUR-OWN-STONE.md`.

## 10. SYOS-only mounting visibility

Vendor mountings imported specifically for **Set Your Own Stone** must not appear as ordinary jewelry in normal storefront discovery.

They must be excluded from:

- Shop Jewelry browsing
- normal customer-facing collections
- storefront search
- predictive search
- product recommendations/normal catalog discovery

They may remain real purchasable Shopify products/variants and may be reachable by the SYOS flow and by a direct product-detail URL when needed.

Prefer Shopify-native visibility controls (for example, UNLISTED where supported) over custom theme filtering. DRAFT/ARCHIVED products must never be treated as sellable SYOS candidates.

The implementation must not weaken other compatibility/availability rules merely to hide the product from normal catalog discovery.

## 11. Product lifecycle for SYOS-only vendor mountings

During import/build/verification:

`DRAFT`

After the product, pricing and compatibility data are verified for customer use:

use the Shopify-native state/visibility configuration that keeps it purchasable through SYOS while hidden from ordinary catalog discovery.

Do not publish SYOS-only vendor mountings into Shop Jewelry merely to make them purchasable.

## 12. Pilot-to-bulk import strategy

Use a small number of representative pilot mountings to prove the pipeline, then bulk import the remaining vendor catalog with automated validation and exception reporting.

Three representative mountings are sufficient when they collectively prove:

- basic solitaire compatibility/pricing
- pavé and relevant pricing boundaries
- hidden halo and/or multi-large-stone behavior and a materially different configuration

After the model is proven without new architecture, do not continue one-by-one manual validation for the whole vendor catalog.

## 13. Verification

For imported vendor mountings verify at minimum:

- product/variant identity is stable
- actual supplier costs are populated correctly
- default ring size is structured and source-verified
- internal pricing inputs are explicit
- Bank Payment Price is correct
- Regular/Card Price is correct
- transformed CaratForUs SKU is correct
- raw vendor SKU is preserved internally
- media/specifications are preserved
- compatibility metadata is correct
- SYOS-only mounting does not leak into normal Shop Jewelry discovery
- customer-facing product details do not expose supplier cost or internal pricing formula
