/**
 * OWNER-APPROVED Custom Jewelry intake copy, 2026-10-05, verbatim.
 *
 * Two strings, both approved word for word including the curly apostrophes:
 * the post-submission confirmation and the $49 Design Deposit disclosure.
 * `intakeCopy.test.ts` pins them character for character and
 * `app/theme/ownerApprovedCopy.test.ts` proves the storefront locale file
 * renders the same bytes — the same discipline the warranty acknowledgment
 * follows, and for the same reason: a theme file and a TypeScript constant
 * drift silently, and the drift is only ever noticed by a customer.
 *
 * ============================================================================
 * WHAT MUST *NOT* APPEAR HERE
 * ============================================================================
 * NO RESPONSE-TIME PROMISE. Struck by the owner from the warranty copy twice
 * and from this surface explicitly. "Shortly" and "as soon as possible" are
 * turnaround promises wearing vague coats; the tests reject them by name.
 *
 * NO ABANDONMENT / NON-RESPONSE RULE. Deliberately absent, by an explicit
 * owner instruction — "Keep the intake welcoming." That rule is NOT dropped:
 * it must appear conspicuously on the deposit/design-approval step, where the
 * customer affirmatively accepts it before any money moves. A material
 * condition belongs where it can be acknowledged, not where it reads as a
 * warning to someone who has not been asked for anything yet.
 *
 * AND THE DISCLOSURE MUST NOT IMPLY AN UNCONDITIONAL REFUND. The approved
 * sentence is conditional by construction — "If CaratForUs completes the
 * agreed design stage and you decide not to proceed" — and a test asserts
 * that conditional clause survives any edit. Softening it into "refundable"
 * would promise something the deposit step then contradicts.
 */

/**
 * Shown after a successful enquiry. `{projectReference}` is substituted with
 * the reference the server assigned — never a guess made in the browser.
 */
export const CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE =
  "Thanks — we’ve received your custom jewelry request and recorded it under {projectReference}. " +
  "There’s no charge for this enquiry. We’ll be in touch by email.";

/**
 * Shown ON the intake form, before submission.
 *
 * It names the deposit on the surface where the customer is deciding whether
 * to engage at all — so "this enquiry is free" is a statement they can rely
 * on, not a thing they discover after giving us their details.
 */
export const CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE =
  "This enquiry is free. If we move forward with design/CAD work, there is a $49 Design Deposit. " +
  "The deposit is charged when design/CAD work begins and is credited toward your final price. " +
  "If CaratForUs completes the agreed design stage and you decide not to proceed, the $49 deposit is refunded.";

/**
 * The two approved follow-up choices. The stored enum values are the contract
 * with `custom_jewelry_project.follow_up_preference`; the labels are what the
 * customer reads.
 */
export const CUSTOM_JEWELRY_FOLLOW_UP_CHOICES = [
  { value: "schedule_consultation", label: "Schedule a consultation" },
  { value: "contact_me", label: "Please contact me" },
] as const;

export function buildCustomJewelryIntakeConfirmation(projectReference: string): string {
  return CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE.replace("{projectReference}", projectReference);
}
