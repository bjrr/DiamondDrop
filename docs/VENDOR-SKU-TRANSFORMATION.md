# Vendor SKU Transformation — Locked Store-Wide Requirement

Status: **LOCKED OWNER DECISION — 2026-11-02**

This document is authoritative for vendor/manufacturer/source SKU handling throughout CaratForUs. If another document or implementation conflicts with this rule, this document controls unless the owner explicitly changes it.

## 1. One store-wide transformation

Every vendor/manufacturer/source SKU imported into CaratForUs must be transformed using the same deterministic **+3 character shift** before it is written to Shopify's normal variant SKU field or displayed to a customer.

### Letters

Move each alphabetic character forward 3 places, wrapping at the end of the alphabet.

Examples:
- A → D
- K → N
- X → A
- Y → B
- Z → C

Preserve letter case.

### Digits

Add 3 to each digit modulo 10.

Examples:
- 0 → 3
- 1 → 4
- 6 → 9
- 7 → 0
- 8 → 1
- 9 → 2

### Symbols and separators

Symbols, punctuation, whitespace and separators stay unchanged.

Examples include:
- hyphen
- underscore
- slash
- period
- spaces

### Canonical example

Vendor SKU:

`KJ10249N`

CaratForUs SKU:

`NM43572Q`

## 2. Scope

This rule applies throughout the store to vendor-sourced merchandise, including:

- George's Mountings
- Kira products
- future suppliers/manufacturers
- Set Your Own Stone mounting variants
- Buy Now vendor merchandise
- any other vendor-sourced Shopify product/variant

Do not create vendor-specific SKU schemes.

## 3. Shopify SKU vs vendor SKU

For vendor-sourced merchandise:

- Shopify's normal product-variant `sku` must contain the transformed **CaratForUs SKU**.
- Any customer-visible SKU must be the transformed CaratForUs SKU.
- The raw vendor SKU must never be exposed on the storefront.

The original vendor SKU must remain available internally for sourcing, purchasing, reconciliation, support and vendor communication.

Prefer Shopify-native structured storage for the raw vendor SKU. Reuse an appropriate existing internal field if one already exists; otherwise use the smallest appropriate internal/admin-only PRODUCT_VARIANT metafield, such as `carat.vendor_sku`.

## 4. Transform exactly once

The transformation always derives from the retained original vendor SKU.

Never apply the +3 transformation to the current Shopify SKU during:

- repricing
- re-import
- inventory synchronization
- SYOS synchronization
- theme rendering
- product updates
- bulk catalog maintenance

An already transformed CaratForUs SKU must not be transformed again.

## 5. Collision handling

A transformed SKU must remain unique where Shopify/business operations require unique SKU identity.

If two source SKUs produce a collision or an existing CaratForUs SKU conflicts with the calculated result:

- do not silently overwrite either SKU;
- stop that affected record;
- surface the collision for owner/operator review.

## 6. Migration of existing vendor products

Existing vendor products must be audited against this rule.

For each vendor variant:

1. identify/preserve the original vendor SKU;
2. calculate the transformed CaratForUs SKU;
3. write the transformed value to Shopify's normal variant SKU;
4. read it back independently;
5. preserve the raw vendor SKU internally;
6. do not recreate the Shopify product or variant merely to change SKU identity.

If an existing SKU is already correctly transformed, verify it and do not transform it again.

## 7. Required deterministic tests

At minimum, test:

- `ABC → DEF`
- `XYZ → ABC`
- `0123456789 → 3456789012`
- symbols/separators unchanged
- `KJ10249N → NM43572Q`
- transformation derives from retained vendor SKU
- repeated repricing/sync/import does not double-transform
- collision handling fails closed

## 8. Customer-facing privacy

Never expose:

- raw vendor SKU
- supplier-private SKU metadata
- supplier cost or wholesale pricing

If a SKU is shown to a customer, it must be the transformed CaratForUs SKU.
