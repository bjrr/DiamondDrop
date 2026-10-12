import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS } from "./designDepositAcknowledgmentText";

/**
 * Final Approval / Purchase copy — what the customer reads and affirmatively
 * approves before a Custom Jewelry piece is purchased.
 *
 * Same discipline as `designDepositAcknowledgmentText.ts` and
 * `app/domain/warranty/acknowledgmentText.ts`: pinned character for character
 * by `finalApprovalCopy.test.ts`, so a well-meaning edit fails loudly rather
 * than silently changing what the evidence record says the customer agreed to.
 *
 * ============================================================================
 * PROVENANCE OF EVERY SENTENCE — read before editing any of them
 * ============================================================================
 * NOTHING HERE IS DRAFTED FROM SCRATCH. Each string below is either reproduced
 * verbatim from an authoritative source or recast from the owner's own sentence
 * into the first person, which is the split this codebase already draws between
 * a statement made AT the customer and a certification the customer MAKES.
 *
 *   final sale      `README.md` §"Final Approval / Purchase", VERBATIM:
 *                   "Once final design/specifications are approved and the
 *                    jewelry is purchased, the Custom Jewelry order is final
 *                    sale except for covered defects, incorrect
 *                    specifications, shipping damage, or material failure to
 *                    match the approved design/specifications."
 *
 *   warranty        `docs/WARRANTY-CLAIMS.md` §1, VERBATIM in substance:
 *                   a "1-year limited manufacturing warranty" covering
 *                   "qualifying defects in materials, construction, setting,
 *                   or assembly under normal use".
 *
 *   deposit credit  the LOCKED deposit disclosure, which already says the $49
 *                   is "credited toward your final price". The amount is
 *                   imported, never retyped.
 *
 *   shipping        `README.md` §Pricing: packaging, shipping and insurance are
 *                   cost inputs to the selling price. So the honest statement
 *                   is that standard shipping and insurance are INCLUDED in
 *                   the price — not a delivery-time promise, which the README
 *                   does not make and which this file must not invent.
 *
 *   approval scope  the owner's enumeration (2026-10-11) of what the
 *                   acknowledgment must establish: design, specifications,
 *                   materials, dimensions/size, engraving, final price,
 *                   deposit credit, final-sale treatment. Rendered as that
 *                   list and nothing more.
 *
 * ============================================================================
 * THE ACKNOWLEDGMENT IS THE OWNER'S OWN WORDING (version 2, 2026-10-12)
 * ============================================================================
 * Version 1's first-person rendering was mine, flagged for confirmation. The
 * owner reviewed it and supplied version 2 verbatim, along with the checkbox
 * label and the submit-button caption. So this text is no longer a rendering
 * awaiting sign-off — it is the approved wording, reproduced exactly.
 *
 * VERSION 1 IS NOT EDITED AND NOT REMOVED. It is still in `policy_version` and
 * still what existing approval packages point at. That is the entire purpose of
 * versioning: an acknowledgment row references the version it was shown under,
 * so changing v1 would retroactively alter what existing evidence claims a
 * customer agreed to.
 *
 * A further wording change is version 3: a new migration plus a constant bump.
 * Nothing downstream reads these strings by any route other than importing
 * them, so the change lands in one place.
 *
 * ============================================================================
 * WHAT THIS MUST NOT ACQUIRE — and the tests reject each by name
 * ============================================================================
 * NO TURNAROUND PROMISE. No "ships in", no "ready within", no week counts. The
 * owner's instruction is explicit, and a production timeline is something staff
 * state per project from what is actually agreed — which is why the timeline
 * lives on the approval package as free text a human writes, not here.
 *
 * NO REFUND PROMISE beyond the deposit rule already locked. A Custom Jewelry
 * purchase is final sale with four named exceptions; adding a fifth, or
 * softening one, is new policy.
 *
 * NO REPAIR-TIMING PROMISE. The warranty covers defects; how long a remedy
 * takes is not stated anywhere authoritative and must not be invented here.
 *
 * NO DELIVERY-DATE PROMISE. Shipping is included in the price. That is all the
 * README supports.
 */

/**
 * Final sale, VERBATIM from `README.md`. Recast only from "the Custom Jewelry
 * order" to "your order" — the person, not the substance — because this is
 * displayed to the customer rather than describing the policy in the abstract.
 *
 * THE FOUR EXCEPTIONS SHIP WITH IT, ALWAYS. "Final sale" read alone overstates
 * the term: a covered defect, a wrong specification, shipping damage and a
 * material failure to match the approved design all remain claimable. Splitting
 * the sentence would turn a fair term into an unfair-looking one.
 */
export const CUSTOM_JEWELRY_FINAL_SALE_TEXT =
  "Once your final design and specifications are approved and the jewelry is purchased, your Custom Jewelry order is " +
  "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
  "approved design and specifications.";

/**
 * The warranty, from `docs/WARRANTY-CLAIMS.md` §1.
 *
 * NO REMEDY AND NO TIMING. The document is explicit that CaratForUs determines
 * repair, replacement, refund or another appropriate remedy AFTER inspection,
 * and that the customer pays tracked, insured inbound shipping once authorized.
 * Stating a remedy here would promise one before anyone has inspected anything.
 */
export const CUSTOM_JEWELRY_WARRANTY_TEXT =
  "Your piece is covered by the CaratForUs 1-year limited manufacturing warranty, which covers qualifying defects in " +
  "materials, construction, setting, or assembly under normal use.";

/**
 * Shipping. One fact, which is the only one the README supports.
 *
 * NOT A DELIVERY PROMISE, and the test rejects "days", "weeks", "business day"
 * and "arrive" for exactly that reason.
 */
export const CUSTOM_JEWELRY_SHIPPING_TEXT =
  "Standard shipping and insurance are included in the price shown.";

/**
 * The deposit credit, stated as the locked disclosure already states it.
 *
 * THE AMOUNT IS IMPORTED. Retyping "$49" here would let the two drift, and a
 * page that credits one figure while the charge was another is the single
 * worst defect this surface could carry.
 */
export const CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT =
  `Your $${CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS / 100n} Design Deposit has already been paid and is credited against the ` +
  `price below. You pay the remaining balance.`;

/**
 * What the customer certifies.
 *
 * ============================================================================
 * EVERY CLAUSE IS ONE OF THE OWNER'S ENUMERATED ITEMS, IN THEIR ORDER
 * ============================================================================
 * design, specifications, materials, dimensions/size, engraving, final price,
 * deposit credit, final-sale treatment. Nothing is added — no waiver, no
 * limitation of liability, no acceptance of delay, no agreement to terms "as
 * amended". Inventing policy inside an acknowledgment is how a customer ends
 * up agreeing to something nobody approved.
 *
 * "AS DISPLAYED ON THIS PAGE" is load-bearing rather than decorative. The
 * approval is against a frozen package version, and the evidence record points
 * at that exact version — so what the customer approved is recoverable even
 * after a later design revision. A sentence that said merely "my design" would
 * describe nothing checkable.
 *
 * SIZE AND ENGRAVING ARE CONDITIONAL IN REALITY but unconditional here: the
 * sentence says "where applicable", because a ring has a size and a pendant
 * does not, and generating two different acknowledgment texts would mean two
 * different policy versions for the same decision.
 */
export const CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT =
  "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and " +
  "engraving where applicable, exactly as displayed on this page. " +
  "I approve the final price shown and the $49 Design Deposit credit applied to it, and I understand the amount " +
  "due is the remaining balance after that credit. " +
  "I understand that once my final design and specifications are approved and the jewelry is purchased, my order is " +
  "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
  "approved design and specifications.";

/**
 * THIS IS EVIDENCE, NOT DECORATION. It records what the customer actually
 * clicked (`Acknowledgment.affirmativeActionLabel`), so the storefront must
 * IMPORT this constant as the visible button caption rather than retyping the
 * words — if the two drifted, the evidence row would describe a button the
 * customer never saw.
 *
 * "Approve" rather than the deposit's "Authorize", because the customer is
 * approving a design rather than permitting a charge. The ampersand matches the
 * family (`I Certify & Agree`, `I Understand & Agree`, `I Authorize & Agree`).
 */
export const CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL = "I Approve & Agree";

/**
 * The SUBMIT BUTTON caption, which is a different thing from the checkbox
 * label above (owner decision, version 2).
 *
 * ============================================================================
 * WHY TWO CONSTANTS, AND WHICH ONE IS THE EVIDENCE
 * ============================================================================
 * The customer does two things: they TICK a checkbox labelled "I Approve &
 * Agree", then they PRESS a button that says "Approve Design & Continue to
 * Purchase".
 *
 * `affirmativeActionLabel` on the acknowledgment record is the AFFIRMATIVE
 * ACTION — the unchecked thing they had to do deliberately — which is the
 * checkbox. The button is the submit; pressing it without the box ticked
 * achieves nothing, because the route requires the literal `true`.
 *
 * So the checkbox label is what goes in the evidence, and this caption does
 * not. It is pinned all the same, because the storefront must IMPORT it rather
 * than retype it: a button whose words drift from the ones we think it has is
 * how a customer ends up describing an interface nobody can reproduce.
 *
 * The caption also says where pressing it LEADS — "Continue to Purchase" —
 * which matters because approval and purchase are deliberately separate steps.
 * A button that just said "Approve" would leave the customer unsure whether
 * they had committed to buying.
 */
export const CUSTOM_JEWELRY_FINAL_APPROVAL_SUBMIT_BUTTON_LABEL =
  "Approve Design & Continue to Purchase";

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by the provisioning migration and the capture route so both name the
 * same policy by construction rather than by coincidence.
 */
export const CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG = "custom-jewelry-final-approval";

/**
 * Bump together with the text above, as a NEW version, on any approved wording
 * change.
 *
 * VERSION 2 (owner decision 2026-10-12). Version 1 is NOT edited — it is still
 * in the database and still what existing approval packages point at, which is
 * the entire purpose of versioning: an acknowledgment row references the
 * version it was shown under, so changing v1 would retroactively alter what
 * existing evidence claims a customer agreed to.
 *
 * WHAT CHANGED, and it is the middle sentence only. v1 said "the credit of my
 * $49 Design Deposit against it, and I understand I am paying the remaining
 * balance"; v2 says "the $49 Design Deposit credit applied to it, and I
 * understand the amount due is the remaining balance after that credit". The
 * owner's wording names the credit as a thing applied to the price and states
 * the amount due, which is clearer about what is actually being collected.
 */
export const CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION = 2;

/**
 * The final-sale copy's own slug and version.
 *
 * SEPARATE FROM THE ACKNOWLEDGMENT, because the owner requires the approval
 * package to preserve a "warranty/final-sale copy version" distinct from the
 * "approval acknowledgment text/version". They can change independently: the
 * final-sale term could be revised without changing what the customer
 * certifies, and vice versa. One version field covering both would make either
 * change look like the other.
 */
export const CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG = "custom-jewelry-final-sale";
export const CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION = 1;

/**
 * Terms that must never appear in any string in this module.
 *
 * Exported so the test imports the same list the reviewer reads, and so a
 * future surface can reuse it rather than assembling its own.
 */
export const CUSTOM_JEWELRY_FORBIDDEN_PROMISE_TERMS = [
  // Turnaround and delivery.
  "business day",
  "business days",
  "within days",
  "within weeks",
  "ships in",
  "ship in",
  "ready in",
  "ready within",
  "delivered by",
  "delivery date",
  "arrive by",
  "turnaround",
  "lead time",
  // Repair timing.
  "repaired within",
  "repair within",
  "fixed within",
  // Refund softening.
  "full refund",
  "money back",
  "no questions asked",
  "satisfaction guaranteed",
  "guaranteed",
] as const;
