# Set Your Own Stone — Locked MVP1 Requirements

Status: **Owner-approved feature requirements**
Scope: CaratForUs storefront + application backend
Feature name: **Set Your Own Stone**

This document is authoritative for the Set Your Own Stone feature. If a general README summary conflicts with this document, this document controls for this feature. Do not invent unresolved business rules or broaden the service beyond what is specified here.

## 1. Purpose

CaratForUs must provide a dedicated customer path for people who already own a diamond or gemstone and want CaratForUs to:

1. set that stone into an eligible existing/ready-made CaratForUs mounting; or
2. create a custom mounting around the customer's stone.

The feature should feel simple and high-trust. It is a front door into either a ready-setting selection flow or the existing Custom Jewelry workflow. It is **not** a separate second custom-jewelry system.

Customer-facing positioning may use:

**Set Your Own Stone**

Supporting concept:

**Your stone. Your setting.**

The page should make clear that the customer can browse compatible ready settings first and move into Custom Jewelry if they do not find what they want.

## 2. Customer experience — top-level flow

The customer flow is:

1. Customer tells CaratForUs about the stone they already own.
2. Immediately after stone intake, present two equally clear paths:
   - **Find a Ready Setting** — show compatible ready-made mountings based on the stone's shape and dimensions.
   - **Create My Own Setting** — skip ready-mount browsing and continue directly into the existing Custom Jewelry workflow with all stone information already carried forward.
3. If the customer chooses **Find a Ready Setting**, show eligible ready-made mountings based on the stone's shape and dimensions.
4. Customer may select an eligible ready setting, choose the available customer-facing options (such as metal and ring size), resolve to the exact Shopify variant, and proceed through normal checkout whether the compatibility result is **Matches your stone size** or **May work — jeweler review required**.
5. A Review Required result is a post-purchase jeweler-review flag, not a checkout blocker.
6. **Create My Own Setting** must remain available throughout ready-mount browsing and detail views. A customer may switch to Custom Jewelry at any time because:
   - no ready mounting qualifies;
   - ready mountings qualify but the customer does not like them;
   - the customer already has a design/mounting in mind;
   - the customer wants to upload inspiration, a sketch, or another jeweler/mounting reference;
   - the customer wants to modify/customize a ready mounting they viewed.
7. When moving to Custom Jewelry, all stone information already supplied must transfer automatically. The customer must not be required to re-enter it.
8. If the customer enters Custom Jewelry from a ready mounting they viewed, preserve that mounting as an optional inspiration/reference.
9. The existing Custom Jewelry workflow then governs inspiration uploads, description of the desired design, consultation, design/CAD work where needed, deposit, approvals, and downstream ordering.

The page must not make the customer understand technical mounting/head-size terminology to browse, and it must never force a customer to browse ready mountings before choosing Custom Jewelry.

## 3. Set Your Own Stone landing page

The landing page should be concise and functional, not a long operational explanation.

Recommended structure:

### Compact hero
- Heading: **Set Your Own Stone**
- Supporting message: customer already owns a diamond or gemstone and can choose a ready CaratForUs setting or create a custom one.
- Primary action: begin with the customer's stone.
- Secondary action may explain the simple process.

### Two paths
After stone details are known, clearly expose both choices at the same level of prominence:

**Find a Ready Setting**
- Supporting concept: **Show me settings that may work with my stone.**
- Browse ready-made settings intended for the customer's stone shape/size.
- If no automatic/review candidates qualify, show a clear **Custom setting recommended** state and make **Create My Own Setting** the primary next action.

**Create My Own Setting**
- Supporting concept: **I already know what I want or want something custom.**
- Skip ready-setting browsing entirely.
- Continue into the existing Custom Jewelry workflow using the stone information already supplied.
- Allow the customer to upload inspiration photos, sketches, or reference images and describe the mounting/design they want.
- This path must be available even when compatible ready mountings exist.

During ready-setting browse, keep a persistent **Create My Own Setting** action visible. If the customer viewed a ready mounting before switching paths, offer **Customize this setting for my stone** where appropriate and carry that mounting forward as inspiration.

Do not create a separate duplicate custom-design form on the Set Your Own Stone page. Reuse the existing Custom Jewelry workflow and upload capability.

## 4. Stone information collected once

Collect only information needed to identify the stone and match ready settings.

Required unless otherwise noted:

- stone type:
  - Natural diamond
  - Lab-grown diamond
  - Gemstone
- shape
- carat weight
- exact length in millimeters
- exact width in millimeters
- depth in millimeters, when known
- certification/report lab, optional
- certification/report number, optional
- certificate upload, optional
- whether the stone is:
  - loose;
  - currently mounted in a prong setting; or
  - currently mounted in another/unsupported type of setting
- optional customer notes

The UI should explain that length/width/depth can usually be found on a grading report/certificate.

**Carat weight must not be the primary ready-mount compatibility rule.** Two stones with the same carat weight can have materially different dimensions. Ready-setting matching is based primarily on **shape + millimeter dimensions**.

## 5. Ready-mount compatibility metadata

Every ready-made setting that participates in this feature must have structured compatibility metadata.

At minimum, each eligible setting/variant must be able to define:

- supported center-stone shape
- recommended/nominal center-stone length in mm
- recommended/nominal center-stone width in mm
- recommended/nominal depth in mm if the supplier provides it
- whether the item is eligible for Set Your Own Stone
- Shopify product/variant identity
- setting title/handle/SKU as applicable
- setting image
- metal/options already supported by the product
- optional explicit minimum/maximum accepted dimensions when supplied by the manufacturer/vendor
- optional compatibility tolerance only when explicitly approved/configured
- **whether the mounting's setting style is reasonably adjustable by prong setting**, which determines whether it receives the approved ±0.3 mm allowance of §6.2 (owner decision 2026-10-31)
- **active/inactive status**, so a mounting can be withdrawn from Set Your Own Stone without deleting its compatibility record and losing the history of what customers were shown

Prong-adjustability must default to **not eligible**. A mounting that has not been assessed must never inherit a fit allowance: a bezel, channel or tension setting advertised as a size match would be discovered at the bench, after the customer has already posted their own stone.

Staff must be able to maintain all of the above through an **operator screen in the embedded CaratForUs admin**. Direct database editing is not an acceptable normal workflow (owner decision 2026-10-31).

These values must be structured data, not parsed from product titles at runtime.

Prefer existing Shopify-native product/variant metadata/metafields where practical, with app persistence only where needed. Do not hard-code a catalog of mount sizes into storefront JavaScript.

## 6. Compatibility matching rules

### 6.1 Primary matching
Ready settings are filtered first by:

1. eligible for Set Your Own Stone;
2. compatible stone shape; and
3. recommended stone dimensions.

Example:

A ready mounting specified for an **Oval 10 x 7 mm** center should be surfaced for a customer's oval stone when the approved compatibility logic maps the supplied stone dimensions to that recommended size.

Do not match a 10 x 7 oval mounting merely because the customer owns a stone of a similar carat weight.

### 6.2 Nominal sizes and tolerances
Vendors commonly describe ready mountings by nominal recommended sizes such as 10 x 7 mm, 9 x 7 mm, 12 x 6 mm, etc.

The application must support those nominal dimensions directly.

**Do not invent a universal jewelry-fit tolerance.** Fit tolerance can vary by shape, head/basket design, vendor, and construction. This prohibition binds the implementation, not the owner: a tolerance that is explicitly approved and recorded here is a decision, not an invention.

### 6.2.1 Approved matching behavior (owner decision, locked 2026-10-31)

Professional prong-set mountings routinely accommodate small dimensional differences during setting. The owner has therefore approved the following, which is **authoritative for MVP1**:

| Condition | Outcome |
| --- | --- |
| Explicit manufacturer/vendor min/max range present | **The vendor range decides, always.** Inside the range is an automatic match; outside it is not a candidate. |
| Same shape, exact nominal length and width | Automatic match |
| Same shape, prong-adjustable mounting, difference up to and including **±0.3 mm** in the relevant length and/or width | Automatic match — **Matches your stone size** |
| Difference greater than 0.3 mm but no more than **1.0 mm** | **Review Required** |
| Difference greater than 1.0 mm | Not presented as a normal compatible ready-mount candidate; direct the customer toward **Create a Custom Setting** |

Three constraints on the above, each of which must hold independently:

1. **Explicit manufacturer/vendor ranges always take precedence.** The ±0.3 mm allowance never overrides a published vendor restriction, and never extends one. Where a vendor range exists it is the only dimensional rule consulted — whether its bounds are narrower or wider than ±0.3 mm.
2. **Mountings that are not prong-adjustable do not receive the ±0.3 mm automatic allowance.** Eligibility is recorded per mounting (§5) and defaults to not eligible.
3. **The 1.0 mm figure is a review/discovery band only. It is not a compatibility promise**, and must never be described to a customer as a fit, a tolerance, or a range we accept.

Shape is matched before any dimension is compared. A difference within either band never admits a mounting of the wrong shape.

**Never use "Guaranteed fit"** — see §6.3.

The matching service must make tolerance/range data configurable so a later owner-approved rule does not require rewriting the storefront. Both figures above are configuration, held in one place, not constants scattered through storefront JavaScript.

### 6.3 Customer-facing compatibility language
The website must not promise guaranteed physical fit from an automated calculation.

Allowed concepts:
- **Matches your stone size**
- **Recommended size match**
- **May work — review required**
- **Custom setting recommended**

Which phrasing applies, per the 2026-10-31 decision:

- an exact nominal match, a mounting inside its vendor range, and a mounting inside the approved ±0.3 mm prong-setting allowance all read **Matches your stone size**;
- **Recommended size match** is reserved for a future owner-approved per-shape tolerance, which is not configured in MVP1;
- anything in the 0.3–1.0 mm review band reads **May work — review required**;
- anything beyond reads **Custom setting recommended**.

An exact nominal match must not read less confidently than a stone 0.3 mm away from nominal.

Any automatic match should be accompanied by concise language that CaratForUs confirms compatibility before the customer sends the stone.

Do not use **Guaranteed fit**. Do not state the ±0.3 mm or 1.0 mm figures to the customer as a promise, a tolerance, or an accepted range; they are internal matching configuration.

### 6.4 No-match behavior
If no ready setting qualifies as an automatic match:

- do not show irrelevant mountings as if compatible;
- offer review-required candidates only when the matching rules permit;
- prominently offer **Create a Custom Setting**.

## 7. Ready-setting browse experience

After stone information is provided, the customer should land on a browse experience framed around their stone, for example:

**Settings for your oval diamond**
2.34 ct · 10.12 x 7.08 mm

The ready-setting results should:

- show only relevant shape/size results by default;
- preserve normal useful product options such as metal and ring size where applicable;
- show the setting's compatibility status;
- present a large, clear primary product image as a major element of each mounting card;
- show Regular Price, Bank Payment Price/savings where applicable, and the compatibility status;
- preserve normal useful product options such as metal and ring size;
- allow the customer to open a detailed mounting view from the image, title, or a clear **View Details** action;
- allow both Automatic Match and Review Required results to be selected and purchased normally;
- keep a persistent path to **Create a Custom Setting**.

The customer should not need to manually choose a head size such as 10 x 7 mm when the system already knows the customer's stone dimensions.

If the same design is available with multiple center heads/sizes, model those sizes in structured variant/compatibility data and route the customer to the appropriate configuration internally. The matcher locks the center-size profile; the customer chooses only normal customer-facing options such as Metal and Ring Size, which must resolve to a real Shopify variant.

The customer-facing mounting card/detail view must not expose the complete supported center-size/profile matrix or vendor/manufacturer mounting weight. It may show contextual language such as **Selected for your stone** or **Matched setting size: 9 x 7 mm** for the customer's selected profile. Raw vendor SKU, supplier cost, internal profile IDs, Shopify GIDs, tolerance implementation details, internal pricing components and mounting gram weight are internal-only.

## 8. Ready-setting selection

When the customer selects a ready setting, preserve:

- the customer's stone information;
- the selected Shopify product/variant;
- the selected setting's nominal/recommended stone size;
- selected metal/options/ring size where applicable;
- compatibility result;
- customer notes.

For both **Matches your stone size** and **May work — jeweler review required**, the customer must be able to proceed through the normal purchasing flow using the selected real Shopify variant. Review Required must not be converted into quote-only, request-only, or pre-payment staff approval.

For Review Required, show:

**May work — jeweler review required**

and supporting language substantially equivalent to:

**Your stone's dimensions are slightly outside the standard measurements for this setting. Our trained jewelers will review your stone details after your order and confirm whether any extra time is needed to securely set your stone due to its non-standard dimensions.**

Do not guarantee fit and do not introduce an extra compatibility fee unless separately approved.

Preserve the compatibility result in the StoneSession/order context so staff can distinguish `AUTOMATIC` from `REVIEW_REQUIRED`.

Do not instruct the customer to ship the stone before CaratForUs confirms the project and provides next-step/shipping instructions.

## 9. Custom-setting handoff

### 9.1 Reuse the existing Custom Jewelry workflow
Selecting **Create a Custom Setting** must continue into the existing Custom Jewelry flow. Do not create a second custom-jewelry implementation.

The Custom Jewelry flow should know that:

**Customer is supplying the center stone = Yes**

### 9.2 Transfer all prior data
The transition must preserve the same project/session context and prefill all applicable data already provided, including:

- stone type
- natural/lab status where applicable
- shape
- carat weight
- dimensions
- certificate/report information
- certificate upload reference if present
- loose/currently-mounted status
- notes
- customer/contact context already known

Do not ask the customer to re-enter information already supplied.

### 9.3 Carry source-setting inspiration
If the customer enters Custom Jewelry from a ready setting they viewed or nearly selected, preserve the source setting as inspiration:

- product/variant identity
- title/SKU/handle
- image/reference
- selected options where relevant

The Custom Jewelry workflow may present this as the starting design reference.

Provide an action such as **Customize this setting for my stone** where appropriate.

### 9.4 Inspiration uploads
Once in Custom Jewelry, customers must be able to upload inspiration images/sketches using the existing Custom Jewelry upload capability when that capability is enabled/deployed.

Do not duplicate upload infrastructure specifically for Set Your Own Stone.

Existing Custom Jewelry rules, including the $49 Design Deposit and approval-before-production workflow, continue to apply after the handoff unless a later owner decision changes them.

## 10. Persistence / backend requirements

The feature must preserve customer state across navigation and handoff.

Implement a server-authoritative project/session record or reuse an existing suitable Custom Jewelry intake/project record. Do not rely solely on client-side query parameters/localStorage for authoritative data.

The persisted context must support at least:

- project/session ID
- authenticated customer ID when available/required by the existing workflow
- stone attributes
- optional certificate metadata/file reference
- selected ready setting/product/variant
- selected ready-setting options
- compatibility status + rule/data used to derive it
- source-setting reference when handing off to Custom Jewelry
- timestamps/status needed for safe resume/continuation

Avoid duplicating the same stone fields across unrelated tables unless the architecture requires a snapshot. Preserve a clear source of truth.

## 11. Matching service / backend logic

Implement ready-setting discovery as server-side/domain logic that can be tested independently from the storefront UI.

Inputs:
- stone type as needed for eligibility
- stone shape
- exact customer dimensions
- eligible setting compatibility metadata

Outputs should classify candidates, at minimum, into:
- automatic recommended-size matches;
- review-required candidates where explicitly allowed by configured data/rules;
- non-matches.

Requirements:
- deterministic;
- no floating-point surprises for dimension comparisons;
- no carat-only compatibility decisions;
- no client-only trust boundary;
- no hard-coded universal tolerance;
- unit tested around shape mismatch, exact nominal match, explicit ranges, configured tolerance, and no-match/custom fallback.

## 12. Frontend requirements

The frontend should:

- be mobile-first and accessible;
- collect stone details once;
- validate millimeter inputs clearly;
- show the customer's stone summary during ready-setting browse;
- filter/display relevant ready settings;
- display compatibility status without promising guaranteed fit;
- expose a clear Custom Setting escape path at all times;
- preserve state when moving into Custom Jewelry;
- avoid technical jargon where the customer does not need it;
- avoid requiring the customer to understand mount/head size codes;
- avoid duplicate Custom Jewelry forms.

Do not make changes to unrelated homepage sections or existing purchase paths merely to add this feature.

Navigation/homepage placement for the new page is a separate merchandising decision unless the owner explicitly approves it.

## 13. Customer-facing operational scope

Keep operational language intentionally light.

The Set Your Own Stone page should **not** advertise a detailed stone-intake/chain-of-custody process.

Do not promise:
- detailed arrival photography/video;
- weighing/measurement procedures;
- laser-inscription verification;
- specific inbound insurance coverage;
- appraisal;
- guaranteed acceptance;
- guaranteed fit;
- other operational intake steps that have not been separately approved.

A concise instruction is sufficient:

**Please do not send your stone until CaratForUs confirms your project and provides shipping instructions.**

Some stones may require additional review before CaratForUs accepts the project. Keep that statement general unless a later policy defines specific gemstone exclusions/conditions.

## 14. Out of scope unless separately approved

Do not add these merely because the feature exists:

- a second Custom Jewelry workflow;
- automated appraisal/valuation;
- customer-facing chain-of-custody promises;
- universal hard-coded setting tolerances;
- automatic acceptance of every gemstone;
- removing a stone from a non-prong existing setting;
- new shipping-insurance guarantees;
- complex computer-vision measurement from uploaded images;
- automatic manufacturer ordering;
- homepage/navigation restructuring beyond explicit owner instruction.

## 15. Acceptance criteria

Implementation is complete only when all of the following are demonstrated:

1. A customer can open Set Your Own Stone and enter a stone once.
2. Shape + millimeter dimensions are captured and validated.
3. Eligible ready settings carry structured compatibility metadata.
4. Ready-setting results are filtered by shape and dimension compatibility rules.
5. Carat weight alone can never cause a setting to be marked compatible.
6. A setting with the wrong shape is not shown as an automatic match.
7. An exact nominal-dimension match can be surfaced correctly.
8. Explicit vendor min/max ranges work when configured.
9. No universal tolerance is silently invented.
10. Near-size candidates without an approved rule are not represented as guaranteed fits.
10a. A prong-adjustable mounting matches a same-shape stone up to and including ±0.3 mm from nominal, and reads **Matches your stone size** (§6.2.1).
10b. A difference over 0.3 mm and up to 1.0 mm is **Review Required**, never an automatic match, at any configured band width.
10c. A difference over 1.0 mm is not presented as a normal compatible candidate; the customer is directed to **Create a Custom Setting**.
10d. An explicit vendor range takes precedence in both directions: it refuses a stone inside ±0.3 mm when the range is narrower, and admits one outside ±0.3 mm when the range is wider.
10e. A mounting not marked prong-adjustable receives no automatic allowance, including every record that has never been assessed.
10f. Staff can maintain every compatibility field from the embedded admin without direct database access.
11. No-match customers receive a clear Custom Setting path.
12. The customer can enter Custom Jewelry without retyping prior stone information.
13. A source ready setting can transfer as inspiration into Custom Jewelry.
14. Custom Jewelry inspiration uploads continue through the existing upload capability rather than a duplicate upload system.
15. Existing Custom Jewelry deposit/approval rules still apply after handoff.
16. The customer is told not to send the stone until CaratForUs confirms the project and provides instructions.
17. The page does not advertise unapproved intake, insurance, appraisal, or guaranteed-fit promises.
18. Matching rules have deterministic automated tests.
19. Frontend handoff/resume behavior has integration coverage.
20. Existing Buy Now, Group Buy, Luxury Steals, Beat Your Quote, bank-payment, warranty, and return behavior is not regressed.

## 16. Implementation process

This is a non-trivial cross-frontend/backend feature.

Before implementation:

1. read this document, README.md, CLAUDE.md, and the existing Custom Jewelry implementation;
2. inspect how Custom Jewelry intake/project persistence and upload references currently work;
3. create a bounded feature spec/implementation plan using the repository's existing Claude workflow;
4. prefer Shopify-native product/variant metadata for ready-mount compatibility where practical;
5. reuse existing Custom Jewelry persistence/upload/deposit flows rather than duplicating them;
6. implement backend matching logic with tests before wiring storefront claims to it;
7. stage theme/storefront work on a draft theme and follow the required safe theme-push process;
8. verify mobile + desktop, state transfer, compatibility classification, and regression tests before release.


## 17. Owner decisions — 2026-11-02

The following decisions are locked and supersede any older conflicting wording in this document.

### 17.1 Mounting detail experience

From a SYOS result card, the customer must be able to open the mounting from the product image, title, or a clear **View Details** action.

The detail experience should reuse Shopify product data rather than create a duplicate catalog and should show relevant customer-facing information including:

- all appropriate product images;
- product title and description;
- transformed CaratForUs SKU where a SKU is appropriate;
- metal;
- setting style;
- band details;
- pavé and hidden-halo details where applicable;
- Regular Price;
- Bank Payment Price and exact savings where applicable;
- available Metal choices;
- available Ring Size choices;
- other appropriate customer-facing design/construction specifications.

The customer must be able to continue mounting selection/checkout from the detailed view without losing the StoneSession or compatibility context.

### 17.2 Customer-visible vs internal mounting data

Do not expose:

- complete supported center-stone size/profile lists;
- vendor/manufacturer mounting gram weight;
- raw vendor SKU;
- supplier cost/wholesale price;
- Shopify GIDs;
- internal compatibility/profile record IDs;
- tolerance implementation details;
- internal pricing component amounts or metafield names.

If SKU is shown, show only the transformed CaratForUs SKU governed by `docs/VENDOR-SKU-TRANSFORMATION.md`.

### 17.3 Stone removal service

CaratForUs offers stone removal only when the customer's center stone is currently held in a **prong setting** (including standard/claw-prong variations that are fundamentally prong settings).

Customer intake must distinguish:

- `LOOSE`
- `MOUNTED_PRONG`
- `MOUNTED_UNSUPPORTED`

If `MOUNTED_PRONG`:

- offer **Stone Removal — $50**;
- charge it once per customer center stone requiring removal;
- do not multiply by prong count;
- show it separately to the customer;
- preserve the removal selection/state through StoneSession → cart/order → operations.

Suggested customer-facing supporting copy:

**Our jewelers can carefully remove your center stone from a standard prong setting before setting it into your new mounting.**

Do not promise risk-free removal or guarantee that an existing stone cannot be damaged.

If the stone is mounted in a bezel, tension, flush, channel, or other non-prong setting:

- CaratForUs does not offer removal;
- do not charge the $50 service;
- tell the customer to have the stone professionally removed before sending it to CaratForUs;
- allow the customer to continue choosing/designing the new setting.

Suggested copy:

**We currently only offer stone removal for prong-set stones. Please have your stone professionally removed before sending it to CaratForUs. You can still continue designing your new setting.**

### 17.4 Removal is independent of compatibility

Automatic Match and Review Required customers may both purchase normally.

A Review Required customer with a prong-set stone may select the mounting, choose Metal/Ring Size, add the $50 Stone Removal service, and pay normally. The order/session must preserve both the compatibility status and removal state.

### 17.5 Customer-facing mounting price composition

All normal mounting/manufacturing pricing components are combined into the finished mounting price and are not itemized to the customer.

Do not separately show:

- large-stone setting labor;
- band pavé labor;
- hidden-halo amount;
- ring-size adjustment;
- supplier markup/cost.

The **$50 Stone Removal** service is the approved exception and should be shown separately when applicable.

The underlying vendor-mounting pricing formula and structured inputs are governed by `docs/VENDOR-MOUNTING-PRICING-AND-CATALOG.md`.

### 17.6 SYOS-only catalog visibility

Ready mountings imported specifically for Set Your Own Stone must not appear as ordinary items under **Shop Jewelry** or normal storefront discovery. Follow `docs/VENDOR-MOUNTING-PRICING-AND-CATALOG.md` for catalog visibility requirements.

### 17.7 Required additional tests

Add deterministic/integration coverage for:

1. Automatic Match can select an actual variant and checkout normally.
2. Review Required can select an actual variant and checkout normally.
3. Review Required messaging uses the approved jeweler-review concept and does not guarantee fit.
4. Mounting cards show a clear, large product image and detailed view is accessible.
5. Complete supported-size lists and mounting gram weight are hidden from customers.
6. Raw vendor SKU is never customer-facing; transformed CaratForUs SKU is used where appropriate.
7. Loose stone → no removal fee.
8. Prong-set stone → exactly one $50 removal fee.
9. Non-prong mounted stone → removal unavailable, but new-setting design may continue.
10. Compatibility status and removal state both survive StoneSession/cart/order handoff.
11. Internal setting/pavé/hidden-halo/ring-size pricing components never render as separate customer line items.
12. SYOS-only mountings do not appear in normal Shop Jewelry discovery.
