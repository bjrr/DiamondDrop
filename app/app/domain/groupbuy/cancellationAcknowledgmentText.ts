/**
 * Group Buy cancellation acknowledgment — the pinned, OWNER-APPROVED copy
 * (README "Group Buy — Locked MVP1 Direction" cancellation/close rules,
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md, owner approval 2026-09-27).
 *
 * APPROVED, NOT DRAFTED HERE. Same discipline as
 * `app/domain/rma/acknowledgmentText.ts` and
 * `app/domain/warranty/acknowledgmentText.ts`: every character below is
 * reproduced exactly from the owner's own approval — pinned character-for-
 * character by `cancellationAcknowledgmentText.test.ts` so a well-meaning
 * copy edit fails loudly rather than silently changing what the evidence
 * record says the customer agreed to. Do not paraphrase, re-wrap, or "fix"
 * punctuation. Any future approved wording change must add a NEW
 * `policy_version` (version 2) via a NEW migration, mirroring
 * `20260927040000_group_buy_cancellation_policy_version` (below), and bump
 * `GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION` here to match —
 * never silently edit this string or an already-applied migration.
 *
 * TWO DISTINCT STRINGS, ON PURPOSE, PER THE OWNER'S OWN APPROVAL. The owner
 * approved a longer "customer-facing disclosure copy" paragraph AND a
 * shorter "required UNCHECKED acknowledgment" sentence as separate texts —
 * unlike RMA/warranty, which each approved only one string. Same precedent
 * as `RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT`'s own header comment on "what
 * this text deliberately does not restate": the DISCLOSURE (below) is
 * conspicuous surrounding copy a caller displays near the checkbox, while
 * the shorter CHECKBOX statement is the one thing the customer affirmatively
 * checks — and therefore the one recorded as `Acknowledgment.exactText` and
 * the one whose `policy_version` row every capture route resolves. Folding
 * the disclosure into the checkbox text (or vice versa) would misstate what
 * the evidence row says the customer actually did.
 *
 * "I UNDERSTAND & AGREE", NOT "I CERTIFY & AGREE" — DELIBERATE, NOT A TYPO.
 * The owner chose the Final Sale family's label here, not the RMA/warranty
 * family's: the customer is accepting TERMS of a policy (what happens if
 * they later want to cancel), not attesting to FACTS about their own claim
 * or item condition. Do not unify this with
 * `RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL` /
 * `WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL` — the owner's
 * instruction was explicit that these two families stay distinct.
 */

/**
 * The locale key `theme/sections/group-buy-campaign.liquid` reads the
 * identical disclosure paragraph from — Liquid cannot import a TypeScript
 * module, so the theme's copy is genuinely a second artefact.
 * `cancellationAcknowledgmentText.test.ts` reads it from disk and asserts
 * byte-identity, mirroring `notCommittedDisclosure.ts`'s identical pattern
 * (see that module's own header comment for why this is a test, not a
 * runtime import).
 */
export const GROUP_BUY_CANCELLATION_DISCLOSURE_LOCALE_PATH = [
  "templates",
  "group_buy_campaign",
  "cancellation_disclosure",
] as const;

/** Mirrors `GROUP_BUY_CANCELLATION_DISCLOSURE_LOCALE_PATH` for the shorter checkbox statement. */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LOCALE_PATH = [
  "templates",
  "group_buy_campaign",
  "cancellation_checkbox_label",
] as const;

/**
 * The longer, surrounding disclosure paragraph — UI copy displayed near the
 * checkbox (same conspicuous-disclosure role as
 * `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §10's item-condition/
 * personalization/outbound-shipping disclosures next to the RMA checkbox).
 * NOT the `policy_version.text` / `Acknowledgment.exactText` value — see this
 * module's header comment for why that is
 * `GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT` below instead.
 */
export const GROUP_BUY_CANCELLATION_DISCLOSURE_TEXT =
  "Before the campaign closes, you may request a cancellation, but cancellation is not automatic and requires CaratForUs approval. " +
  "Once the campaign closes, your Group Buy order is committed and cannot be canceled or returned because you change your mind. " +
  "This does not affect claims for defects, incorrect items or specifications, shipping damage, warranty issues, fulfillment problems, or other rights required by law.";

/**
 * The required checkbox statement — THE evidence text. Recorded verbatim as
 * `Acknowledgment.exactText`, and the `text` provisioned for
 * `GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG` by the migration below.
 */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT =
  "I understand that cancellation requests before the campaign closes require CaratForUs approval, and that once the campaign closes my Group Buy order is committed and is not eligible for discretionary cancellation or return.";

/**
 * Owner-approved 2026-09-27, matching the Final Sale family's
 * "I Understand & Agree" — see this module's header comment for why this is
 * deliberately NOT the RMA/warranty family's "I Certify & Agree".
 *
 * THIS IS EVIDENCE, NOT DECORATION — see `~/domain/rma/acknowledgmentText.ts`'s
 * own comment on this exact point. Every caller that renders the visible
 * checkbox caption (the theme's Group Buy campaign section, and any future
 * confirmation surface) must IMPORT this constant rather than retyping the
 * words; if the two ever drift, the evidence row would describe a button the
 * customer never actually saw.
 */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL = "I Understand & Agree";

/** Mirrors `GROUP_BUY_CANCELLATION_DISCLOSURE_LOCALE_PATH` for the affirmative-action label. */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LABEL_LOCALE_PATH = [
  "templates",
  "group_buy_campaign",
  "cancellation_affirm_label",
] as const;

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by `prisma/migrations/20260927040000_group_buy_cancellation_policy_version`
 * (which provisions v1) and every capture route (which resolves the latest
 * version under it) so both sides name the same policy by construction.
 */
/**
 * THE LINE-ITEM PROPERTY THAT CARRIES THE ACKNOWLEDGMENT ID TO SHOPIFY AND
 * BACK. The `orders/create` webhook resolves a line's acknowledgment candidate
 * from this property and from nothing else, so a Group Buy line that reaches
 * Shopify without it verifies as `no_candidate` -> `unmatched` -> HELD, and
 * records ZERO qualifying units.
 *
 * DEFINED HERE, in the domain, rather than in either consumer. Two paths put
 * it on a line and one path reads it back:
 *   - Card: the storefront cart gate attaches it at add-to-cart time.
 *   - Bank Payment: `apps.carat.group-buy-bank-checkout.tsx` attaches it as a
 *     draft-order line `customAttributes` entry (Shopify surfaces draft-order
 *     line custom attributes as order line-item `properties`, which is the
 *     shape the webhook reads).
 *   - `groupBuyOrderHandler.server.ts` reads it.
 *
 * It previously lived as a private const inside the webhook handler, which is
 * how the Bank Payment path came to omit it entirely: the writer could not
 * import what the reader kept to itself. One definition, imported by every
 * side, is the thing that makes "both paths agree on the name" checkable
 * rather than hopeful. Never inline this string at a call site.
 */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME = "_carat_gb_cancel_ack";

export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG = "group-buy-cancellation-acknowledgment";

/** The version provisioned alongside `GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT` above. Bump together with the text (as a NEW version) on any future approved wording change. */
export const GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION = 1;
