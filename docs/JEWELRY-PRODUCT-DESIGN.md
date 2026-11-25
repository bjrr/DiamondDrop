# Jewelry Product Design (jpd) — Dawn product templates

Status: installed on an **unpublished** duplicate theme ("Dawn — Jewelry Product Design") for review, 2026-11-24. Not published; no product is assigned a jpd template. Publication and template assignment require owner approval.

Source and full documentation: `bjrr/shopify-product-design` (branch `jpd-dawn-implementation`) — `INSTALLATION.md`, `TESTING.md`, `metafields/proposed-definitions.json`.

## In this theme
- `assets/jpd-product.css`, `assets/jpd-product.js`, `snippets/jpd-*.liquid`
- `templates/product.jpd-{ring,wedding-band,necklace,bracelet,earring,pendant,chain}.json` (generated from `templates/product.json`; keep the store's own blocks such as SYOS custom, Bank Payment buttons and disclosures)
- Gated edits in `snippets/product-variant-picker.liquid` and `snippets/product-variant-options.liquid`: active only when the section contains a `custom_liquid` block that renders `jpd-panel`; other templates render byte-identical markup. The SYOS locked center-size rule is untouched.
- Theme settings group "Jewelry product design" in `config/settings_schema.json`; `jpd.*` keys in `locales/en.default.json`.

## Rules that matter here
- Native Dawn price block stays authoritative (Regular/Card price, Bank Payment price, Shop Pay Installments). jpd adds labels/tiers only from verified `jpd.*` metafields; it never calculates a price.
- **Item number = Shopify variant SKU**, which already holds the CaratForUs SKU per `docs/VENDOR-SKU-TRANSFORMATION.md` (George's V1, Kira V2). The theme never transforms a SKU.
- Description sits below the buy buttons (owner request 2026-11-24).
- Ready to Ship / Made to Order only from `jpd.shipping_speed`; otherwise "Available to order".

## Deploy
Only through `scripts/theme-push.sh` to a draft theme, per CLAUDE.md. The review duplicate was edited directly through the Shopify theme API, not from this folder; this folder now mirrors it.
