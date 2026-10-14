# Slice 12 — Content architecture

**Status: deployed and technically verified; customer-facing copy pending.**
The app and theme are live and the six policy pages are confirmed working.
What remains is customer-facing copy — page bodies and FAQ content — plus the
FAQ Admin configuration. See §4.2's status record for exactly what is done and
by whom.

Scope per `ARCHITECTURE-MVP1.md` §10 row 12 and README "MVP1 Customer-Facing
Scope": FAQ architecture, policy pages, About, Why Buy From Us, contact.

---

## 1. The permission question, answered

**No Shopify content permission is needed, and none is being requested.**

The owner asked to be stopped before Slice 12 only if it genuinely required
reauthorizing Shopify content permissions. It does not:

| Deliverable | Where it lives | App scope |
|---|---|---|
| About, Why Buy From Us, Contact | Shopify pages, authored in Admin | none |
| FAQ entries and categories | Shopify metaobjects, authored in Admin | none |
| Contextual FAQs on a product | product metafield referencing FAQ entries | none new — `write_products` already covers product metafields if we ever automate attachment |
| **Material policy terms** | **our `policy_version` table, served by `/apps/carat/policies`** | none |

`write_content` would only be needed for the app to programmatically create
and update Shopify pages. Nothing in the architecture asks for that, and the
§5 scope roadmap never listed it. Requesting standing write access to the
shop's content so that a human can avoid typing an About page is exactly what
least privilege exists to prevent.

The theme reads metaobjects and metafields through Liquid, which requires no
app scope at all.

---

## 2. The decision that mattered: policy pages quote, they do not restate

### The problem

Every one of the 15 `policy_version` rows today is an **acknowledgment
sentence** — the exact words shown at the moment a customer accepts something,
recorded against what they accepted. There is no customer-facing policy *page*
anywhere. The full policies live in `docs/*.md` as internal locked documents.

Slice 12 adds the pages. The obvious way to build them — type the terms into a
Shopify page — creates a **third copy** of every material term:

1. the locked document in `docs/`,
2. the acknowledgment sentence in `policy_version`,
3. the Shopify page.

Nothing keeps (3) equal to (1) or (2). They drift silently, and the first time
anyone notices is a dispute where our own page contradicts our own evidence.
`CLAUDE.md`'s release gate already demands the opposite: *"Verify
customer-facing material terms match the authoritative policy version."*

### What was built instead

`GET /apps/carat/policies[?group=…][&slug=…]` serves the **current** text of
every allowlisted term, straight from `policy_version`. A policy page renders
that text verbatim and wraps it in ordinary narrative — headings, explanation,
links. The quoted sentences cannot drift because there is only ever one of
them, and it is the one the customer acknowledges.

Each term carries its `version`, so a page can show what it is quoting and a
support conversation can establish what someone would have read on a given
day.

**The allowlist is the security boundary.** `app/app/domain/content/publishedPolicyTerms.ts`
names the 15 slugs a storefront may quote. The endpoint never looks up an
arbitrary slug: `policy_version` is a general versioned-text table, and
serving whatever it is handed would make the first internal policy added to it
world-readable through a storefront URL with no code change and no review.
`sample-policy` — a Slice 0 fixture present in every environment — is the
standing proof, and a test asserts it is refused.

An unpublished slug returns an empty result rather than 404, so the endpoint
cannot be used to probe which slugs exist.

**A missing row is reported, never papered over.** Every published slug is
also in `REQUIRED_POLICY_VERSIONS`, so `/health` fails when one is absent; a
test enforces that relationship in both files. If one is missing anyway the
term is omitted and logged at error — a page visibly short a section is better
than one with placeholder text where a material term should be.

---

## 3. What the theme has to do

1. Render `text` **verbatim**. Not summarised, not re-punctuated, not
   truncated with a "read more".
2. Treat `title` as a heading only. It is wayfinding and carries no promise;
   every word with legal weight is in `text`.
3. Use `group` to assemble a page's section, rather than hard-coding which
   slugs belong together — adding a term to an existing page should be an
   entry in the registry, not a theme edit.
4. Show what it has when `incomplete` is true, rather than nothing.

---

## 4. Manual setup required

None of this is done by the app. Recorded here because `CLAUDE.md`'s release
gate requires documenting metafields, metaobjects and manual setup when they
change.

### 4.1 🚦 LAUNCH BLOCKER — the customer-service contact, both halves

The published address is **`orders@caratforus.com`**. **Changing it requires
a new owner decision.**

**PROJECT-WIDE RULE (owner, 2026-10-12): every CaratForUs customer-facing
email address is on the `@caratforus.com` domain.** No other domain may
appear anywhere in this application, theme, documentation, environment
examples, policy copy, FAQ copy, tests or configuration as a CaratForUs
contact address — including the domain of any related but separate business.
Enforced by `app/app/domain/content/customerFacingEmailDomain.test.ts`,
which scans the repository rather than any single file and names the
specific excluded domain so it cannot creep back in.

Two things must both be true before the Contact page or the FAQ go live:

1. `orders@caratforus.com` is an **actively monitored** mailbox;
2. the website **Contact Us form routes into the same customer-service
   process**.

Both, not either. Publishing one watched channel beside one that is not is
worse than publishing a single channel: the customer cannot tell which is
which, picks the wrong one, and hears nothing back. An unprovisioned address
is a setup task to complete, never a reason to substitute a different one.

Also recorded as `CUSTOMER_SERVICE_EMAIL` in `app/.env.example`, which is
where a deployer looks for what an environment needs. No code reads it; an
address printed on a public page that nobody owns is a silent failure,
because the customer's mail simply goes nowhere and nothing bounces back to
us.

#### How this address was settled, and why it is now fenced

Recorded because the sequence is the argument for the fence, not trivia.
**The superseded values are described rather than written out** — the fence
forbids the foreign domain appearing anywhere, and a history note is not an
exception worth carving.

1. I **invented** a `support@` address on the CaratForUs domain while
   drafting, and carried it through the FAQ, the spec and `.env.example` as
   though it were a decision. It never was one. It read plausibly, which is
   exactly why nothing caught it.
2. The owner corrected it to an address on a **different business's domain**.
3. The owner corrected it again to `orders@caratforus.com` and added the
   project-wide rule above, which makes that other domain out of bounds
   here entirely.

Three values in two days, and at no point did anything in the codebase
object. A fabricated address and a real address belonging to someone else
are both indistinguishable from a correct one by inspection — so the fence
checks the DOMAIN, which is a fact a test can hold, rather than trying to
recognise the right local part.

### 4.2 In Shopify Admin

- **Pages**: About, Why Buy From Us, Contact, and one page per policy group
  (`returns`, `warranty`, `luxury-steals`, `group-buy`, `custom-jewelry`,
  `quote-match`).
- **Metaobject definition** for FAQ entries: fields for question, answer,
  category (from the README's ten categories), and an optional sort key.
  Created under Settings → Custom data → Metaobjects.
- **Product metafield** of type "list of metaobject references" pointing at
  FAQ entries, for the contextual FAQs the README allows on product pages.

#### The exact handles the theme reads — these must match or content renders blank

Liquid returns nil for an unknown field, so a definition built with different
handles produces entries that look correct in Admin and render as nothing on
the storefront, with no error anywhere. That is the worst available failure
mode, which is why these are pinned by
`app/app/theme/faqSurface.test.ts`.

**Metaobject — type handle `faq_entry`:**

| Field | Handle | Type | Required |
|---|---|---|---|
| Question | `question` | Single line text | yes |
| Answer | `answer` | Rich text (or Multi-line text) | yes |
| Category | `category` | Single line text | no, but see below |
| Sort key | `sort_key` | Integer | no |

- **Answer** may be either rich text or multi-line text. Rich text yields
  HTML Shopify itself produced; multi-line yields a string Liquid escapes.
  Both render correctly and neither is coerced.
- **Category** drives the page's grouping. An entry saved without one still
  appears, under the section's "Heading for entries with no category" — so
  the omission is visible rather than silently dropped.
- **Sort key** promotes an entry within its group. Entries that have one are
  printed first in key order; the rest follow in natural order. Optional by
  design, and the two-pass ordering exists so a nil key never reaches a
  comparison.
- An entry missing **question or answer** is skipped entirely rather than
  rendered as an empty disclosure.

**Product metafield — `carat.faq_entries`:**

| Property | Value |
|---|---|
| Namespace | `carat` (matches `carat.luxury_steal`, `carat.bank_payment_price_minor_units`) |
| Key | `faq_entries` |
| Type | List of metaobject references → `faq_entry` |

Holds **references, not copies**. One "How do I find my ring size?" entry can
attach to fifty products and editing it once updates all fifty — which is the
point, and the reason per-product FAQ text was not used.

#### Where the FAQ renders

| Surface | File | Notes |
|---|---|---|
| FAQ page | `templates/page.faq.json` → `sections/faq.liquid` | All entries, grouped by category. Select template `faq` on the page |
| Product page | `snippets/product-faq.liquid` | Not yet wired into a product template — see below |
| Shared renderer | `snippets/faq-list.liquid` → `snippets/faq-entry.liquid` | Both surfaces render through these, so an answer cannot look different in the two places |

Needs a targeted theme push of six files:
`sections/faq.liquid`, `snippets/faq-list.liquid`, `snippets/faq-entry.liquid`,
`snippets/product-faq.liquid`, `assets/component-faq.css`,
`templates/page.faq.json`.

**`product-faq.liquid` is not yet rendered by any product template.** It is
written and tested, but adding it to the product page is a product-page layout
decision (where it sits relative to disclosures, description and media) that
has not been made. Until then the snippet is inert — the FAQ page works
without it. Rendering it is one `{%- render 'product-faq', product: product -%}`
in whichever product section is chosen.

**No JavaScript and no App Proxy.** Unlike policy terms, which must be fetched
from our Postgres, FAQ content lives in Shopify and is available to Liquid
directly — so it renders server-side with no fetch, no loading state and no
failure path. `<details>`/`<summary>` gives keyboard and screen-reader
behaviour natively.

#### Status as of 2026-10-14

**App deployed.** Fly app `caratforus` serves `main` at `eff08f4`; 90
migrations applied; `/health` reports `requiredPolicyVersions: ok` with
nothing missing.

**Theme pushed.** The nine Slice 12 theme files are live on
`CaratForUs (Dawn 16 + Slice 2)`, theme id `182948626733`, by targeted
`--only` push. All nine were additions, so no existing theme file was
altered.

**Six policy pages: TECHNICALLY VERIFIED, CONTENT-COPY PENDING.**

| Page | Template | Group | Terms |
|---|---|---|---|
| Returns and Cancellations | `policy-returns` | `returns` | 1 |
| Warranty | `policy-warranty` | `warranty` | 1 |
| Luxury Steals | `policy-luxury-steals` | `luxury-steals` | 1 |
| Group Buy | `policy-group-buy` | `group-buy` | 3 |
| Custom Jewelry | `policy-custom-jewelry` | `custom-jewelry` | 3 (one at v2) |
| Let Us Beat Your Quote | `policy-quote-match` | `quote-match` | 6 |

Two separate verifications, recorded separately because they were performed
by different parties and cover different things:

- **Backend, verified by the architect 2026-10-14.** All six groups queried
  against production over signed App Proxy requests: HTTP 200, 15 terms
  total, every term carrying correct group, non-empty text and a version,
  `incomplete: false` on all six. Custom Jewelry correctly serves **v2** of
  the final-approval acknowledgment, which is the tell that the versioned
  migration took effect rather than a stale row being read.
- **Rendered pages, verified by the owner 2026-10-14.** The pages were
  hidden and the dev storefront is password-protected, and the architect was
  instructed not to request the password — so the per-page render,
  template assignment and absence of body-only fallback were confirmed by
  the owner in Admin and through the authenticated storefront, not by the
  architect.

**PAGE BODIES ARE DELIBERATELY EMPTY.** Owner decision 2026-10-14: the
customer-facing introductions, explanations, examples and links are deferred
to the final storefront copy review and will be written there. Draft framing
sentences were prepared and screened against the locked-policy fences, then
**withdrawn unused** on that decision — placeholder copy is not to be added
merely to satisfy an interim check.

Known consequence, accepted: with empty bodies each page presents the
canonical acknowledgments with no framing, and those are written in the first
person ("I certify that…", "I understand that…") because that is what they
are — the words shown at the moment of acceptance. On a standalone policy
page that reads oddly. The final copy pass resolves it by adding framing
above the quoted block, never by restating a term.

**The canonical terms are unchanged and remain the single source of truth.**

### 4.3 Delivery estimates — NO schema work for MVP1

**Corrected 2026-10-12.** An earlier draft of the FAQ said an estimate "will
be shown on the product, campaign, or final approval page before purchase".
Nothing in the Buy Now or Group Buy schema enforces that, so the FAQ was
committing the business to behaviour the product does not have.

The owner's correction makes the sentence conditional — "*if* an estimated
production or delivery timeframe is provided" — and rules explicitly that
**no schema field is added for MVP1.**

| Surface | MVP1 |
|---|---|
| Custom Jewelry approval | `approvedTimelineText`, unchanged. Nullable by design, rendered as absence rather than a default |
| Buy Now product page | Editorial per product. No field, and none is being added |
| Group Buy campaign page | Editorial per campaign, and the campaign's own stated terms control |

No blanket SLA, ever. This is a resolution, not a deferral: the FAQ no longer
claims the behaviour, so there is nothing left for a schema to enforce. A
system-held estimate for Buy Now or Group Buy would be a new owner decision
and a schema change — not something to approximate with a hard-coded string
in a theme.

---

## 5. What is NOT built, and why

> **UPDATED 2026-10-12.** The six open copy decisions below were resolved by
> the owner and incorporated verbatim into
> `SLICE-12-FAQ-COPY-PROPOSAL.md`, which is now APPROVED. Ten FAQ categories
> plus Contact are written and guarded by
> `app/app/domain/content/faqCopyConsistency.test.ts`. What remains is
> authoring the approved content into Shopify (§4.2) and provisioning the
> support address (§4.1). The section below is kept as the record of why the
> work stopped where it did.
>
> **CLOSED 2026-10-14.** The gap noted below — no theme code reading FAQ
> metaobjects — is now built: `sections/faq.liquid`,
> `snippets/faq-list.liquid`, `snippets/faq-entry.liquid`,
> `snippets/product-faq.liquid`, `assets/component-faq.css` and
> `templates/page.faq.json`, with 20 fences in
> `app/app/theme/faqSurface.test.ts`. The architecture was not changed; only
> the consuming Liquid was added. §4.2 now records the exact handles Admin
> must use.
>
> *Original note, 2026-10-13:* no theme code reads FAQ metaobjects. There is
> no FAQ section or snippet in `theme/` at all. The architecture in §4.2 —
> metaobject with question/answer/category/sort key, plus a product metafield
> of references — is settled and is NOT in question; what is missing is the
> Liquid that consumes it, analogous to `sections/policy-terms.liquid` for
> policies. Consequence: the Admin definitions can be created and populated,
> and they will hold correct content, but nothing renders it. This was an
> under-scoping in §4.2's original wording, which listed the Admin work
> without noting the theme work it depends on.

**The content itself.** FAQ answers, policy-page narrative, About, Why Buy
From Us, and contact copy are all new material customer-facing language, and
almost none of it is locked. `STOREFRONT-COPY-DECISIONS.md` covers the Group
Buy campaign page and the warranty claim form; it does not cover policy pages
or the FAQ.

The owner's standing rule is explicit: *"Do not invent new material
customer-facing language if the exact wording is not already locked. If new
substantive copy is required, stop only for that copy decision."* Writing a
Returns policy page is precisely that.

So the machinery is finished and the words are not. The quoted terms already
exist and are authoritative; what is missing is the narrative around them, the
FAQ answers, and the three marketing pages.

### What the owner needs to decide

1. **FAQ answers** for the README's ten categories. These are substantive —
   an answer about refunds or ring sizing is a material term in everything but
   name. Worth drafting for approval the way demand capture's copy was.
2. **Policy page narrative** — the explanation around each quoted term. Lower
   risk, because the terms themselves come from the database, but still
   customer-facing.
3. **About / Why Buy From Us** — the owner's voice, not mine to invent.
4. **Contact** — depends on what channels actually exist (email only, or a
   form; a form implies an inbox someone watches).

---

## 6. Evidence

- 9 allowlist unit tests, including that the list carries no policy text and
  that every published slug is one `/health` already guards.
- 13 integration tests against a real database, including a byte-for-byte
  comparison of every served term against its `policy_version` row, and the
  allowlist refusing `sample-policy`.
