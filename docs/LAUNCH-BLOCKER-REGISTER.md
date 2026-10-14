# MVP1 Launch Blocker Register

**Updated 2026-10-14.** The single authoritative list of what stands between
the current repository and taking a real customer's money.

This is a *launch* register, not a backlog. Nothing enters it because it
would be nice; an item is here only if MVP1 cannot open without it.

---

## How to read it

| Status | Meaning |
|---|---|
| 🔴 **RED** | Launch is impossible until this is done |
| 🟡 **YELLOW** | Launch is possible but degraded, or the item is done and awaiting confirmation |
| 🟢 **GREEN** | Done and verified, with evidence named |

**Owner** is who can actually complete it — several of these cannot be done
by engineering at all, and saying so plainly is the point of the column.

**The headline has not changed: the two dominant blockers are commercial,
not technical.** There is no real catalogue, and the Shopify store cannot
take payments. Every engineering item below could be finished tomorrow and
the business still could not sell anything.

---

## 1. Commercial — the real blockers

| # | Item | Status | Owner | Evidence / note |
|---|---|---|---|---|
| C1 | **A real catalogue.** No sellable products exist — no master variants with real costs, no Shopify products, no photography | 🔴 RED | Owner | The pricing engine, Group Buy and Luxury Steals all operate on products that do not yet exist |
| C2 | **A store that can take payments.** Currently a development store; development stores cannot process real transactions | 🔴 RED | Owner | Blocks every purchase path. Plan conversion or a new store before anything else |
| C3 | **Bank payment coordinates for production.** Zelle recipient and domestic wire details | 🔴 RED | Owner | `PAYMENT_ZELLE_*`, `PAYMENT_WIRE_*`. Bank Payment checkout fails closed with 503 without them — correctly, it refuses to create an order it cannot tell the customer how to pay for |
| C4 | **Terms of Service** | 🔴 RED | Owner + counsel | Does not exist. Four business decisions needed first — see `docs/content/MVP1-STOREFRONT-COPY.md` Part 4 |
| C5 | **Privacy Policy** | 🔴 RED | Owner + counsel | Does not exist. The append-only evidence tables interact with deletion requests and need a lawful stated answer — see Part 5 |
| C6 | **Shipping configuration in Shopify** — rates, insured value, the $100 signature rule | 🔴 RED | Owner | README locks the policy; nothing configures it in Shopify |

---

## 2. Content

| # | Item | Status | Owner | Evidence / note |
|---|---|---|---|---|
| N1 | Six policy pages exist, correct templates, terms served live | 🟢 GREEN | — | Backend verified by architect 2026-10-14 over signed App Proxy: 6/6 HTTP 200, 15 terms, `incomplete: false`. Rendered pages verified by owner in Admin |
| N2 | **Policy page bodies are empty** | 🟡 YELLOW | Owner | Drafts now written — `docs/content/MVP1-STOREFRONT-COPY.md` Part 1. Two open questions block two of the six |
| N3 | About page copy | 🟡 YELLOW | Owner | Draft written. Needs 2–3 sentences of founder context that only the owner has |
| N4 | Why Buy From Us copy | 🟡 YELLOW | Owner | Draft written and grounded in README + locked pricing policy |
| N5 | FAQ entries | 🔴 RED | Owner | The theme surface is built and fenced, but **no `faq_entry` metaobject definition or entries exist in Admin**, so the FAQ page renders nothing |
| N6 | Contact page + monitored mailbox | 🟢 GREEN | — | `orders@caratforus.com` confirmed by owner as actively monitored; fenced repo-wide by `customerFacingEmailDomain.test.ts` |

---

## 3. Shopify Admin setup

| # | Item | Status | Owner | Evidence / note |
|---|---|---|---|---|
| S1 | Slice 12 policy theme files pushed to live theme | 🟢 GREEN | — | Theme `182948626733`, pushed by owner 2026-10-14 |
| S2 | **FAQ theme files pushed** | 🔴 RED | Owner | Committed (`a764887`) but **not pushed to Shopify** |
| S3 | **Slice 13 theme files pushed** — Past Group Buys, Bring It Back, Request a Group Buy | 🔴 RED | Owner | Committed (`5f33f0e`), not pushed |
| S4 | **`faq_entry` metaobject definition** — fields `question`, `answer`, `category`, `sort_key` | 🔴 RED | Owner | Exact handles in `docs/specs/SLICE-12-CONTENT.md` §4.2. A wrong field key renders blank entries with no error anywhere |
| S5 | **`carat.faq_entries` product metafield** (list of metaobject references) | 🟡 YELLOW | Owner | Only needed if per-product FAQs are wanted at launch. `product-faq.liquid` is implemented but deliberately **unwired** pending an owner decision on PDP placement |
| S6 | **A `past-group-buys` page using the new template** | 🔴 RED | Owner | Template `page.past-group-buys.json` ships in `5f33f0e`; the page itself must be created in Admin |
| S7 | Policy pages published (currently hidden) | 🟡 YELLOW | Owner | Deliberately unpublished until bodies are written (N2) |

---

## 4. Deployment and operations

| # | Item | Status | Owner | Evidence / note |
|---|---|---|---|---|
| D1 | App deployed to Fly | 🟡 YELLOW | Owner | `docs/DEPLOY-FLY.md` is complete and current |
| D2 | Required production secrets set | 🔴 RED | Owner | `SESSION_SECRET`, `CRON_SECRET` (both ≥16 chars), `SHOPIFY_API_SECRET`, `SHOPIFY_APP_PROXY_SUBPATH`, `DATABASE_URL`. The app refuses to boot without them, which is the intended behaviour |
| D3 | Email provider configured | 🔴 RED | Owner | `EMAIL_API_KEY`, `EMAIL_FROM`, `STAFF_EMAIL_ALLOWLIST`. Without these every outbound email is honestly skipped and logged, never faked — including the new milestone emails |
| D4 | Object storage configured | 🟡 YELLOW | Owner | `STORAGE_*`. Needed for warranty-claim and custom-jewelry uploads |
| D5 | **Four scheduled jobs** — bank-payment-guarantee, price-recalculation, group-buy-bank-payment-window, group-buy-milestones | 🔴 RED | Owner | All four now documented in `DEPLOY-FLY.md` Step 6. **None can be scheduled by engineering — each needs `CRON_SECRET` and Fly access.** A job that exists in code and is never scheduled is a feature that silently does nothing |

---

## 5. Engineering

| # | Item | Status | Owner | Evidence / note |
|---|---|---|---|---|
| E1 | Slices 0–13 implemented and merged to `main` | 🟢 GREEN | — | Merge `4d688ef`, tagged `mvp1-engineering-complete` at `c4420a1` |
| E2 | **Group Buy milestone emails** — tier unlock, best-tier unlock, campaign close | 🟢 GREEN | — | Built in `157a216`. Was a verified gap: `unitLedger.server.ts` contained no send of any kind. Needs D5 to actually run |
| E3 | **Slice 13 theme surfaces** | 🟢 GREEN | — | Built in `5f33f0e`. The backends had shipped with zero theme files referencing them |
| E4 | CI green on `main` | 🟡 YELLOW | — | See the note below |
| E5 | Live Shopify proof for Group Buy refund execution | 🟢 GREEN | — | 15/15 assertions against the real store, Slice 8 |

### Note on E4

CI run #115 (`157a216`) failed in the integration suite. Diagnosed and
reproduced locally rather than guessed at: a single assertion in the new
milestone test, caused by the **test fake** — `RecordingGroupBuyParticipantEmailPort.seed()`
did not clear a previously seeded failure, so an order that "recovered" kept
throwing. The sweep itself was correct; the red looked like a missing retry
and was not one. Fixed by making `seed()` clear the failure, which is the
only thing seeding a result can mean.

Reproducing it needed a real Postgres, and this machine has no Docker, WSL
or installed Postgres — the suite was run against a throwaway server from
npm in the scratchpad.

---

## 6. What is NOT in this register

Deliberately excluded, so nobody mistakes the absence for an oversight:

- **Post-MVP functionality** of any kind.
- **`product-faq.liquid`'s PDP placement.** Implemented, unwired, awaiting
  an owner decision. It is not a blocker — the FAQ page works without it.
- **The optional "close to the next tier" Group Buy email.** README permits
  it; MVP1 is under a scope freeze and "optionally" is not "required".
- **Performance work on the pricing job's query count.** Real, recorded,
  and not a launch blocker.

---

## 7. The shortest path to launch

Strictly ordered by what unblocks the most:

1. **C2** — resolve the store's payment capability. Nothing else matters
   until a customer can pay.
2. **C1** — one real product, priced, photographed, published. One is
   enough to prove the whole path end to end.
3. **D2 + D3** — production secrets and email. Without email, bank payment
   customers never receive instructions.
4. **S2 + S3 + S4 + S6** — one theme push and the Admin objects behind it.
5. **N2 + N3 + N4** — answer the two open questions and the policy, About
   and Why Buy pages can all be published together.
6. **D5** — schedule the four jobs.
7. **C4 + C5** — Terms and Privacy. Start the counsel conversation early;
   it has the longest lead time of anything on this list.
8. **C3 + C6** — payment coordinates and shipping configuration.
