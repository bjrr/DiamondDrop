/**
 * GROUP BUY MILESTONE EMAILS — the participant notifications README line 245
 * requires: "Email participants at meaningful milestones such as tier unlock,
 * best-tier unlock, campaign close/final price... Do not email for every unit
 * change."
 *
 * ============================================================================
 * THE THREE MILESTONES, AND ONLY THOSE
 * ============================================================================
 * tier unlock, best-tier unlock, campaign close. README also allows an
 * OPTIONAL "very close to the next tier" nudge; MVP1 is under a scope freeze,
 * "optionally" is not "required", so it is deliberately not built. Adding it
 * is a product decision, not a formatting change.
 *
 * Skipped tiers are NOT backfilled. If the group crosses tiers 2 and 3 between
 * two sweeps, participants hear about tier 3 — the tier they are actually on.
 * Mailing them "tier 2 unlocked" afterwards would be stale news presented as
 * current.
 *
 * ============================================================================
 * NO MONEY FIGURE APPEARS IN ANY OF THESE EMAILS. THIS IS DELIBERATE.
 * ============================================================================
 * Three independent reasons, each sufficient on its own:
 *
 *   1. These are BROADCASTS to every participant in a campaign. A campaign can
 *      carry several variants and both payment bases, so there is no single
 *      "your price" to state. A figure correct for one recipient is wrong for
 *      the next.
 *   2. CLAUDE.md §13 forbids showing Regular/Card and Bank Payment side by side
 *      by default on Group Buy surfaces, and a broadcast cannot know which
 *      basis a given recipient is on. Printing one figure would mislead half
 *      the list; printing both breaches the locked display rule.
 *   3. The campaign page already derives price per selected configuration and
 *      per payment type, from the frozen campaign rules. It is the
 *      authoritative price surface. A second, less-informed copy of that
 *      derivation sitting in an email is precisely the kind of drift
 *      `campaignTierPricing.ts` was extracted to prevent.
 *
 * What the emails state instead is the thing that IS campaign-level and
 * unambiguous: the qualifying unit count and the tier number. The tier number
 * is what determines the price, so "tier 3 is unlocked" is a complete and
 * correct statement of the pricing outcome without quoting a number that would
 * be wrong for somebody.
 *
 * ============================================================================
 * THE CLOSE EMAIL PROMISES NO REFUND AMOUNT AND NO DATE
 * ============================================================================
 * README: at close "the system calculates refunds, admin explicitly
 * approves/processes them." So the close email says a difference will be
 * calculated and refunded after review, and that a separate email follows when
 * one is processed. It must not state an amount — the amount is not approved
 * at the moment this email is sent — and must not imply the refund is
 * automatic.
 *
 * ============================================================================
 * PURE MODULE
 * ============================================================================
 * No environment access, no clock, no money arithmetic, no I/O. Everything is
 * passed in, exactly as `groupBuyPaymentInstructionsEmail.ts` does it. No link
 * is included because no customer email in this codebase contains one and
 * there is no configured public storefront base to build one from; inventing an
 * env var for it here would be scope creep.
 */

export type GroupBuyMilestone =
  /** A tier below the best one became the group's tier. */
  | { readonly kind: "tier_unlocked"; readonly tierNumber: number; readonly qualifyingUnits: number }
  /** The highest tier the campaign defines. The price cannot improve further. */
  | { readonly kind: "best_tier_unlocked"; readonly tierNumber: number; readonly qualifyingUnits: number }
  /** Campaign closed; the locked final count and tier. */
  | {
      readonly kind: "campaign_closed";
      readonly finalTierNumber: number;
      readonly finalQualifyingUnits: number;
    };

export interface GroupBuyMilestoneEmailInput {
  /** The code a customer sees on the campaign page and quotes back to us. */
  readonly campaignCode: string;
  /** Human-readable campaign name, so the subject line means something in an inbox. */
  readonly campaignName: string;
  readonly milestone: GroupBuyMilestone;
}

export interface GroupBuyMilestoneEmailContent {
  readonly subject: string;
  readonly text: string;
}

/**
 * A stable short label for the milestone, used both in the idempotency key and
 * in structured logs. Exported so the sweep cannot invent a second spelling —
 * a key built from a different string would re-send every milestone once.
 */
export function milestoneKey(milestone: GroupBuyMilestone): string {
  switch (milestone.kind) {
    case "tier_unlocked":
      return `tier:${milestone.tierNumber}`;
    case "best_tier_unlocked":
      return `best_tier:${milestone.tierNumber}`;
    case "campaign_closed":
      return "closed";
  }
}

export function buildGroupBuyMilestoneEmail(
  input: GroupBuyMilestoneEmailInput
): GroupBuyMilestoneEmailContent {
  const { campaignCode, campaignName, milestone } = input;
  const campaign = `${campaignName} (${campaignCode})`;

  switch (milestone.kind) {
    case "tier_unlocked":
      return {
        subject: `Tier ${milestone.tierNumber} unlocked on ${campaign}`,
        text: [
          "Hi there,",
          "",
          `Good news — ${campaign} has reached ${units(milestone.qualifyingUnits)} and unlocked tier ${milestone.tierNumber}.`,
          "",
          `Everyone in this campaign, including you, is now on the tier ${milestone.tierNumber} price. There is nothing you need to do.`,
          "",
          "The campaign is still open, so the price can still improve if more units are ordered. Your final price is confirmed when the campaign closes.",
          "",
          "You can see the current price for your configuration on the campaign page.",
          "",
          "CaratForUs",
        ].join("\n"),
      };

    case "best_tier_unlocked":
      return {
        subject: `Best price unlocked on ${campaign}`,
        text: [
          "Hi there,",
          "",
          `${campaign} has reached ${units(milestone.qualifyingUnits)} and unlocked tier ${milestone.tierNumber} — the best price this campaign offers.`,
          "",
          "Everyone in this campaign, including you, is now on that price. There is nothing you need to do, and the price cannot improve further.",
          "",
          "Your final price is confirmed when the campaign closes.",
          "",
          "CaratForUs",
        ].join("\n"),
      };

    case "campaign_closed":
      return {
        subject: `${campaign} has closed`,
        text: [
          "Hi there,",
          "",
          `${campaign} has now closed.`,
          "",
          `Final qualifying units: ${milestone.finalQualifyingUnits}`,
          `Final tier: ${milestone.finalTierNumber}`,
          "",
          `Your order is priced at the tier ${milestone.finalTierNumber} price for the configuration you chose.`,
          "",
          // No amount, no date, no promise that it is automatic — the refund is
          // calculated by the system and approved by a person, in that order.
          "If you ordered earlier at a higher tier, we work out the difference and refund it to your original payment method after review. We'll email you separately if a refund has been processed for your order.",
          "",
          "CaratForUs",
        ].join("\n"),
      };
  }
}

/** "1 qualifying unit" / "12 qualifying units" — a stray plural reads as a bug. */
function units(count: number): string {
  return `${count} qualifying unit${count === 1 ? "" : "s"}`;
}
