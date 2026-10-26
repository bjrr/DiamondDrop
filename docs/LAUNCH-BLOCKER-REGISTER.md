# MVP1 Launch Blocker Register

**Current as of 2026-10-25.**

- **Fly app:** production runs `ddf8f79` (D4 App Proxy shop binding),
  deployed and live-proven 2026-10-25.
- **Shopify:** production store `caratforus.myshopify.com` (§2), live theme
  `CaratForUs MVP1` #187633434842, D12/D15 theme files pushed 2026-10-25,
  S9 page created and verified (§4.1).

The single authoritative list of what stands between CaratForUs and taking
a real customer's money.

This is a *launch* register, not a backlog. An item appears only if MVP1
cannot open without it. It states current truth once; superseded findings
live in §9 as history, never as open items.

---

## The one-paragraph answer

**The platform is ready and now sits on a real production store; the
business is not ready.** The app is deployed, healthy, fully migrated,
operator-configurable, and all four scheduled jobs run and have been
individually proven. The last two engineering gaps — D15's unsafe Shopify
invoice and D12's email-only payment instructions — are fixed, deployed and
live-proven (§7). The production store exists (`caratforus.myshopify.com`,
Grow plan) with the app installed, the theme live and the storefront
password protected.

What is missing is commercial and editorial: **no card gateway is
activated**, there is no catalogue, no Terms or Privacy Policy, the FAQ is
empty, and every cost input in the database is still placeholder data. No
amount of further engineering changes any of that.

---

## How to read it

| Status | Meaning |
|---|---|
| 🟢 **DONE** | Verified working, with the evidence named |
| 🟡 **PARTIAL** | Works, but with a stated limit or an unverified half |
| 🔴 **BLOCKER** | Launch cannot proceed until this is done |
| ❓ **UNKNOWN** | Cannot be determined from here; needs owner verification |

---

## 1. Commercial — the real blockers

| # | Item | Status | Evidence / note |
|---|---|---|---|
| C1 | **A real catalogue** — no sellable product exists | 🔴 BLOCKER | No longer blocked by anything but the work itself: the production store exists. See §8 Track B |
| C2 | **A production store** | 🟢 **RESOLVED 2026-10-25** | `caratforus.myshopify.com` (canonical `nnb1th-cm.myshopify.com`) — **Production, Grow plan**, app installed, theme live, storefront password protected. See §2 |
| C3 | **Bank payment coordinates** | 🟢 DONE | All five `PAYMENT_*` secrets set and Deployed. **Resolved 2026-10-24:** the digest `PAYMENT_ZELLE_RECIPIENT` shares with `STAFF_EMAIL_ALLOWLIST` is because both are `orders@caratforus.com`. The allowlist holds a **single address with no commas**, so the Zelle recipient is a valid one — the failure mode I flagged does not apply |
| C4 | **Terms of Service** | 🔴 BLOCKER | Confirmed absent: `/policies/terms-of-service` 404s, as do refund, shipping and contact-information policies. Four business decisions needed first — `docs/content/MVP1-STOREFRONT-COPY.md` Part 4 |
| C5 | **Privacy Policy** | 🔴 BLOCKER — **and it is already LIVE**, which is worse than absent | A Shopify-generated policy (15,757 chars, dated 2026-10-22) is **published and linked in the footer right now** at `/policies/privacy-policy`. The earlier "does not exist" was wrong. Two problems: it reads *"please call  or email us"* with an empty phone number, and it has **not** been reviewed against our append-only evidence tables — it makes generic deletion/retention promises we may not be able to keep. See §3.1 |
| C6 | **Shipping configuration in Shopify** | ❓ UNKNOWN | Policy locked in README; not yet verified in the production store. No longer blocked — C2 is resolved |
| C7 | **Payment gateway and tax** | 🔴 BLOCKER | **Shopify Payments / card-gateway activation is its own commerce-launch blocker** and is NOT implied by C2. Tax configuration likewise unverified |

---

## 2. The production store — RESOLVED

| Fact | Value |
|---|---|
| Public store URL | `caratforus.myshopify.com` |
| Shopify canonical/internal domain | `nnb1th-cm.myshopify.com` |
| **These are the same shop** | Shop id `gid://shopify/Shop/85082865882` |
| Type / Plan | **Production, Grow** |
| Store owner | Brian Jishi (`orders@caratforus.com`) |
| Storefront | **Password protected** — `/` and every page 302 to `/password` |

**C2 is closed.** A production merchant store exists on a paid plan. The
earlier determination — that `caratforus-dev` was a development store with
no self-serve upgrade path — was correct about `caratforus-dev` and is now
simply irrelevant: a separate production store was created rather than
converting that one. Do not reopen "create a production store" as a
blocker.

### The two domains are one shop — read this before debugging anything

Shopify assigns a permanent internal `*.myshopify.com` handle that does not
change when the store URL does. For this shop that handle is
`nnb1th-cm.myshopify.com`, and it is what appears in API payloads, OAuth
sessions and the `Session.shop` column. `caratforus.myshopify.com` is the
same shop under its chosen name.

This has already caused one wrong conclusion: a session-table dump showing
`nnb1th-cm.myshopify.com` was read as "some other store", and the absence
of a literal `caratforus.myshopify.com` row as "the app is not installed on
production". Both were wrong. **The CaratForUs app IS installed on the
production store.**

### What is live on production today

| Item | State |
|---|---|
| CaratForUs app | **Installed**; offline + online sessions present |
| App Proxy `/apps/carat/*` | **Routing** — verified end to end, see §7 |
| Theme `CaratForUs MVP1` (#187633434842) | **Live** |
| Slice 12 policy templates | **Live** |
| Slice 13 templates (FAQ, past Group Buys) | **Live** |
| D12/D15 theme files | **Live** — pushed 2026-10-25, see §4 S1–S3 |
| `bank-payment-orders` page | **Created, published, template assigned** (S9) |

`caratforus-dev.myshopify.com` still exists, the app is still installed
there, and **both shops share one database**. That had two consequences,
both now closed — see §5 D4: the Admin target pointed at the dev store, and
a correctly signed dev-store App Proxy request would have been served by
production. Dev-store test rows remain in the production database and
should be cleared before launch.

---

## 3. Content

| # | Item | Status | Evidence / note |
|---|---|---|---|
| N1 | Six policy pages, correct templates, terms served live | 🟢 DONE | 6/6 groups over signed App Proxy, 15 terms, `incomplete: false`, re-verified after every deploy |
| N2 | Policy page bodies are empty | 🔴 BLOCKER | Drafts written — `MVP1-STOREFRONT-COPY.md` Part 1 |
| N3 | About page copy | 🔴 BLOCKER | Draft written; needs 2–3 sentences only the owner has |
| N4 | Why Buy From Us copy | 🔴 BLOCKER | Draft written and grounded in README + locked pricing policy |
| N5 | FAQ entries | 🟢 **DONE — 38/38 live and verified (2026-10-26)** | All 38 owner-approved entries are in Shopify, ACTIVE, and match `docs/specs/faq-entries-extracted.json` exactly (mechanical read-back: 0 mismatches, 0 duplicates; Payments 4; no ACH or "bank transfer"). On `/pages/faq`: **F1** 🟢 answers render as HTML, not JSON (no blanks, no `**`, paragraphs kept, bold in exactly the 4 intended places). **F2** 🟢 the 11 categories render in the owner-approved order, with `sort_key` order inside each. Mobile confirmed by the owner on a phone. The store is still password-protected. Loading used the Shopify integration (Admin GraphQL), not Admin UI entry. Optional follow-up, not a blocker: "Is my order confirmed as soon as I place it?" says a bank order "is open", which is imprecise for Buy Now; the owner may revise it. See §4.5 |
| N6 | Contact mailbox | 🟢 DONE | `orders@caratforus.com`, owner-confirmed, fenced repo-wide. `CUSTOMER_SERVICE_EMAIL` is deliberately *not* a Fly secret — nothing reads it at runtime. Do not set it |

---

### 3.1 ⚠️ A Privacy Policy is already published — reviewed 2026-10-25

The register previously recorded C5 as "does not exist". That was wrong,
and the truth is more urgent: Shopify's generated Privacy Policy is **live,
published, and linked from every page footer** at
`/policies/privacy-policy` — 15,757 characters, dated 2026-10-22.

A published policy is a commitment. An absent one is a gap. The second is
easier to fix safely, so this is worth treating as the higher risk, not the
lower.

**What it gets right:** names CaratForUs, reaches `orders@caratforus.com`,
no unreplaced template placeholders, and it does address deletion rights
and retention in general terms.

**Two problems.**

1. **A visible defect on a live legal page.** The contact section reads
   *"please call  or email us at orders@caratforus.com"* — with an empty
   gap where a phone number would go. The fix is to **remove the "call"
   phrasing**, not to add a number: phone, chat and support hours are not
   approved (owner instruction, 2026-10-25). Settings → Policies in Admin.

2. **It has not been reconciled with our evidence model, which is the exact
   question C5 was raised for.** The policy says retention "depends on
   different factors". Our schema is stronger than that and in one
   direction only: `metal_reference_price`, `stone_cost`, `cost_component`,
   `pricing_profile` and `labor_rate` carry `no_update`/`no_delete`
   triggers, and acknowledgments, RMA history and warranty evidence are
   retained deliberately as dispute evidence. A deletion request cannot be
   honoured against those tables by design.

   That is a defensible position — evidence of what a customer agreed to,
   kept to resolve disputes — but it has to be **stated**, and the current
   generic wording does not state it. `MVP1-STOREFRONT-COPY.md` Part 5
   drafts this; it needs legal review, not a developer's judgement.

**Not actioned from here.** Store policies live in Shopify Admin, the app
holds no `write_content` scope, and policy text is a legal decision.
Recorded so it is fixed deliberately rather than discovered by a customer
exercising a right we cannot honour.

**Also confirmed absent** (all 404): `terms-of-service`, `refund-policy`,
`shipping-policy`, `contact-information`. Those four are Shopify's own
native policy slots and are separate from our six custom `policy-*` pages,
which exist but stay unpublished pending N2.

---

### 3.2 Terms and Privacy — drafts complete, deliberately unpublished (2026-10-26)

Owner commissioned five deliverables; all five are in the repo. **Neither
legal document is published, and neither may be until its remaining
`[COUNSEL]` items are resolved.**

| Deliverable | Where | State |
|---|---|---|
| Draft Terms of Service | `docs/content/TERMS-OF-SERVICE-DRAFT.md` | 🟡 Draft, unpublished |
| Draft revised Privacy Policy | `docs/content/PRIVACY-POLICY-DRAFT.md` | 🟡 Draft, unpublished |
| Verified provider inventory | `docs/content/LAUNCH-DATA-INVENTORY.md` Part A | 🟢 Done |
| Append-only PII/retention inventory | `docs/content/LAUNCH-DATA-INVENTORY.md` Part B | 🟢 Done |
| Points requiring counsel | `docs/content/LAUNCH-DATA-INVENTORY.md` Part C | 🟢 Done |

**Three findings that changed what the policy may say.**

1. 🔴 **We do not collect IP addresses or user agents.** Earlier copy
   (`MVP1-STOREFRONT-COPY.md` Part 5) said acknowledgments retain both.
   Production holds **23 acknowledgments, 0 with either**. The columns
   exist and no route populates them. Publishing the old claim would have
   disclosed a practice we do not have.
2. ⚠️ **Object storage is Cloudflare R2, not AWS S3.** The code imports
   `@aws-sdk/client-s3` — that is the S3-compatible client, and the live
   endpoint is `…r2.cloudflarestorage.com`.
3. ⚠️ **Shopify Payments must not be described as active.**
   `supportedDigitalWallets` lists platform capability, not activation.
   Still open as **C7**.

**Verified provider list — exactly four:** Shopify, Fly.io (app *and*
database), Resend (transactional email only), Cloudflare R2 (uploads).
**No analytics, advertising or tracking pixels anywhere in the theme.**

**Not drafted, on purpose:** limitation of liability and the warranty
disclaimer beyond the express 1-year warranty. Owner instruction, and the
right call — wrong liability language is worse than none.

**Still missing before publication:** registered legal entity name, type
and mailing address; effective date.

---

### 3.3 🔴 The authorized phone-sentence fix is BLOCKED on scope (2026-10-26)

Owner authorized the discrete correction of *"please call  or email us at
orders@caratforus.com"* immediately. **It is not yet applied.**

**Why.** The Privacy Policy is a Shopify *shop policy*, not a repo file and
not a page. Writing it needs `write_legal_policies`, and:

- the **production runtime app** holds no policy scope, and widening it is
  **forbidden** (owner instruction) — its scopes stop at
  `write_merchant_managed_fulfillment_orders`;
- the **dedicated content-admin app** holds `read_metaobjects` /
  `write_metaobjects` only;
- the **Shopify Admin UI is unusable** — three consecutive screenshot
  attempts timed out on `/settings/legal`, the same instability seen during
  the FAQ work. Owner has since ruled it out for this change.

**The script is written and proven:**
`app/scripts/privacy-policy-contact-fix.cjs`.

It verifies shop name + canonical domain + Shop GID, reads the live
`PRIVACY_POLICY`, confirms the broken phrase exists, applies **one** regex
to **one** sentence, and then refuses to write unless the text outside that
sentence is **byte-identical**. It never holds a copy of the intended
policy body, so its worst case is declining to run rather than silently
rewriting a legal document. Dry-run is the default; `--commit` is required.
Offline simulation covers the double-space, `&nbsp;`, single-space and
newline variants, and correctly **refuses** if the text is already fixed.

**Two things the owner must supply before it can run:**

1. Temporarily add **`write_legal_policies`** to the content-admin app
   (that app only — **not** the runtime app).
2. Set `CARATFORUS_CONTENT_ADMIN_TOKEN` in the environment. Shell state does
   not persist between sessions, so the earlier value is gone.

**Afterwards: revoke `write_legal_policies` again.** The script prints that
reminder on success.

---

## 4. Shopify Admin setup

C2 is resolved, so nothing here is blocked by the store any more. Every
row below refers to **`caratforus.myshopify.com`**, live theme
`CaratForUs MVP1` (#187633434842), unless it says otherwise.

| # | Item | Status | Evidence / note |
|---|---|---|---|
| S1 | Slice 12 policy theme files pushed | 🟢 DONE — **production** | Live on #187633434842, verified by pulling the live theme and diffing against the repo |
| S2 | FAQ theme files pushed | 🟢 DONE — **production** | `templates/page.faq.json` and its section are live. (The earlier "never pushed" claim was stale: the theme had already been pushed to production.) The FAQ page still renders nothing until S4/N5 supply entries — that is a content gap, not a theme gap |
| S3 | Slice 13 theme files pushed | 🟢 DONE — **production** | `templates/page.past-group-buys.json` and its section are live. **D12/D15 theme files are also live**, pushed 2026-10-25: 5 new files (`page.bank-payment-orders.json`, `sections/bank-payment-orders.liquid`, its JS and CSS, `snippets/group-buy-bank-payment-form.liquid`) and 8 modified. `config/settings_data.json` was deliberately NOT pushed — it holds theme-editor state |
| S4 | `faq_entry` metaobject definition | 🟢 DONE — **it already existed** | Verified in Admin 2026-10-25: type `faq_entry`, keys `question`/`answer`/`category`/`sort_key`, all matching §4.2. No second definition was created. See §4.5 |
| S5 | `carat.faq_entries` product metafield | 🟡 PARTIAL (optional for launch) | `product-faq.liquid` is implemented but deliberately unwired pending an owner decision on PDP placement |
| S6 | A `past-group-buys` page using the new template | 🟢 DONE — **production** | `/pages/past-group-buys` returns 200 on the live storefront. The page already exists; the earlier "must be created" claim was stale |
| S7 | Policy pages published | 🟡 PARTIAL — **they are published; the bodies are the gap** | **Correction 2026-10-25:** the policy pages are live and Visible under their own handles — `/pages/warranty` and `/pages/returns-and-cancellations` both return 200. An earlier probe used `policy-*` handles (the TEMPLATE names) and wrongly concluded the pages were unpublished. They are safe to link from the footer. What is still missing is their **content** (N2) |
| S8 | App installed, OAuth valid, App Proxy routing | 🟢 DONE — **production** | The app is installed on the production shop (sessions keyed on its canonical domain `nnb1th-cm.myshopify.com` — §2). App Proxy verified end to end on 2026-10-25: `GET https://caratforus.myshopify.com/apps/carat/bank-payment-orders` reaches the Fly app and returns our `{"error":"unauthorized"}`, not a Shopify 404 |
| S9 | **`bank-payment-orders` page** | 🟢 **FULLY DONE — production, end to end** | Created and published by the owner. All nine checks green, including the signed-in customer case closed by the owner 2026-10-25: a real production customer account saw exactly *"You have no Bank Payment orders on this account."* See §4.1 |
| S10 | Link Bank Payment Orders from navigation | 🟢 **DONE — production** | In the **footer on every page**, in the **customer account menu**, on the homepage, and in both checkout confirmations. Shopify exposes the account menu as no-code navigation, so no UI extension was needed. See §4.4 |

---

### 4.1 S9 verification evidence (2026-10-25, against production)

`https://caratforus.myshopify.com/pages/bank-payment-orders`, live theme
#187633434842.

| # | Checked | Result |
|---|---|---|
| 1 | Page exists, title/handle/template | 🟢 Renders as **Bank Payment Orders – CaratForUs**; the `bank-payment-orders` section renders, which only happens if the template is assigned |
| 2 | Template + D12 assets load | 🟢 `component-bank-payment-orders.css` **200**, `bank-payment-orders.js` **200**, `window.CaratBankPaymentOrders._internal` present, `window.bankPaymentOrdersStrings` bound. **No console errors** (only Shopify's benign hot-reload notice) |
| 3 | Signed-out state | 🟢 Renders the sign-in gate with the owner-approved sentence — *"Please sign in or create a CaratForUs account to continue."* — and a Log in link. The results container is correctly **absent**, so the script makes no request at all |
| 4 | App Proxy reaches `/apps/carat/bank-payment-orders` | 🟢 `GET https://caratforus.myshopify.com/apps/carat/bank-payment-orders` returns our `{"error":"unauthorized"}`. That body can only come from our Fly app — a missing proxy returns Shopify's HTML 404 |
| 5 | Authorization basis unchanged | 🟢 Signed `logged_in_customer_id` → `normalizeCustomerGid` → Prisma `where: { customerGid }`. The route reads no identity from the query string or body, and `verifyAppProxySignature` does not pin a shop domain, so it verifies production traffic correctly. Refusals re-proven live: unsigned, wrong signature, signed-but-anonymous, and signed-with-empty-customer-id all **401** |
| 6 | No coordinates before authorization | 🟢 The delivered HTML (144 KB) contains **no coordinate value**. The only occurrences of `Zelle` / `Routing` are the UI *label* strings (`confirmation_zelle: "Zelle"`, `confirmation_routing: "Routing number"`); no 9-digit routing-like number appears at all. Structurally guaranteed too: no Liquid path emits a coordinate — the only emitter is the authenticated JSON endpoint |
| 7 | No internal references exposed | 🟢 No `gid://shopify/...` of any kind, no `draftOrderGid` / `shopifyOrderGid`, no `priceCalculationId`, no idempotency key. The only email in the page is the public `orders@caratforus.com` |
| 8 | Storefront password protection | 🟢 Still enabled. From a clean context with no cookies, both `/` and `/pages/bank-payment-orders` **302 to `/password`** |
| 9 | **Signed-in customer with no orders → clean empty state** | 🟢 **CLOSED by the owner 2026-10-25** — a real production customer account saw exactly *"You have no Bank Payment orders on this account."* |

**How item 9 was closed.** It needed a real customer session, and
production uses Shopify's **new customer accounts**
(`shopify.com/authentication/85082865882/...`), which sign in by emailed
one-time code — so it was the owner's to run, not mine. Closed 2026-10-25:
a real production customer account loaded the page and saw exactly

> You have no Bank Payment orders on this account.

That single observation closes four questions at once, which is why it was
worth running rather than assuming:

- Shopify's **new** customer accounts do populate Liquid's `customer`
  object, so the theme's sign-in gate opens;
- the App Proxy sends `logged_in_customer_id` under that scheme — the open
  risk, and the one no local test could ever have answered;
- the D4 shop binding passes for genuine **signed-in** traffic, not only
  the anonymous case already proven;
- the route authorizes that customer and renders the correct empty state.

Against the production asset itself the same decisions were already
verified before any customer existed: `summarize` returns `isEmpty: true`,
the bound copy matches the sentence above, a 401 maps to *"Please sign in
to see your Bank Payment orders."*, and the status labels match the real
Prisma enums (`open`/`cancelled`/`completed`, `active`/`inactive`) with an
unknown status falling through to its raw value rather than rendering
blank.

---

### 4.2 Storefront build — what exists, what is blocked (phase A)

#### Which pages actually exist on production

Probed on the live storefront 2026-10-25. This matters because a
navigation menu or homepage link pointing at a missing page 404s a customer.

| Exists (200) | Missing or unpublished (404) |
|---|---|
| `faq` | `about` |
| `contact` | `why-buy-from-us` |
| `group-buy` | **`warranty-claim`** |
| `custom-jewelry` | the six `policy-*` pages |
| `let-us-beat-your-quote` | |
| `luxury-steals` | |
| `past-group-buys` | |
| `bank-payment-orders` | |

The six policy pages 404ing is **expected** and consistent with S7 — they
are deliberately unpublished until N2 supplies their bodies.

⚠️ **`warranty-claim` is not.** `templates/page.warranty-claim.json` and its
form section ship in the live theme, but no page serves them, so the entire
warranty claim intake is unreachable by a customer. Slice 5 built the form,
the route, the uploads and the evidence trail; none of it can be used
without that page. Needs an Admin page at handle `warranty-claim` with that
template — the same thing S9 needed.

#### Homepage — built and live

`templates/index.json` was stock Dawn: an image banner and a featured
collection, both pointing at content that does not exist (no images, no
collections), so the homepage rendered as empty placeholders.

Replaced with five sections built only from components that need neither
images nor a catalogue — because neither exists yet:

1. **Hero** — positioning, and the two things a visitor can actually do today
2. **Three ways to buy** — Buy Now, Group Buy, Custom Jewelry
3. **Two more ways to pay less** — Luxury Steals (Final Sale stated up front), Let Us Beat Your Quote
4. **Pay by bank, pay less** — and a link to the Bank Payment orders page
5. **What you get either way** — warranty, insurance, the $100 signature rule, honest image labelling, support address

Copy is drafted from `docs/content/MVP1-STOREFRONT-COPY.md` Part 3, which is
itself grounded in README and `docs/BANK-CARD-PRICING.md`, rather than
invented — the bank-payment sentence reuses Part 3's approved phrasing
verbatim. **Still draft pending owner approval**, same standing as the rest
of this theme's customer-facing copy.

Verified live: no forbidden pricing language (`cash discount`, `card fee`,
`surcharge`, `cash`), no percentage shown, and all six internal links return
200. Buy Now deliberately has **no link** — there is no catalogue to send
anyone to, and `/collections/all` is empty.

One defect found and fixed in the same pass: Dawn's `multicolumn` has a
section-level button whose schema default renders the literal text "Button
label" when unset. It appeared three times on the first push.

#### Storefront chrome cleanup — done, live

Stock Dawn shipped several surfaces that were either placeholder or made
promises the business cannot yet keep. All theme-side, all now off:

| Removed | Why |
|---|---|
| Announcement bar "Welcome to our store" | Placeholder. Disabled rather than replaced — inventing promotional copy nobody approved is worse than showing none |
| **Footer newsletter signup** | It collected email addresses. See the Privacy Policy finding below — a signup field is a PII collection surface, and this one was live |
| Footer payment icons | Advertised card brands while **no gateway is activated** (C7) |
| Follow-on-Shop button | Implies a Shop presence that does not exist |
| Footer social links | No accounts configured — rendered empty |
| Country + language selectors (header and footer) | Imply international selling. One market, and tax/shipping are unverified (C6/C7) |

Verified live afterwards: no announcement bar, no newsletter, zero email
inputs in the footer, homepage intact.

**Mobile:** every homepage section is set to `columns_mobile: "1"`, Dawn's
single-column behaviour. Configured, **not yet visually verified** on a
real viewport — that belongs in the rehearsal (F).

#### Blocked on Shopify Admin, not on engineering

| Item | Why |
|---|---|
| Header + footer navigation menus (S10) | Dawn reads these from Shopify **navigation menus**. They are Admin data, not theme files. Header is still the stock `Home / Catalog / Contact`; "Catalog" points at an empty collection |
| Announcement bar still says "Welcome to our store" | Stock Dawn placeholder |
| `warranty-claim` page | See above |
| `about`, `why-buy-from-us` pages | Need creating before their drafted copy (Parts 2–3) can be placed |
| Policy page bodies (N2) | Pages exist but unpublished; bodies are drafted in Part 1 |

The app holds least-privilege scopes with no `write_content`, so none of
these can be done from here. They need either an owner session in Admin or
an explicit decision to widen scopes.

**Proposed navigation, for approval** — deliberately not every policy page
in the primary nav:

- **Header:** Shop · Group Buy · Custom Jewelry · Luxury Steals · Beat Your Quote · FAQ
- **Footer — Orders:** Bank Payment Orders · Warranty Claim · Contact
- **Footer — Policies:** the six `policy-*` pages, Terms, Privacy

---

### 4.3 Admin work — the CLI token was never needed

`shopify store auth` failed four times: it opens an approval page in a
browser tab outside the controlled group, logs only the redirect URI and
never the authorize URL, and times out after ~2 minutes. Three separate
techniques to recover the URL (verbose logging, process command-line
inspection, tab enumeration) all failed — the browser-launcher process
exits before it can be read, and Chrome holds the URL internally.

**It turned out to be unnecessary.** `admin.shopify.com` is reachable in an
authenticated browser session, so the Admin UI does everything the token
would have. Recorded because the next person will otherwise burn the same
hour on the CLI.

#### Pages created and verified, 2026-10-25

| Page | Handle | Template | Verified |
|---|---|---|---|
| **Warranty Claim** | `warranty-claim` | `warranty-claim` | 200; form renders, JS + CSS load; **no shipping instruction and no local-jeweller mention** (criteria 156/165) |
| **About Us** | `about-us` | default | 200; 7 paragraphs |
| **Why Buy From Us** | `why-buy-from-us` | default | 200; 5 paragraphs |

All three Visible; the storefront password still gates public access. No
forbidden pricing language and no percentage on any of them.

Copy is taken from `MVP1-STOREFRONT-COPY.md` Parts 2 and 3 — not invented.
**Still draft pending owner approval**, and Part 2 carries an open item the
owner has not answered: the About page has no founder story, no photograph
and no founding year, because none exist in the source. It reads completely
without them; it would read better with them.

Warranty Claim closes a real gap — the Slice 5 intake form, route, uploads
and evidence trail shipped in the live theme with **no page serving them**,
so none of it was reachable by a customer.

#### Correction: the policy pages were never unpublished

An earlier probe reported all six `policy-*` handles 404ing and concluded
the pages were hidden pending N2. That was wrong — `policy-*` are the
**template** names. The pages exist, are Visible, and resolve under their
own handles: `/pages/warranty` and `/pages/returns-and-cancellations` both
return 200.

So the footer plan is not blocked. **13 of the 14 approved footer links
resolve today**; only Terms of Service is genuinely absent, and per the
owner it stays out until approved legal text exists rather than shipping
placeholder legal copy.

#### Still to do in Admin

| Item | Note |
|---|---|
| FAQ metaobject + 38 entries | The definition does not exist yet. Copy is owner-approved (N5). 38 entries x 4 fields through a UI is the slow part, not the uncertain part |
| Main + footer menus | Structure approved; 13 footer links available |
| "Powered by Shopify" | Remove if the theme/plan exposes the setting |
| Customer-account navigation | New customer accounts are Shopify-hosted; only worth doing if a no-code menu surface exists. **Not** building a UI extension for it |

---

### 4.4 Navigation — built and verified, 2026-10-25

Three Shopify menus set in Admin, plus one theme change without which the
footer menu would not have rendered at all.

#### Main menu — 8 items, in the approved order

Home · Catalog · Group Buy · Custom Jewelry · Luxury Steals ·
Let Us Beat Your Quote · FAQ · Contact

The stock `Home / Catalog / Contact` is gone. No legal or policy page
appears in the header, as instructed.

#### Footer menu — 14 items

About Us · Why Buy From Us · Contact · FAQ · Returns and Cancellations ·
Warranty · **Warranty Claim** · Group Buy · Custom Jewelry ·
Let Us Beat Your Quote · Past Group Buys · **Bank Payment Orders** ·
Privacy Policy · Your Privacy Choices

**Terms of Service is deliberately absent** — it does not exist, and a
placeholder legal link is worse than a missing one.

**"Your Privacy Choices" was kept**, though it was not on the approved
list. It was already in the stock footer menu and is a privacy opt-out
link rather than Dawn clutter; removing it could be a compliance
regression. Flagged rather than silently dropped. "Search" was removed.

#### The theme change the menus needed

Dawn renders footer links from a `link_list` **block**, and
`footer-group.json` had **no blocks at all** — so creating the Shopify menu
alone would have changed nothing on the page. Added one `link_list` block
bound to the `footer` menu handle. This is why the footer previously showed
only "CaratForUs / Powered by Shopify / Privacy policy".

#### S10 closed

**Bank Payment Orders now appears in the footer on every page.** It is also
in the **customer account menu** — Shopify exposes
`Customer account main menu` as plain no-code navigation (it already held
Orders and Profile), so no customer-account UI extension was needed and
none was built.

#### "Powered by Shopify" removed

Dawn exposes no setting for it; the one `powered_by_link` output in
`sections/footer.liquid` was removed, which is the clean way rather than
hiding it with CSS. Permitted on a paid plan.

#### Verification — all green

| Check | Result |
|---|---|
| Desktop header | 8 approved items, stock menu gone |
| Mobile menu | `header-drawer` carries the same 8 items |
| Footer | 14 items render |
| **Every destination** | **16 URLs fetched, all 200, zero 404s** |
| Terms of Service | absent |
| Bank Payment Orders | present in footer **and** account menu |
| "Powered by Shopify" | gone |
| Password protection | still on — `/`, `/pages/bank-payment-orders`, `/pages/warranty-claim`, `/pages/about-us` all 302 to `/password` from a clean context |

Not re-enabled, per instruction: newsletter, payment icons, social
placeholders, international selectors, announcement copy.

---

### 4.5 FAQ — 🟢 38/38 live and verified (2026-10-26)

#### The definition already existed — no second one was created

`faq_entry` was already present (created by Shopify Web, 0 entries). Its
type handle and all four field keys match `SLICE-12-CONTENT.md` §4.2:
`question` (single line), `answer` (rich text), `category` (single line),
`sort_key` (integer). Verified in Admin, not assumed.

#### Source extraction — 38 entries, corrected categorisation

Parsed from `SLICE-12-FAQ-COPY-PROPOSAL.md` (owner-approved 2026-10-12),
excluding the ⚠️ owner-commentary blockquotes and the `*(source)*`
citations, which are notes rather than customer copy.

**The markdown omits the `## 2. Pricing & Refunds` heading** — confirmed by
the owner, and `faqCopyConsistency.test.ts` line 407 already expects that
heading to exist. Three questions therefore fall under Group Buys in the
raw file and were recategorised: *Why are there two prices?*, *Does the
Bank Payment Price apply to tax and shipping too?*, *When do I get a refund,
and how long does it take?*

Resulting counts — 38 total across the ten core categories plus the
supplemental **Contacting us**:

| Category | Entries |
|---|---|
| Group Buys | 6 |
| Pricing & Refunds | 3 |
| Production & Delivery | 2 |
| Materials & Stones | 2 |
| Ring Sizing | 3 |
| Custom Jewelry | 3 |
| Warranty & Repairs | 5 |
| Returns & Cancellations | 5 |
| Payments | 4 |
| Shipping & Insurance | 4 |
| Contacting us | 1 |

#### Sort keys — why every entry gets one

`snippets/faq-list.liquid` sorts keyed entries first, then unkeyed ones in
"natural order", and `sections/faq.liquid` states plainly that Shopify
returns metaobjects **in an unspecified order**. So leaving keys off cannot
preserve the approved ordering, and keying only some entries would promote
those above the rest.

Every entry therefore gets a key, numbered **sequentially within its
category in document order**. That is the documented field used for its
documented purpose, not an invented convention.

⚠️ **A limitation worth knowing: CATEGORY order is still not guaranteed.**
`faq.liquid` derives the category sequence from first appearance while
iterating that same unspecified-order collection. Entries are being created
in document order so that first-appearance matches the approved sequence in
practice, but nothing in the theme enforces it. Fixing that properly would
mean a category-ordering mechanism, which is engineering and is **not** being
done during a feature freeze.

#### Verified in production

| Check | Result |
|---|---|
| `/pages/faq` renders entries | 🟢 yes |
| Category grouping | 🟢 "Group Buys" heading groups them |
| **Sort-key ordering** | 🟢 renders 1, 2, 3 in key order — the mechanism works |
| Answer body renders | 🟢 |
| Em dash preserved | 🟢 |
| Escaped / raw rich-text artifacts | 🟢 none |

**Correction to the table above:** "Escaped / raw rich-text artifacts — none" was wrong. See *Render defect F1* below. Every answer, including these first four, renders as raw JSON.

**HELD BACK — "How does paying by bank work?"** (Payments, sort key 2). The
2026-10-12 answer says payment instructions are emailed, which contradicts
the live D12/D15 behaviour. It needs the later-approved sentence and must
preserve the Buy Now vs Group Buy distinction: Buy Now is not confirmed and
inventory is not committed until staff verify funds, whereas Group Buy
creates the unpaid order immediately and counts it toward campaign
progress. Owner-approved replacement copy required before entry.

#### Loading completed through the Shopify integration (2026-10-25)

The Admin-UI manual-entry path was **abandoned**: partial renders and the Sidekick panel swallowing input made it a production misclick hazard. `shopify store auth` was not used either. The remaining entries went in through the connected **Shopify integration** (Admin GraphQL), as deterministic `metaobjectCreate` mutations.

**Steps:**
1. **Identity** was proven from the integration itself before any write: `CaratForUs`, `nnb1th-cm.myshopify.com`, primary domain `caratforus.myshopify.com`.
2. **Definition** `faq_entry` was confirmed with `question` (single line), `answer` (rich text), `category` (single line) and `sort_key` (integer). No second definition was created.
3. **Pre-state:** exactly 4 entries, each matching `docs/specs/faq-entries-extracted.json` on question, visible answer, category and sort key. Their stored rich-text JSON was byte-identical to the encoder used for the new entries.
4. **Created: 33 entries**, in three batches of 11.
   - Each batch was generated from a fresh live read, with the exact question as the reconciliation key. No positional assumptions.
   - Each entry got an explicit handle, so Shopify's handle uniqueness is a second duplicate guard.
   - Bold in the source (`**Do not send us the item yet**`, `**Within 7 days of delivery:**` and similar) is encoded as rich-text `bold`. No `**` markers are stored.
   - 0 userErrors.
5. **Publish status.** The definition has the **publishable** capability on. Entries created through the API default to **DRAFT**, and Draft entries do not render. The original four, made in the Admin UI, were ACTIVE. All 33 were set to ACTIVE with `metaobjectUpdate` (capabilities only, no field change) to match.
6. **Read-back, compared mechanically against the manifest:**
   - 37 entries; 0 duplicates; 0 missing; 0 unexpected; 0 blank questions or answers.
   - 0 mismatches on visible answer text, category or sort key.
   - Stored rich-text JSON is byte-identical to the encoder's output.
   - Category counts: Group Buys 6, Pricing & Refunds 3, Production & Delivery 2, Materials & Stones 2, Ring Sizing 3, Custom Jewelry 3, Warranty & Repairs 5, Returns & Cancellations 5, **Payments 3**, Shipping & Insurance 4, Contacting us 1.
7. **Held:** "How does paying by bank work?" (see above).
8. **Side effects:** no partial rows, and no customers, products or orders created.

**Data: 38/38 loaded and verified 2026-10-26. FAQ is GREEN — see N5.** The render defect below must be fixed first, and the held entry needs owner-approved copy.

#### Storefront check — two defects

All 37 questions render on `/pages/faq`, behind the store password. Within each category, the questions follow `sort_key`.

**F1 — 🟢 FIXED and verified live 2026-10-26 (PR #5): answers rendered as raw rich-text JSON.**
- **Cause:** `snippets/faq-entry.liquid` outputs `{{ entry.answer }}`. On a rich-text field, that prints the stored `{"type":"root",...}` JSON.
- **Scope:** all 37 entries, including the original 4. It also affects the PDP FAQ, which shares the snippet.
- **Data:** correct; this is a theme defect only.
- **Fix:** `{{ entry.answer | metafield_tag }}`, the filter `product-disclosures.liquid` already uses for rich text. Fixed on branch `fix/faq-rich-text-render` and pinned by a test.
- **Remaining:** push to the live theme. The integration blocks writes to the published theme, so the owner pushes it. Then re-verify answer rendering, bold, desktop and mobile.

**F2 — 🟢 FIXED and verified live 2026-10-26 (PR #6): category order was not the approved order.**
- **Rendered:** Returns & Cancellations, Materials & Stones, Group Buys, Shipping & Insurance, Custom Jewelry, Ring Sizing, Payments, Pricing & Refunds, Contacting us, Production & Delivery, Warranty & Repairs.
- **Approved:** Group Buys first … Contacting us last.
- **Cause:** `faq.liquid` orders categories by first appearance in a collection Shopify returns in unspecified order. This is the limitation noted above, now visible.
- **Status:** reported, **not fixed**. The fix needs a category-ordering mechanism (engineering) and an owner decision.

### 4.6 🔴 PRE-LAUNCH GATE — `shipment_address_change_event` must not start accumulating

**Owner decision 2026-10-26. This is a gate, not a note.**

Of the 30 append-only tables, **exactly one stores a customer's postal
address directly**: `shipment_address_change_event` holds full from/to
address line 1 and 2, city, region, postal code and country, in a table
where `UPDATE` and `DELETE` are both blocked by trigger.

**Production count today: 0.** That is the whole reason this is still
cheap. The moment real orders start shipping and addresses get corrected,
immutable postal addresses begin accumulating in a table we cannot delete
from — and the retention design gets chosen for us by accident.

**The gate:** do not allow production to begin writing rows to this table
until the retention design is explicitly chosen.

Three options, none taken (no schema change is authorized):

1. Rely on the retention exception — it is genuine dispute and fulfilment
   evidence.
2. Add a **redaction path** that writes a *new* superseding event marking
   the original redacted. Consistent with append-only; the original row
   survives, the identifying content stops being readable.
3. **Narrow what the event stores** — a change-indicator or hash rather
   than full addresses.

**A `no_delete` trigger is not by itself a legal basis for retention.**
That point is now stated in the privacy draft and must survive review.

Detail and reasoning: `docs/content/LAUNCH-DATA-INVENTORY.md` §B4.

---

### 4.7 Bank Payment methods — eligible ≠ enabled (clarified 2026-10-26)

A real customer-facing defect, found while drafting the Terms.

| List | Methods |
|---|---|
| **Eligible / configurable family** (`CLAUDE.md` §14) | Zelle, ACH, bank transfer, wire |
| **MVP1 ENABLED** (owner 2026-09-29, reconfirmed 2026-10-26) | **Zelle and domestic wire ONLY** |

ACH and generic bank transfer stay **disabled** unless a later owner
decision enables them. **Customer-facing copy may name only enabled
methods** — telling someone a method qualifies when it is switched off is a
material pricing misstatement, because the Bank Payment Price is contingent
on paying by an enabled method.

**The backend was already correct.** `bankPaymentCoordinates.server.ts`
exposes two methods, and `groupBuyPaymentInstructionsEmail.test.ts` already
asserted the email never says "ach" or "bank transfer".

**The theme was not.** Two live surfaces advertised disabled methods:

- `theme/templates/index.json` — homepage "Pay by bank" block:
  *"Zelle, ACH, bank transfer and wire all qualify"*
- `theme/assets/group-buy-campaign.js` — campaign price note:
  *"Available with Zelle, bank transfer, ACH, or wire"*

**Both corrected**, and pinned by a new fence,
`app/app/theme/enabledBankPaymentMethodsFence.test.ts` (3 tests, green). It
scans the shipped theme rather than a constant, because the defect was copy
written straight into a template where backend discipline could not reach
it. The fence also asserts the two *enabled* methods still appear, so it
cannot be satisfied by saying nothing.

**Deliberately unchanged:** pricing logic, the `BANK_PAYMENT_METHODS`
domain enum, and the admin verification form. The narrower subset is a
presentation and configuration constraint; admin must still be able to
record whichever method a payment actually arrived by.

⚠️ **These two fixes are in the repo, not yet on the live theme.** Both
files are theme assets, so they take effect only once the theme is pushed
to production. The store is still password-protected, so nobody has seen
the wrong copy — but **this must be pushed before the password comes off**,
and the homepage block should be re-read on the live storefront afterwards.

---

## 5. Deployment and operations

| # | Item | Status | Evidence / note |
|---|---|---|---|
| D1 | App deployed to Fly and healthy | 🟢 DONE | **Production runs `ddf8f79`**, deployed 2026-10-25 with the D12/D15 work and the D4 shop binding. `/health` ok, database ok, **90 applied / 0 pending, matching the 90 in the repo exactly** |
| D2 | Postgres attached and migrated | 🟢 DONE | **90 migrations applied, 0 pending** — identical to the 90 in the repo |
| D3 | Core secrets | 🟢 DONE | `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_ENV` all Deployed. **Do not recreate these** — regenerating `CRON_SECRET` would silently break all four cron jobs |
| D4 | Shopify secrets + App Proxy shop binding | 🟢 **RESOLVED 2026-10-25** | `SHOPIFY_SHOP_DOMAIN=nnb1th-cm.myshopify.com` on **all five machines**, proven by a read-only Admin probe to resolve production shop `85082865882`. App Proxy requests are now additionally bound to that signed shop. Live gate 12/12. See below |
| D5 | Email provider | 🟡 PARTIAL | Addresses verified 2026-10-24: `EMAIL_FROM` is `CaratForUs <orders@caratforus.com>` (display-name format, correct address) and `STAFF_EMAIL_ALLOWLIST` is `orders@caratforus.com`. The provider is reachable — the milestone job's attempts got to it and were rejected only because the fixture recipients were `@example.com`. **Still unproven: no successful delivery to a real address has been observed.** See below |
| D6 | Object storage | 🟡 PARTIAL | All four `STORAGE_*` Deployed. No upload performed from here |
| D7 | **All four scheduled jobs** | 🟢 DONE | `cron-guarantee-sweep` (hourly), `cron-price-recalculation` (daily), `cron-group-buy-bank-payment-window` (hourly), `cron-group-buy-milestones` (hourly). Each invoked authenticated and verified by **its own returned evidence**, not by an exit code — see §6 |
| D8 | Production reference data exists | 🟢 DONE | A pricing profile, three labor sources, 15 cost components, three metal references and five stone-cost rows all exist. Nothing is missing. Their *values* are placeholder — that is P3, not this |

---

### D4 — RESOLVED 2026-10-25: Admin target corrected, and the proxy now binds to the shop

Two defects, found together while verifying S9. Both fixed and proven in
production.

#### Part 1 — the Admin target pointed at the dev store

Production ran `SHOPIFY_SHOP_DOMAIN=caratforus-dev.myshopify.com`. Four
routes resolve their Admin session from it — Buy Now Bank Payment, Group
Buy Bank Payment, RMA intake, quote redemption — via
`unauthenticated.admin(getEnv().SHOPIFY_SHOP_DOMAIN)`.

It failed **silently**: a valid dev-store offline session still exists in
the same database, so the call succeeded against the wrong shop rather than
throwing. A production customer's Bank Payment order would have been
created in the dev store.

Now `nnb1th-cm.myshopify.com`. Proven by a read-only probe on the app
machine that performs the same session lookup those routes perform and then
asks the Admin API to identify itself:

| Field | Value |
|---|---|
| configured `SHOPIFY_SHOP_DOMAIN` | `nnb1th-cm.myshopify.com` |
| offline session found | yes |
| Admin API `shop.id` | `gid://shopify/Shop/85082865882` ✅ production |
| Admin API `shop.name` | CaratForUs |
| Admin API `myshopifyDomain` | `nnb1th-cm.myshopify.com` — agrees with the configured key |
| `primaryDomain.host` | `caratforus.myshopify.com` |
| `plan.partnerDevelopment` | **false** — not a development store |
| verdict | **PASS** |

Before the change the identical probe returned shop id
`96250560813`, "CaratForUs Dev", `partnerDevelopment: true` — which is what
makes this a demonstrated defect rather than a theoretical one.

**All five Fly machines were updated, not just one.** `flyctl secrets set`
only updates machines in the `app` process group; the four standalone cron
machines were left on the old value and were updated explicitly with
`flyctl machine update`. Two of them are thin `curl` callers that invoke
`/internal/jobs/...` on the app machine, so the job logic executes with the
app machine's environment either way.

#### Part 2 — a valid signature did not prove WHICH shop

`verifyAppProxySignature()` verified the HMAC and returned
`logged_in_customer_id`, but never checked which shop signed the request.
Every store with this app installed signs with the **same app secret**, so
a genuine, correctly signed request from one installed shop verified
against the other's backend.

Not theoretical: this app is installed on two shops sharing one database,
and Shopify customer ids are unique **per shop**, not globally. Dev-store
customer 123 and production customer 123 are the same `customerGid` to
every `where: { customerGid }` query in the codebase.

The verifier now requires the **signed** `shop` to equal the configured
shop exactly (case-insensitive, no suffix matching), after the HMAC
verifies. It fails closed on a missing `shop` and on an unconfigured
expectation. Headers are never consulted — Fly rewrites `Host` and
`X-Forwarded-Host` and nothing signs them.

`expectedShop` is a required parameter, so the compiler forced all 22 call
sites; `shopBindingFence.test.ts` additionally asserts each route passes
`getEnv().SHOPIFY_SHOP_DOMAIN` rather than a literal or a request-derived
value, because a required parameter can still be fed the wrong thing.

`logged_in_customer_id` remains the only basis for which customer's data a
request may see, and is null on every refusal path.

#### Production evidence

Live gate `npx tsx tests/live/bankPaymentOrdersRoute.ts` — **12/12**:

| Request | Result |
|---|---|
| unsigned | 401 |
| wrong signature | 401 |
| validly signed, anonymous | 401 |
| validly signed, empty customer id | 401 |
| **validly signed from `caratforus-dev.myshopify.com`** | **401 — shop binding** |
| **validly signed naming the alias `caratforus.myshopify.com`** | **401 — binding is to the canonical domain** |
| validly signed as `nnb1th-cm.myshopify.com`, authenticated | 200, `Cache-Control: no-store` |

**And genuine Shopify traffic still passes.** A real browser request through
the live App Proxy at
`https://caratforus.myshopify.com/apps/carat/bank-payment-orders` logged
`bank_payment_orders.anonymous_rejected` — *not* `shop_mismatch`. The
signature verified and the binding passed; it was refused only because
nobody was signed in. That is the proof that Shopify signs the **canonical**
`nnb1th-cm.myshopify.com`, and the reason the alias must not be configured
here.

The two deliberate cross-shop refusals appear in the same log window as
`reason: "shop_mismatch"` with the signed shop recorded — a mismatch and a
bad signature are the same 401 to a caller, and must stay that way, but
they are not the same thing to whoever is reading the logs.

**No order was created during any of this.** Verification was read-only
throughout. Counts in production: 1 Buy Now order (newest 2026-09-22), 5
Group Buy orders (newest 2026-10-05), 0 of either created in the preceding
six hours.

> ⚠️ Those existing rows are **dev-store test data in the production
> database** — both shops have always shared one database. They are not
> customer orders. Worth clearing before launch; now harmless to serving,
> because shop binding stops a dev-store request reaching them, but they
> will distort any "how many orders do we have" question.

---

### Dev-store rows in the production database — classified, not deleted

Both shops have always shared one database, so gate runs against
`caratforus-dev` left rows behind. **Nothing here is customer data and
nothing should be deleted** — this project preserves evidence by design,
and these rows are the audit trail of real verification runs.

The question is only whether they can be told apart from real business
activity. They can, three ways, none of which needs a schema change.

#### 1. Every one of them belongs to a customer that does not exist in production

Resolved read-only against the production Admin API, 2026-10-25:

| Rows | Customer GID | Resolves in production? |
|---|---|---|
| 1 Buy Now order | `gid://shopify/Customer/0` | **No** — a backfill placeholder, not a person |
| 5 Group Buy orders, 1 RMA | `gid://shopify/Customer/31226131382573` | **No** — a dev-store customer |

This is the authoritative test: a Shopify customer GID is minted per shop,
so a GID that does not resolve in the production shop did not come from it.
Any real production order will resolve.

#### 2. They are already excluded from every operational surface, by status

This is the part that matters, and it is already true — no filtering needs
to be added:

| Surface | Selects | Fixture rows are | Shown? |
|---|---|---|---|
| Staff Bank Payment verification list | `status: "open"` | `cancelled` | **No** |
| Guarantee sweep (hourly cron) | `status: "open"` | `cancelled` | **Not touched** |
| Group Buy inactivation sweep (hourly cron) | `status: "active"` | all 5 `inactive` | **Not touched** |
| Campaign settlement | scoped by `campaignId` | dev campaigns only | Contained |
| Customer retrieval page | scoped by authenticated `customerGid` | unreachable — those customers cannot sign in to production, and shop binding (D4) now refuses dev-store proxy requests | **No** |

Every fixture row is in a terminal or inactive state. The existing
status-based filtering already does the work a cleanup migration would
have been invented to do.

#### 3. What is NOT protected: naive counts

A bare `SELECT count(*)` — in launch reporting, a future dashboard, or an
answer to "how many orders do we have" — will include them, because the
business tables carry **no shop column**. `WebhookEvent` and `Session` have
one; `BankPaymentOrder`, `GroupBuyBankPaymentOrder`, `RmaRequest` and
`Acknowledgment` do not. They were built single-merchant.

**Reported rather than fixed, per the owner's instruction.** Adding a
nullable `shopDomain` to those tables and backfilling the seven rows would
be the clean mechanism, but it is a schema change and the model genuinely
cannot distinguish them today. The honest position before launch:

- do not quote a raw order count as a business figure until either real
  orders exist or that column does;
- when the first real order is placed, it will be trivially separable by
  customer GID resolution (§1) regardless.

#### Related: six test campaigns, three of them OPEN

`GroupBuyCampaign` holds six `ZZ LIVE GATE TEST CAMPAIGN — DO NOT PUBLISH`
rows: three `draft`, **three `open`**.

Not customer-visible today — a Group Buy campaign renders only where a
merchant has bound a page to its code, and no such page exists. But an open
campaign is live state: `OpenCampaignExclusionSource` excludes its variants
from Buy Now pricing recalculation, which is exactly the fixture-catalogue
noise already recorded in §7.

The non-destructive lever is the existing `cancelled` status — distinct
from `closed`, which triggers settlement and refund computation and must
not be used here. **Not actioned:** changing campaign state on production is
a real state transition, and the owner's instruction covered the order rows,
not campaigns. Recommended before launch rehearsal, so no test campaign can
be bound to a page by accident.

---

### Email delivery is configured but unproven, and there is no safe test path

Every outbound address is `orders@caratforus.com`, a monitored mailbox, so
nothing is misdirected. What has never happened is a **successful delivery
to a real address** — every recipient so far was an `@example.com` fixture.

There is deliberately **no "send a test email" action** in the app, and
the three real senders cannot be triggered without inventing data:

- admin alerts fire only when the guarantee sweep finds a genuine fault;
- payment instructions fire only on a real Group Buy bank checkout;
- milestone emails fire only for a real campaign at a real milestone.

Fabricating any of those would recreate exactly the fixture rows we just
finished clearing, so none was done.

**Owner decision 2026-10-24: prove it on the first real event.** No
test-send action will be built.

### What to watch, because this failure is silent to the customer

The earliest real send is the Group Buy bank-payment instructions email,
and its failure mode is deliberately quiet: the send is wrapped so that a
provider outage **cannot lose the order**. The order is created, the units
count, the price is locked — and the email failure is logged at error for
staff to handle by hand. That is the right trade, but it means a customer
can end up with an open order and no idea where to send money, with
nothing on screen indicating anything went wrong.

So on the first real bank-payment order, check the log for exactly one of:

```
group_buy_bank_checkout.instructions_email_sent     ← delivered
group_buy_bank_checkout.instructions_email_failed   ← send by hand, now
```

Neither line appearing at all means the email was never attempted —
`instructions_email_unconfigured`, a configuration fault rather than a
provider one.

The same applies to the other senders, which log
`group_buy_milestone.email_failed` and the admin-alert equivalents. The
milestone sweep additionally reports `emailsFailed` in its returned
summary, so a scheduled run's failures are visible without reading logs.

**This is no longer the only channel.** As of D12 the customer sees the full
instructions on screen at checkout and can return to them at any time on the
authenticated `/pages/bank-payment-orders` page. The log lines above still
matter — a failed email is still worth sending by hand — but an email outage
no longer strands a customer.

---

### ⚠️ Operations constraint — do not rotate bank coordinates while unpaid orders are open

The Zelle recipient and wire details live **only** in Fly secrets
(`PAYMENT_ZELLE_RECIPIENT`, `PAYMENT_WIRE_*`). They are resolved per request
and deliberately never persisted — not in `BankPaymentOrder`, not in
`GroupBuyBankPaymentOrder`, not in a snapshot, an audit event, an
idempotency payload, a Shopify note, or a log line. That boundary is
enforced by tests on both checkout routes and by
`bankPaymentCoordinates.server.ts`'s own header.

The consequence is a real operational rule:

> **Bank Payment coordinates must not be changed while unpaid Bank Payment
> orders are outstanding, unless staff deliberately reconcile those open
> orders.**

Because nothing is stored, every surface shows the CURRENT coordinates.
Rotate them and a customer who placed an order yesterday — and who returns
to the orders page, or who was emailed the old ones — now has two different
destinations, and staff have no record of which one any given order was
shown.

**Do not "fix" this by persisting the coordinates.** A copy in Postgres is a
second place to secure, retain and eventually redact, and the whole point of
the boundary is that it does not exist. The fix is procedural:

1. Before rotating, list open orders:
   `BankPaymentOrder` where `status = 'open'`, and
   `GroupBuyBankPaymentOrder` where `status IN ('active','inactive')`.
2. If any exist, either wait for them to settle, or contact those customers
   directly with the new destination and record that you did.
3. Then rotate. Payments to the old destination after that point are
   reconciled by hand against the order reference, which is the one thing
   every payment carries.

If the coordinates are unset or partially set, both checkout routes refuse
with `503 checkout_unavailable` **before** any Shopify call — no order is
created that cannot be paid. The orders page degrades differently and
deliberately: it still lists the orders, their references, amounts and
deadlines, and tells the customer to email `orders@caratforus.com` for the
destination. Hiding their orders because a secret is unset would turn a
configuration problem into a lost customer.

---

## 6. Pricing

| # | Item | Status | Evidence / note |
|---|---|---|---|
| P1 | Pricing engine and schema | 🟢 DONE | All models populated in production; 94 calculations recorded |
| P2 | Operating defaults — 40% markup, 20% min gross margin, $100 min profit | 🟢 DONE — **not an owner decision** | Owner-locked as *configurable operating inputs*. Active profile `buy_now` v5, `isPlaceholder: false`. **Do not ask the owner to reconfirm these** |
| P3 | **Production cost inputs** | 🟡 PARTIAL — **placeholder, see the warning below** | Every row resolves; all are seed fixtures dated `2026-01-01` |
| P4 | Card-price derivation | 🟢 DONE | Active profile carries `BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1` — approved tiered uplift, upward-to-$5 rounding on the Card price only |
| P5 | Fixture catalogue cleanup | 🟡 PARTIAL | The email-generating defect is **fixed and verified** (§9). What remains is tidiness: four active seed-fixture variants still enter daily recalculation. Proposal in §7, not executed |
| P6 | **Operator tooling — profile, metal, labor, stone** | 🟢 **DONE — implemented, deployed, live smoke-tested** | See below |
| P7 | **Operator tooling — cost components** | 🟢 **DONE — same** | See below |

### P6 / P7 — all three lifecycle stages complete

| Stage | Evidence |
|---|---|
| Implemented / tested | `app/routes/app.pricing-settings.tsx` + 75 tests |
| Deployed | live in production (`c01b944`) |
| Live **read** verification | 2026-10-15, in Shopify Admin |
| Live **write** verification | 2026-10-24, after the D11 fix |

> **The 2026-10-15 smoke test covered rendering only, and that was not
> enough.** It exercised the loader and deliberately avoided a save, to
> avoid creating a throwaway profile version. The write path was therefore
> never tested — and it was broken: **D11** rejected every embedded-admin
> form action with 400 before authentication or the action ran. "P6/P7
> GREEN — operationally configurable" was, for nine days, only half true:
> an operator could read every value and save none. Both halves are now
> verified separately, and the table above records them separately.

Smoke test observed, with **no configuration written** — deliberately, so
the first real write can be an actual Product #1 cost update rather than a
throwaway version:

- **Target markup 40, minimum gross margin 20, minimum profit 100.00**,
  pre-filled, under "Currently version 5, effective 2026-09-18… margin
  model MARKUP_ON_COST_V1; card rule BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1".
- Metals: sterling_silver 0.9189, gold 82.7, platinum 36.58 USD/g.
- Labor: india 4.5, china 5.25, usa 12 USD/g.
- Stones: five rows, **each appearing once** — the per-key collapse working
  against real data.
- Components: fourteen rows including `payment_processing` **twice**
  (percentage 0.029 and fixed 0.30 — the `(type, valueKind)` key behaving
  as designed) and **`payment_adjustment` correctly absent**.
- Both scope notices rendered.
- No application console errors; no failed requests.

**Write path verified 2026-10-24**, without creating a throwaway version:
an intentionally invalid markup (`-5`) was submitted from Shopify Admin.
The action ran and rejected it, and the database confirms the request left
nothing behind — `buy_now` versions still `[1, 2, 3, 5]`, active still
version 5 at 0.4 / 0.2 / 10000, and **0 audit events** for
`pricing_profile`. A rejected save writes neither a row nor a misleading
audit entry. The server log shows `POST /app/pricing-settings.data 200`
for the page's own data request, which is what proves the CSRF origin
guard now admits the embedded admin at all.

An authenticated operator can now change target markup, minimum gross
margin, minimum profit, metal reference prices, labor rates, stone costs
and cost components with **no code change, no seed, no SQL and no SSH**.
Each save inserts a new effective-dated row attributed to the signed-in
Shopify staff user.

**Known limitation, reported rather than worked around:** there is no
"recalculate now" button. `runPriceRecalculation` with no `variantIds`
sweeps every active variant and is measured in tens of seconds; running it
inside an embedded admin request would block past any sane timeout, and
doing it properly needs a job-status surface with polling. The daily cron
already picks up configuration changes, and every save message says so.

### ⚠️ Placeholder cost data — the trap for Product #1

**Every cost input in production is placeholder data, and it does not look
like placeholder data.** Gold at 82.70/g implies roughly $2,572/oz; silver
and platinum are similarly plausible. A price computed from them will be a
sensible-looking number that is not a real price.

Three properties make this dangerous rather than untidy:

1. **It resolves.** Nothing fails. Product #1 priced today would move
   cleanly through calculate → approve → sync with no error anywhere.
2. **`isPlaceholder` does not cover it.** That flag exists only on
   `pricing_profile`, and the active profile is legitimately
   `isPlaceholder: false` — its *rules* are owner-approved. There is no
   equivalent flag on `metal_reference_price`, `labor_rate`, `stone_cost`
   or `cost_component`.
3. **Every row is dated `2026-01-01`** — the one reliable tell, and the
   Pricing Settings screen shows it for every value.

**Operating rule:** a variant may be mapped and calculated to prove the
pipeline, but **nothing may be published to a storefront while any cost
input it depends on still carries the `2026-01-01` fixture date.**

### Auditability — enforced by the database, not by convention

- `metal_reference_price`, `stone_cost`, `cost_component`,
  `pricing_profile` and `labor_rate` each carry `no_update` / `no_delete`
  triggers. **A historical row cannot be rewritten in place.** A change is
  always a new effective-dated row.
- `PriceCalculation` pins `pricingProfileId`, `profileVersion`,
  `engineVersion`, both rule ids and a frozen `snapshotId`.

New calculations resolve current values; old ones stay reproducible; no
future change can retroactively alter recorded evidence.

### Profile scope — one profile serves more than Buy Now

`PricingProfileCode` defines six codes; **only `buy_now` is ever
resolved**. It is read by floating Buy Now calculations, by Custom Jewelry
card-price derivation, and by Group Buy campaigns at the moment they open
and freeze. The per-channel capability the schema allows is **not
implemented**, and the Pricing Settings screen says so rather than
labelling itself "Buy Now settings".

Already-open Group Buy campaigns are insulated by their frozen
profile/version — proven by `frozenRuleVersioning.test.ts`, and the
operator surface creates no path around it.

### Payment processing is a cost input, not a price rule

`payment_processing` (2.9% + $0.30, `revenue_side`) is a configurable
cost/audit input only. It does not participate in deriving the
customer-facing Regular/Card Price, which is governed solely by the
approved Bank-vs-Card rule. Updating it when a real gateway is chosen
changes cost and margin maths and leaves that model untouched.

### The resolver query — accurate characterisation

`resolveActivePricingProfile` uses `findFirst` with the same `where`
(`code` + `effective_from <= asOf`) and the same deterministic ordering
(`effective_from DESC, version DESC`), so it selects exactly the same row
and the documented same-date version tie-break still holds.

It is **not constant time.** `EXPLAIN (ANALYZE, BUFFERS)` against
production shows an index scan on the `(code, version)` unique index
reading **all** rows for the code, then a top-N heapsort — nothing indexes
`effective_from`. The genuine improvement is that one row is materialised
and returned instead of k. At today's k=4 the LIMIT form measured
marginally *slower* (0.084 ms vs 0.041 ms); the benefit appears as versions
accumulate. If they ever do, the real fix is an index on
`(code, effective_from DESC, version DESC)` — not built, because at k=4 it
would be speculative.

---

## 7. Engineering

| # | Item | Status | Evidence / note |
|---|---|---|---|
| E1 | Slices 0–13 implemented and merged | 🟢 DONE | Tagged `mvp1-engineering-complete` at `c4420a1` |
| E2 | **Group Buy milestone emails** | 🟢 DONE — **in production** | `157a216`, deployed. Route authenticates; the job has run against production and reported its own evidence |
| E3 | Slice 13 theme surfaces | 🟢 DONE (in `main`) | `5f33f0e`. Not yet pushed to Shopify — see S3 |
| E4 | CI green on `main` | 🟢 DONE | Green on `c01b944`. 180 unit files / 3195 tests and 101 integration files / 1622 tests also pass locally |
| E5 | Live Shopify proof for Group Buy refund execution | 🟢 DONE | 15/15 assertions against the real store |
| E6 | **D15 — the Buy Now Bank Payment invoice** | 🟢 FIXED in `main` | Buy Now sent Shopify's draft-order invoice, whose **Confirm order** action let the customer advance a draft that must stay staff-held until funds are verified. `sendInvoice` is gone, the invoice URL is out of the contract, and `bankCheckoutInvoiceFence.test.ts` fails if a usable one returns. `sendInvoice` now has **zero callers** anywhere |
| E7 | **D12 — bank instructions depended solely on email** | 🟢 FIXED, **deployed and live-proven** | Three surfaces now state the same server-composed instructions: the checkout confirmation panel, the authenticated `/pages/bank-payment-orders` page, and the email (now secondary). Group Buy Bank Payment ordering is wired to its real endpoint for the first time — the storefront previously offered a "Contact us" link. Coordinates still never persist; see §5. **Live gate 10/10 against production 2026-10-25** — see below |

**Feature development is frozen again** as of the D12/D15 work. No further
engineering until the production-store migration or launch testing exposes
an actual defect.

### What was actually proven in production, and what was not

Run `npx tsx tests/live/bankPaymentOrdersRoute.ts` after any deploy.

**Proven against `https://caratforus.fly.dev`, 2026-10-25, 10/10:**

- the route is deployed and routable — it is not shadowed by a redirect,
  a CSRF guard or an error page, which is exactly the class of fault D11
  was (every `/app` action 400'd in production for nine days while every
  local test passed);
- it fails closed on an unsigned request, a wrong signature, a validly
  signed **anonymous** request, and a signed request with an **empty**
  `logged_in_customer_id` — the last being what Shopify actually sends for
  a signed-out visitor, and it is part of the signed message, so that
  request is genuinely well-formed;
- a signed, authenticated request returns 200 with both lifecycles reported
  separately and `Cache-Control: no-store`;
- the deployed `SHOPIFY_API_SECRET` is the one the storefront signs with —
  implied by that 200;
- **payment coordinates are configured in production** (`coordinatesAvailable:
  true`), which is what makes instructions statable without an email at all.

**NOT proven, and deliberately so.** The gate is read-only and uses a
customer id that owns nothing, so its success case is 200 with two empty
lists. It therefore does not prove the rendering of a real payable order,
the confirmation panel, or the Group Buy storefront form — those need a
real order placed by a real signed-in customer, and no card gateway is
activated yet (C7). They are covered by the integration suite against real
Postgres and by the theme unit tests; the first end-to-end proof belongs to
launch rehearsal. S9's page now exists and is verified (§4.1), so that
prerequisite is met.

### Fixture catalogue cleanup — proposed, NOT executed

The email-generating problem is **resolved** (§9). What remains is
tidiness: four active seed-fixture variants still enter the daily
recalculation. Nothing is customer-visible — none is synced to Shopify.

The lever is `status`, verified safe and reversible: `runRecalculation`
selects only `{ status: "active" }`, nothing else consumes active master
variants, and the catalogue tables carry no append-only triggers.

| Row | Current | Proposed |
|---|---|---|
| `Seed Fixture Solitaire Ring` (product) | `active` | **archive** |
| Its 3 active 14k gold variants | `active` | **archive** |
| Its 1 active pt950 variant | `active` | **archive** |
| `ZZ livegate storefront …` / `ZZ LIVE GATE TEST — DO NOT SELL …` | archived / draft | **leave** — already excluded |
| All six ZZ Group Buy campaigns | archived | **leave** — already archived, and the sweep now honours it |
| 94 price calculations, 93 sync intents, all snapshots | — | **UNTOUCHED** — evidence |
| Policy versions, acknowledgments, audit records | — | **UNTOUCHED** — never in scope |

**No hard deletion is proposed for anything.** On the Shopify side, one
leftover live-gate product (`gid://shopify/Product/10357871313197`) exists
in the dev store and disappears when the production store replaces it —
but **the Postgres fixtures still need archiving either way.**

---

## 8. The two parallel tracks

### Track A — commerce activation (owner)

The store itself is **done** (§2): created, Grow plan, app installed, theme
live, App Proxy verified, policy pages and the S9 page in place. What
remains is commerce configuration.

1. **Payment gateway** (C7) — Shopify Payments or equivalent, activated and
   able to take a live card. Nothing about the store existing implies this.
2. **Tax** — registration and Shopify configuration.
3. **Shipping** (C6) — rates, full-value insurance, the $100 signature rule.
4. **Custom domain** — not yet pointed at the store.
5. **Cancel the three OPEN test campaigns** (§5) — use the existing
   `cancelled` status, never `closed` (which triggers settlement) and never
   deletion. Dev-store order rows themselves are already excluded from every
   operational surface by status and need no cleanup; see §5.
6. **Lift the storefront password** — last, after a full launch rehearsal.

### Track B — the first real product

**Locked archetype: a 14K gold solitaire pendant with one lab-grown
diamond.** Fixed configuration, single Shopify variant, `sizeAxis: none`,
no ring-sizing model, one centre stone. It proves the real CaratForUs path
— metal + purity + weight + labor + stone + components + profile +
Bank/Card derivation + Shopify sync — while `sizeAxis: none` excludes the
ring-size band model, `weightPerFullSizeGrams`, weight overrides and the
per-size price surface.

14K costs nothing extra on the metal side: `purity.ts` computes
`pure_price_per_gram × fineness × grams`, so one gold reference row serves
10k/14k/18k.

**No longer blocked** — the production store exists, so Shopify IDs minted
now are minted in the right place. Worth doing before the gateway is live:
a product can be built and priced end to end while the storefront stays
password protected.

**Owner inputs needed:** product name; finished 14K weight in grams;
whether a chain is included and if so its length and weight; stone shape;
carat; intended colour/clarity/cut; actual supplier cost for the stone;
labor source and real rate; current pure-gold price with as-of date;
realistic metal-loss percentage; and the applicable component costs. CAD
may legitimately be zero for a stock pendant.

**Stone coverage:** the library covers lab round and lab princess over
**[0.90, 1.10)** ct only — half-open, so 1.10 is not covered. A commoner
pendant size (0.25–0.75 ct) needs a new effective-dated band created from
the owner's real supplier cost, never invented to make the engine resolve.
A missing band raises `MissingCostInputError`, so the engine fails closed
rather than pricing a stone at zero.

**MVP1 stone-costing policy:** the *resolver* supports quality tiers, but
every current row leaves colour, clarity, cut and lab status NULL, so they
are wildcards and cost varies only by type, shape and carat band. **The
database does not differentiate quality today.** A more specific row added
later takes precedence automatically, with no code change.

---

## 9. Resolved findings — history, not open items

Recorded because the reasoning is worth keeping. **None of these is an
active blocker.**

**D11 — every embedded-admin form save failed in production with 400.**
Fly terminates TLS at its proxy and forwards plain HTTP;
`react-router-serve` never enables Express's `trust proxy`, so
`request.url` was rebuilt as `http://caratforus.fly.dev/…` while the
browser sent `Origin: https://caratforus.fly.dev`. React Router's
`throwIfPotentialCSRFAttack` compares full origins including scheme, saw a
mismatch, found the host absent from an allowlist that is `[]` in
production by design — and rejected every `/app` action before
authentication or the action ran. Fixed by allowing the app's own host
(`PRODUCTION_APP_HOST`), with a test tying it to the Shopify TOML's
`application_url`. Deployed and verified 2026-10-24.

**It was found by a real write, which is the lesson.** My 2026-10-15
smoke test verified rendering and skipped the save, so a surface reported
as "operationally configurable" could not actually be operated. A
read-only verification of a write surface is not a verification of that
surface.

**D9 — the request log printed Shopify session tokens.**
`react-router-serve` always installs `morgan("tiny")`, whose `:url` token
is the full original URL, so every embedded-admin page load logged
Shopify's `id_token` (a signed session JWT), `hmac` and `session`, and
every App Proxy request logged its `signature` and
`logged_in_customer_id`. Fixed by preloading a module that redefines
morgan's `url` token to the path only. Verified in production: the log
line is now `GET /app/pricing-settings 200` with no query string.

**The milestone sweep emailed participants of archived campaigns.**
Found within minutes of the job first running in production: it emailed
three participants of a campaign staff had archived ten days earlier. The
sweep filtered on `status in (open, closed)` and ignored `archivedAt`. This
was never fixture hygiene — all six ZZ campaigns were *already* archived on
2026-10-05 — it was a general defect that would have kept notifying
participants of **any** archived campaign indefinitely, because failed
milestones deliberately retry. Fixed in `c14c94c` with three regression
tests; production now reports `campaignsExamined: 0, emailsFailed: 0`.
Rejected non-fixes: writing completion markers (would record sends that
never happened) and closing the campaign (would convert the pending
milestone into a `campaign_closed` milestone, producing *more* failed
sends, and move a fixture campaign toward settlement).

**Five overdue bank-payment orders were inactivated correctly.** The
window job's first run inactivated five orders — `16a161d3…`, `4b53f8ca…`,
`d89dc767…`, `d7f0fc4b…`, `60f80d34…` — all `active` → `inactive`, all on
`@example.com`, all on ZZ live-gate campaigns, quoted 2026-09-29/10-05 and
therefore 10–16 days past their 96-hour window. They were overdue precisely
because the job had never been scheduled. Inactivation is internal
bookkeeping only; the Shopify orders and counted units are untouched and
staff reactivation reverses it.

**Verifying job evidence rather than exit codes was load-bearing.** The
milestone job returned HTTP 200 and `curl -fsS` exited 0 while reporting
`emailsFailed: 3`. An exit-code check would have called that success.

**Pricing values were data-driven but not operationally configurable.** An
architecture audit found the only writer to any pricing-configuration table
was `prisma/seed.ts`. Closed by P6/P7.

**Custom Jewelry resolved the pricing profile by a different rule.** It
carried its own query with no `effectiveFrom` filter, so a future-dated
profile would have taken effect there before Buy Now. Now uses the shared
resolver; pinned behaviourally and structurally.

**The input boundary used casts, not checks.** Every enum crossed through
`as never`, and `currency` was unvalidated against a `char(3)` column that
**blank-pads** — `US` would have been stored as `"US "` silently. Closed in
`domain/pricing/configurationInput.ts`, validating against Prisma's
generated runtime enums.

**Production reference data was unknown and turned out to exist.** The
seed had run; a pricing profile and all cost libraries were present.

**Earlier register revisions were wrong about production.** A
reconstruction-based revision marked the Fly deployment unconfirmed,
secrets missing, email missing and no jobs scheduled. All were already
configured. Every status in this register now names its evidence.

---

## 10. Not in this register

- Post-MVP functionality of any kind.
- `product-faq.liquid`'s PDP placement — implemented, unwired, awaiting an
  owner decision. Not a blocker; the FAQ page works without it.
- The optional "close to the next tier" Group Buy email. README permits it;
  the scope freeze excludes it.
- A "recalculate now" action — see the limitation under P6/P7.
- An index on `(code, effective_from, version)` — speculative at k=4.
- Channel-specific pricing profiles — schema-capable, not required for MVP1.
- **Anything already configured.** Core secrets, Shopify secrets, email,
  storage, bank coordinates and all four cron jobs are done, and nothing
  here asks for them again.
