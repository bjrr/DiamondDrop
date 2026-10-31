# Set Your Own Stone — Implementation Plan

Status: **Awaiting owner approval on §10 open decisions**
Authoritative requirements: `docs/SET-YOUR-OWN-STONE.md` (locked)
Supporting: `README.md`, `CLAUDE.md`, existing Custom Jewelry implementation

---

## 1. Outcome

A customer who already owns a diamond or gemstone describes it once — shape and
exact millimetre dimensions, not carat alone — and is shown the ready-made
CaratForUs settings whose structured compatibility metadata actually fits those
dimensions. They can submit a ready setting for review, or step into the
**existing** Custom Jewelry workflow carrying every detail they already gave,
plus the setting they were looking at as design inspiration. Nothing promises a
guaranteed fit, and nothing invites the customer to post a stone before
CaratForUs has confirmed the project.

---

## 2. What the existing code already gives us

Inspected before designing anything:

| Thing | Where | Reuse decision |
|---|---|---|
| Project record | `CustomJewelryProject` — reference, contact, starting point, prompt, budget, follow-up, status | **Reuse.** Do not fork. |
| Uploads | `CustomJewelryProjectUpload` + `uploadDestinationRepository.consumeUploadDestination` + `apps.carat.custom-jewelry-upload-destination` | **Reuse unchanged.** Spec §9.4 forbids a parallel upload system. |
| Deposit | `CustomJewelryDepositAcceptance` → invoice → payment, $49 | **Untouched.** Applies after handoff exactly as today. |
| Approval | `CustomJewelryApprovalPackage` → `CustomJewelryFinalPurchase` | **Untouched.** |
| Proxy auth | `verifyAppProxySignature`, signed `logged_in_customer_id` only | **Reuse.** Same trust boundary. |
| Metafield precedent | `carat.luxury_steal` is a **presentation mirror**; the DB row is the system of record | **Follow exactly.** |

Custom Jewelry intake already accepts an optional `projectId` so an
authenticated customer's uploads can be attached to the project they are about
to create. That is the seam the handoff rides on.

---

## 3. Architecture

### 3.1 Compatibility metadata — DB is the system of record

Spec §5 prefers Shopify-native metadata "where practical". It is **not**
practical as the source of truth here, for one reason that decides it: spec §11
requires matching to be deterministic server-side logic with "no client-only
trust boundary". If compatibility lived only in variant metafields, the only
place to read it cheaply would be Liquid — i.e. in the browser, where the
customer can edit it.

So we follow the precedent CLAUDE.md already set for Bank Payment Discount
Eligible and Luxury Steals:

- **`ReadySettingCompatibility` (app DB) is authoritative.** Matching reads it.
- **`carat.sys_eligible` variant metafield is a presentation mirror only** — it
  lets a PDP show a "Works with your own stone" badge without an API call. It
  never decides anything.

Dimensions are stored as **integer micrometres** (`Int`), never floats. 10.12 mm
is `10120`. Spec §11 demands "no floating-point surprises for dimension
comparisons", and CLAUDE.md rule 6 already forbids float money for the same
reason; a 0.01 mm comparison deserves the same discipline.

### 3.2 Stone session — a record that exists before any project

The customer enters stone details *before* deciding between a ready setting and
custom, and may never reach Custom Jewelry at all. A `CustomJewelryProject`
therefore cannot be the first record; it does not exist yet.

New table **`StoneSession`**: the server-authoritative record of the stone, the
viewed/selected setting, and the computed compatibility result. Spec §10.

Handoff does **not** copy stone fields into `CustomJewelryProject`. It adds one
nullable FK, `stoneSessionId`. Spec §10: "Avoid duplicating the same stone
fields across unrelated tables… Preserve a clear source of truth."

```
StoneSession ──1:0..n──> CustomJewelryProject.stoneSessionId (nullable FK)
```

### 3.3 Matching service

`app/app/domain/setyourownstone/matching.ts` — pure, no I/O, unit tested
standalone. Takes a stone and a list of compatibility records, returns
classified candidates. The route does the I/O; the domain does the deciding.

---

## 4. Matching rules (spec §6)

Evaluated in order. **Carat is never an input to compatibility** — it is carried
for display and staff review only.

| # | Condition | Result | Customer label |
|---|---|---|---|
| 0 | `eligibleForSetYourOwnStone = false` | excluded | — |
| 1 | shape ≠ stone shape | excluded | — |
| 2 | vendor min/max present **and** L/W inside it | automatic | **Matches your stone size** |
| 3 | vendor min/max present **and** L/W outside it | excluded | — |
| 4 | no range; L/W equal nominal exactly | automatic | **Recommended size match** |
| 5 | owner-approved tolerance configured for that shape and L/W inside it | automatic | **Recommended size match** |
| 6 | no range, no tolerance, within the **review band** | review required | **May work — review required** |
| 7 | otherwise | excluded | — |

Rule 3 is deliberate: an explicit vendor range is an *authority*, so falling
outside it is a real no, not a maybe.

The review band in rule 6 is **not a fit tolerance** and must never be described
as one. It is a display threshold deciding what a human is asked to look at.
It is configurable, defaults conservative, and produces only "review required"
— never an automatic match. Spec §6.2 forbids inventing a universal tolerance;
this invents no fit claim.

Zero automatic matches → **Custom setting recommended**, with the Custom path
made prominent (spec §6.4).

Every automatic match carries: *"We confirm compatibility before you send your
stone."* The string "Guaranteed fit" is banned and will be pinned by a fence
test, in the same style as `enabledBankPaymentMethodsFence.test.ts`.

---

## 5. Data model

**New: `ReadySettingCompatibility`** (mutable config, one row per setting variant)

`id` · `shopifyVariantGid` (unique) · `shopifyProductGid` · `shape` · 
`nominalLengthUm` · `nominalWidthUm` · `nominalDepthUm?` · `minLengthUm?` ·
`maxLengthUm?` · `minWidthUm?` · `maxWidthUm?` · `eligibleForSetYourOwnStone` ·
`vendorRangeSource?` · timestamps

**New: `StoneSession`** (server-authoritative; spec §10)

`id` · `sessionReference` (customer-facing, collision-retry like
`projectReference`) · `customerRef?` (signed proxy value only) · `stoneType` ·
`shape` · `caratWeight` (Decimal — display only) · `lengthUm` · `widthUm` ·
`depthUm?` · `certLab?` · `certNumber?` · `isCurrentlyMounted` · `notes?` ·
`selectedVariantGid?` · `selectedOptions?` (Json) · `compatibilityStatus?` ·
`compatibilityRule?` (which rule fired — spec §10 "rule/data used to derive it")
· `status` · timestamps

**New: `StoneSessionUpload`** — certificate, mirroring
`CustomJewelryProjectUpload` exactly and consuming the same destination
repository. New table rather than new kind on the existing one, because an
upload must belong to a session that has no project yet.

**Changed: `CustomJewelryProject`** — one nullable FK `stoneSessionId`.

**Changed: `CustomJewelryStartingPoint`** — add `customer_stone`. Additive;
existing rows and the existing zod enum keep working.

**New enums:** `StoneType` (natural_diamond | lab_diamond | gemstone),
`StoneShape`, `StoneCompatibilityStatus`.

**New metafield definition:** `carat.sys_eligible` (boolean, variant) —
presentation mirror only, written by the app, never read by matching.

Migrations split as the repo already does: enum ALTERs separate from table
creation.

---

## 6. Routes and surfaces

**Backend (App Proxy, signed):**
- `apps.carat.stone-session` — POST create/update, returns session + matches
- `apps.carat.stone-session.$ref` — GET resume
- `apps.carat.stone-setting-select` — POST record selection
- `apps.carat.stone-upload-destination` — certificate, reusing the shared repo
- `apps.carat.custom-jewelry-intake` — **extended** to accept
  `stoneSessionReference` and link it

**Storefront:** one new page `/pages/set-your-own-stone` with a three-step
surface (stone form → matched settings → choose), plus a prefill handoff into
the existing Custom Jewelry form. No duplicate custom form (spec §9.1).

**Admin:** `app.ready-settings._index` to maintain compatibility rows.

---

## 7. Security, evidence, accessibility

- `customerRef` only ever from the signed proxy value, never the body.
- Uploads require sign-in — unchanged from Custom Jewelry; no anonymous
  presigned PUTs (standing owner decision).
- Compatibility is computed server-side and persisted with the rule that
  produced it; a client-supplied status is never trusted.
- `StoneSession` is mutable (the customer edits their stone); the **selection**
  and any acknowledgment are append-only, matching existing evidence practice.
- Mobile-first, labelled inputs, inline mm validation, visible focus, no
  colour-only compatibility signalling.

---

## 8. Test plan (written before the UI claims anything — spec §16.6)

Domain, deterministic: shape mismatch · exact nominal · vendor range inside and
outside · configured tolerance · review band · no match · **carat alone never
matches** (two identical carats, different mm, opposite results) · integer
micrometre comparisons with no float drift.

Fence: the string "Guaranteed fit" cannot appear in theme or app source.

Integration: session create → match → select → resume; handoff prefills without
re-entry; Custom Jewelry intake still works with no stone session.

Regression: Buy Now, Group Buy, Luxury Steals, Beat Your Quote, bank payment,
warranty, returns (spec §15.20).

---

## 9. Non-goals

Everything in spec §14, plus: no homepage or navigation change (spec §12 — that
is a separate merchandising decision), and no change to deposit or approval
rules.

---

## 10. Open decisions for the owner

**D1 — There are no ready settings to match against.** The catalog holds one
archived test product and zero variant metafield definitions. Until settings
exist with compatibility metadata, *every* customer will land on "Custom setting
recommended". The feature is still worth building — the custom path is the one
that works today — but half of it will be dark at launch. Confirm you want the
browse half built now.

**D2 — The review band.** Rule 6 needs a default. Proposal: ±0.10 mm on both
length and width, producing only "review required", never a match. It is a
display threshold, not a fit claim. Confirm the number, or set it to zero and
show review-required candidates only where a vendor range exists.

**D3 — Gemstone eligibility.** Spec §4 accepts "Gemstone" as a stone type and
§13 says some stones may need extra review. Do gemstones enter the same ready-
setting browse as diamonds, or go straight to custom?

**D4 — Certificate upload ships disabled.** Uploads are gated off pending the
Fly deploy, so the certificate control will be hidden exactly like Custom
Jewelry's inspiration upload. Confirm that is acceptable rather than blocking.

**D5 — Page placement.** Spec §12 says navigation placement is a separate
decision. The page will exist at `/pages/set-your-own-stone` and be linked from
nowhere until you say otherwise.

---

## 11. Ownership

Domain matching + migrations + routes: backend-pricing-engineer (sonnet).
Storefront surface: frontend-ux-engineer (sonnet). Tests: test-engineer (haiku).
Architecture, the handoff seam, and final review: tech-lead (opus).
