# Launch data inventory — verified against production

**Date:** 2026-10-26 · **Store:** CaratForUs, `nnb1th-cm.myshopify.com`,
`gid://shopify/Shop/85082865882`

Everything below was verified against the live production app, database and
store. Nothing is listed because it appears in the repository. Where a check
contradicted an earlier assumption, the correction is called out.

---

# Part A — Service providers actually used in production

Verified from the live Fly secret set, the code paths that consume each one,
and the live storefront.

| Provider | What it does for us | Personal data it sees | Evidence |
|---|---|---|---|
| **Shopify** (Online Store, Admin, Checkout, Customer Accounts) | Storefront, checkout, orders, customer accounts, metaobject content | Name, email, shipping address, order history, customer account identity | The store itself; app installed on production |
| **Fly.io** (San Jose / `iad`) | Application hosting **and the Postgres database** | Everything our own database holds — see Part B | `caratforus` app, 5 machines, attached Postgres |
| **Resend** | Transactional email only (bank-payment instructions, Group Buy milestones, admin alerts) | Recipient email address, message contents | `EMAIL_API_KEY` set; code posts to `https://api.resend.com/emails`; `EMAIL_FROM` on `caratforus.com` |
| **Cloudflare R2** | Object storage for customer-uploaded images | Warranty-claim and custom-jewelry photographs | `STORAGE_ENDPOINT` host is `…r2.cloudflarestorage.com`; **3 warranty uploads exist in production** |

⚠️ **Correction — it is R2, not AWS S3.** The code imports
`@aws-sdk/client-s3`, which is simply the S3-compatible client. The live
endpoint is Cloudflare R2. A policy naming AWS would be wrong.

### Not used, and must not be listed

| Candidate | Finding |
|---|---|
| **Analytics / advertising / tracking pixels** | **None in the theme.** A scan for `gtag`, Google Analytics, GTM, Meta/`fbq`, Hotjar, Segment, Klaviyo and TikTok matched only Dawn's stock social-icon markup; no social URLs are configured and the footer's social block is disabled. No analytics or advertising secrets exist in production. |
| **Fraud / security vendors** | None configured beyond what Shopify provides natively. |
| **Shopify Payments** | ❓ **Not verified active — do not describe it as active.** `paymentSettings.supportedDigitalWallets` returns `SHOPIFY_PAY, APPLE_PAY, GOOGLE_PAY`, but that is a list of wallets the platform *supports*, not evidence any gateway is switched on. The register still carries gateway activation as blocker **C7**. |

**Shopify's own platform analytics.** Shopify injects its own first-party
analytics into storefronts independently of the theme. The notice should
describe this honestly as part of operating on Shopify rather than claim we
run no analytics at all.

### Bank payment coordinates

Zelle and wire details live **only** in Fly secrets, are resolved per request
and are never persisted (register D4/§5). They are *our* banking details, not
customer personal data — but the notice should not imply we store customer
bank credentials, because we do not. We never see card numbers either;
Shopify and its processor handle those.

---

# Part B — Personal data in the append-only evidence tables

**30 tables** carry `no_update` / `no_delete` / `no_truncate` triggers. The
question the owner asked is the right one: what personal data is actually in
them, and can it be minimised if a valid deletion request arrives?

## B1. The headline correction

🔴 **We do NOT collect IP addresses or user agents.** Earlier copy
(`MVP1-STOREFRONT-COPY.md` Part 5) asserted that acknowledgments retain IP
address and user agent. That is **wrong**, and a privacy notice repeating it
would disclose a practice we do not have.

- The `acknowledgment` table does define `source_ip` and `user_agent` columns.
- **No production route populates either.** The only code reference outside
  the type definition is a comment in `apps.carat.group-buy-interest.tsx`
  explaining they are deliberately left unset.
- **Verified in production: 23 acknowledgments, 0 with `source_ip`, 0 with
  `user_agent`.**

The columns are latent capability, not collected data. Either leave them
unpopulated and say nothing, or drop them — a schema decision, not one for
this review.

## B2. What the evidence tables actually hold

Three different kinds of content, with very different privacy weight:

### (i) Direct identifiers — one table only

| Table | Fields | Production rows |
|---|---|---|
| `shipment_address_change_event` | `from`/`to` address line 1 & 2, city, region, postal code, country | **0** |

This is the only append-only table holding a customer's postal address
directly. It is currently **empty**, so no real address sits in append-only
storage today. It will populate once orders ship and addresses get corrected.

### (ii) References, not identities — the common case

Most evidence tables store a **Shopify GID or an opaque reference**, not a
person: `customerRef` / `customerGid`, `orderRef`, `cartRef`, `campaignRef`,
`actorRef`. Examples: `acknowledgment`, `rma_event`, `warranty_claim_event`,
`beat_quote_*`, `custom_jewelry_*`, `group_buy_unit_event`,
`luxury_steal_order_check`.

**This matters for deletion.** A GID is a pointer into Shopify. If the
underlying Shopify customer is erased, what remains in our tables is a
reference that no longer resolves to a person — pseudonymous at worst. The
evidence trail survives; the identity does not have to.

### (iii) Free text that *may* incidentally contain personal data

`reason`, `note`, `description`, `explanation`, `payload` fields across
`audit_event` (213 rows), `snapshot`, `rma_event`, `warranty_claim_event`,
`price_override`, and others. These are staff-authored or
system-generated. Nothing forces personal data into them, but nothing
prevents a staff member typing a customer's name into a reason field.

**Operational control, not a schema change:** staff guidance should be that
reason/note fields are for the decision and its basis, not for identifying
the customer — the reference column already does that.

### (iv) No personal data at all

`metal_price`, `stone_cost`, `custom_jewelry_deposit_payment`, plus the
pricing tables (`pricing_profile`, `labor_rate`, `cost_component`,
`price_calculation`, `price_recalculation_run`, `pricing_input_change`).
These are commercial and cost records. They are append-only for financial
auditability and raise no privacy question.

## B3. Can identifying data be minimised on a valid deletion request?

**Yes, substantially — and without touching the append-only tables.**

| Mechanism | Effect |
|---|---|
| Delete/anonymise the **Shopify customer** | Every `customerRef` GID in our tables stops resolving to a person. This is the single highest-leverage action and it happens outside the protected tables entirely. |
| Our own non-protected tables | `BankPaymentOrder.customerEmail`, `RmaRequest.purchaserEmail` and similar are **not** append-only and can be redacted or nulled normally. |
| `shipment_address_change_event` | The one genuine conflict. Currently empty. See below. |
| Uploaded photographs (R2) | Stored in object storage, **not** in an append-only table. Deletable; `warranty_claim_upload` retains only metadata and a reference. |

## B4. The one genuine conflict to put in front of counsel

If a customer makes a valid deletion request **after** an address change has
been recorded, `shipment_address_change_event` holds their old and new postal
address in a table where `DELETE` and `UPDATE` are both blocked at the
database level.

Options, none taken (no schema changes during this review, per instruction):

1. Rely on the retention exception — it is dispute/fulfilment evidence.
2. Add a redaction path that writes a *new* superseding event, leaving the
   original row intact but marking it redacted (consistent with append-only).
3. Narrow what the event stores — a hash or change-indicator rather than full
   addresses.

The table is empty today, so this can be decided before it ever matters.
**It should be decided before launch, not after.**

---

# Part C — Points genuinely requiring counsel

1. **Deletion versus append-only evidence** (B4). The lawful basis is
   defensible; the wording is a legal judgement.
2. **Which state privacy statutes actually bind us**, given US-only launch
   and whatever volume thresholds apply. The owner's instruction is to
   describe practices accurately regardless — counsel should confirm the
   notice says enough without over-claiming.
3. **Limitation of liability** and **warranty disclaimer** beyond the express
   one-year warranty — drafted as placeholders in the Terms, flagged inline.
4. **Whether retaining photographs** of customers' property indefinitely is
   proportionate, and what retention period should apply to R2 uploads.
5. **Terms/policy precedence.** The Terms incorporate six versioned policy
   pages by reference. Counsel should confirm the precedence clause does what
   it is meant to and that versioned acknowledgment evidence supports it.
