# Slice 12 — Content architecture

**Status: architecture decided and the code half shipped. The content itself
is not written, and most of it needs owner approval before it can be.**

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

The published address is **`orders@raywanjewelers.com`** (owner decision
2026-10-12, correcting an earlier draft that invented
`support@caratforus.com` — that address was never an owner decision and has
been removed everywhere). **Changing it requires a new owner decision.**

Two things must both be true before the Contact page or the FAQ go live:

1. `orders@raywanjewelers.com` is an **actively monitored** mailbox;
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

### 4.2 In Shopify Admin

- **Pages**: About, Why Buy From Us, Contact, and one page per policy group
  (`returns`, `warranty`, `luxury-steals`, `group-buy`, `custom-jewelry`,
  `quote-match`).
- **Metaobject definition** for FAQ entries: fields for question, answer,
  category (from the README's ten categories), and an optional sort key.
  Created under Settings → Custom data → Metaobjects.
- **Product metafield** of type "list of metaobject references" pointing at
  FAQ entries, for the contextual FAQs the README allows on product pages.

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
