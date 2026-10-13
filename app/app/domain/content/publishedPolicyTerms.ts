import { BEAT_QUOTE_POLICY_SLUGS } from "~/domain/beatyourquote/acknowledgmentText";
import { CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG } from "~/domain/customjewelry/designDepositAcknowledgmentText";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG,
} from "~/domain/customjewelry/finalApprovalCopy";
import { GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG } from "~/domain/groupbuy/cancellationAcknowledgmentText";
import {
  BRING_IT_BACK_POLICY_SLUG,
  NEW_CAMPAIGN_REQUEST_POLICY_SLUG,
} from "~/domain/groupbuy/demandCaptureCopy";
import { LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG } from "~/domain/luxurysteals/acknowledgmentText";
import { RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG } from "~/domain/rma/acknowledgmentText";
import { WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG } from "~/domain/warranty/acknowledgmentText";

/**
 * WHICH MATERIAL TERMS A POLICY PAGE MAY QUOTE, and where their words come
 * from.
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES
 * ============================================================================
 * Every `policy_version` row in this system today is an ACKNOWLEDGMENT
 * SENTENCE — the exact words a customer is shown at the moment they accept
 * something, recorded against what they accepted. There is no customer-facing
 * policy PAGE anywhere; the full policies live in `docs/*.md` as internal
 * locked documents.
 *
 * Slice 12 adds those pages. The obvious way to build them — type the terms
 * into a Shopify page — creates a third copy of every material term, with
 * nothing keeping it equal to the locked document or to the sentence the
 * customer actually acknowledged. The three then drift silently, and the first
 * time anyone notices is a dispute where our own page contradicts our own
 * evidence.
 *
 * So a policy page does not RESTATE a material term. It quotes the
 * authoritative row, served by `apps.carat.policies`, and the surrounding
 * narrative is ordinary page copy that explains and links. The quoted
 * sentences cannot drift because there is only ever one of them.
 *
 * ============================================================================
 * WHY AN ALLOWLIST RATHER THAN "PUBLISH EVERY ROW"
 * ============================================================================
 * Everything listed here is ALREADY shown to customers — these are the
 * sentences they are asked to accept — so publishing them reveals nothing new.
 * That is precisely why it would be easy to let the endpoint serve any slug it
 * is handed, and why it must not: `policy_version` is a general versioned-text
 * table, and the first internal or staff-facing policy added to it would
 * become world-readable through a storefront endpoint with no code change and
 * no review.
 *
 * An explicit list means publishing a term is a decision someone makes, in a
 * diff, once.
 *
 * ============================================================================
 * THE TITLES ARE NAVIGATION, NOT TERMS
 * ============================================================================
 * `title` labels the quoted block on a page ("Final sale"). It is a heading
 * chosen for wayfinding and carries no promise — every word with legal weight
 * is in `text`, which comes from the database and never from this file.
 *
 * `group` lets a page assemble its own section without the theme hard-coding
 * which slugs belong together, so adding a term to an existing page is an
 * entry here rather than a theme edit.
 */

export type PublishedPolicyGroup =
  | "returns"
  | "warranty"
  | "luxury-steals"
  | "group-buy"
  | "custom-jewelry"
  | "quote-match";

export interface PublishedPolicyTerm {
  readonly slug: string;
  /** A heading for wayfinding. NEVER a restatement of the term. */
  readonly title: string;
  readonly group: PublishedPolicyGroup;
}

/**
 * ORDER IS PRESENTATION ORDER within a group. Listed explicitly rather than
 * sorted, because "which term a customer reads first" is an editorial choice
 * and alphabetical is not one.
 */
export const PUBLISHED_POLICY_TERMS: readonly PublishedPolicyTerm[] = [
  {
    slug: RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG,
    title: "Returning a Buy Now purchase",
    group: "returns",
  },
  {
    slug: WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
    title: "Making a warranty claim",
    group: "warranty",
  },
  {
    slug: LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
    title: "Luxury Steals are final sale",
    group: "luxury-steals",
  },
  {
    slug: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
    title: "Cancelling a Group Buy order",
    group: "group-buy",
  },
  {
    slug: BRING_IT_BACK_POLICY_SLUG,
    title: "Asking to hear if a Group Buy returns",
    group: "group-buy",
  },
  {
    slug: NEW_CAMPAIGN_REQUEST_POLICY_SLUG,
    title: "Requesting a new Group Buy",
    group: "group-buy",
  },
  {
    slug: CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
    title: "The $49 Design Deposit",
    group: "custom-jewelry",
  },
  {
    slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
    title: "Approving your final design",
    group: "custom-jewelry",
  },
  {
    slug: CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG,
    title: "Custom jewelry is final sale",
    group: "custom-jewelry",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.whatWeMatch,
    title: "What we'll match",
    group: "quote-match",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.authenticity,
    title: "Proving a competitor quote is genuine",
    group: "quote-match",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.recentQuote,
    title: "A recent custom quote",
    group: "quote-match",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.olderQuote,
    title: "An older quote",
    group: "quote-match",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.groupBuy,
    title: "A competing Group Buy",
    group: "quote-match",
  },
  {
    slug: BEAT_QUOTE_POLICY_SLUGS.onlineListing,
    title: "An active online listing",
    group: "quote-match",
  },
];

const PUBLISHED_SLUGS = new Set(PUBLISHED_POLICY_TERMS.map((t) => t.slug));

/** True only for a slug this file deliberately publishes. */
export function isPublishedPolicySlug(slug: string): boolean {
  return PUBLISHED_SLUGS.has(slug);
}
