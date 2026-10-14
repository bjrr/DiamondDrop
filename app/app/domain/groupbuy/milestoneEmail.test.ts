import { describe, expect, it } from "vitest";

import {
  buildGroupBuyMilestoneEmail,
  milestoneKey,
  type GroupBuyMilestone,
} from "./milestoneEmail";

/**
 * The milestone emails are a BROADCAST to every participant in a campaign,
 * across both payment bases and every variant. That is what makes the
 * money-silence assertions below the important ones in this file: a figure
 * that is right for one recipient is wrong for the next, and CLAUDE.md §13
 * forbids showing both prices by default on a Group Buy surface anyway.
 */

const CAMPAIGN = { campaignCode: "GB-DEMO-1", campaignName: "Winter Solitaire" };

const TIER: GroupBuyMilestone = { kind: "tier_unlocked", tierNumber: 2, qualifyingUnits: 14 };
const BEST: GroupBuyMilestone = { kind: "best_tier_unlocked", tierNumber: 4, qualifyingUnits: 60 };
const CLOSED: GroupBuyMilestone = { kind: "campaign_closed", finalTierNumber: 3, finalQualifyingUnits: 41 };

const ALL = [TIER, BEST, CLOSED];

describe("no milestone email quotes money", () => {
  it.each(ALL)("$kind states no currency amount", (milestone) => {
    const { subject, text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone });
    for (const part of [subject, text]) {
      // A bare "$", any decimal amount, and the spelled-out codes.
      expect(part).not.toMatch(/\$/);
      expect(part).not.toMatch(/\d+\.\d{2}/);
      expect(part).not.toMatch(/\bUSD\b/);
    }
  });

  it.each(ALL)("$kind never names a payment basis or implies a side-by-side price", (milestone) => {
    const { text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone });
    // CLAUDE.md §13. A broadcast cannot know the recipient's basis, so it must
    // not speak as though it does.
    expect(text).not.toMatch(/bank payment price/i);
    expect(text).not.toMatch(/card price/i);
    expect(text).not.toMatch(/regular price/i);
  });

  it.each(ALL)("$kind never uses forbidden fee wording", (milestone) => {
    // CLAUDE.md §13: never "card fee", "surcharge" or "cash discount".
    const { text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone });
    expect(text).not.toMatch(/surcharge|card fee|cash discount/i);
  });
});

describe("tier unlocked", () => {
  const { subject, text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: TIER });

  it("names the tier and the campaign in the subject", () => {
    expect(subject).toContain("Tier 2");
    expect(subject).toContain("Winter Solitaire");
    expect(subject).toContain("GB-DEMO-1");
  });

  it("states the qualifying unit count", () => {
    expect(text).toContain("14 qualifying units");
  });

  it("says the price can still improve, because the campaign is still open", () => {
    expect(text).toMatch(/still open/);
    expect(text).toMatch(/can still improve/);
  });

  it("tells the customer there is nothing to do", () => {
    // The commonest support question after a pricing email.
    expect(text).toMatch(/nothing you need to do/i);
  });
});

describe("best tier unlocked", () => {
  const { subject, text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: BEST });

  it("says the price cannot improve further, and does not invite more waiting", () => {
    expect(text).toMatch(/cannot improve further/);
    expect(text).not.toMatch(/can still improve/);
  });

  it("is distinguishable from an ordinary tier unlock in the inbox", () => {
    // Same subject line for both would make the best-tier milestone invisible.
    const ordinary = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: TIER }).subject;
    expect(subject).not.toEqual(ordinary);
    expect(subject).toMatch(/best price/i);
  });
});

describe("campaign closed", () => {
  const { subject, text } = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: CLOSED });

  it("states the locked final count and tier", () => {
    expect(text).toContain("Final qualifying units: 41");
    expect(text).toContain("Final tier: 3");
  });

  it("says the campaign has closed", () => {
    expect(subject).toMatch(/closed/i);
  });

  it("promises no refund amount", () => {
    // README: the system calculates refunds, a person approves them. Quoting
    // an amount here would commit money nobody has approved.
    expect(text).not.toMatch(/\d+\.\d{2}/);
    expect(text).toMatch(/after review/i);
  });

  it("does not promise a refund date or call it automatic", () => {
    expect(text).not.toMatch(/within \d+ (business )?days/i);
    expect(text).not.toMatch(/automatically refund/i);
  });

  it("says a separate email follows if a refund is processed", () => {
    expect(text).toMatch(/email you separately/i);
  });
});

describe("pluralisation", () => {
  it("says 'unit' for one and 'units' for more", () => {
    const one = buildGroupBuyMilestoneEmail({
      ...CAMPAIGN,
      milestone: { kind: "tier_unlocked", tierNumber: 2, qualifyingUnits: 1 },
    }).text;
    expect(one).toContain("1 qualifying unit ");
    expect(one).not.toContain("1 qualifying units");
  });
});

describe("milestoneKey", () => {
  it("distinguishes every milestone, including tier from best-tier at the same number", () => {
    const keys = [
      milestoneKey({ kind: "tier_unlocked", tierNumber: 3, qualifyingUnits: 0 }),
      milestoneKey({ kind: "best_tier_unlocked", tierNumber: 3, qualifyingUnits: 0 }),
      milestoneKey({ kind: "campaign_closed", finalTierNumber: 3, finalQualifyingUnits: 0 }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it("does not vary with the unit count", () => {
    // The key must identify the MILESTONE, not the moment. A key that moved
    // with the count would re-send the same tier email on every sweep.
    expect(milestoneKey({ kind: "tier_unlocked", tierNumber: 2, qualifyingUnits: 10 })).toEqual(
      milestoneKey({ kind: "tier_unlocked", tierNumber: 2, qualifyingUnits: 99 })
    );
  });

  it("is stable text, because it is persisted in idempotency keys", () => {
    // Changing these strings re-sends every milestone once. Pinned on purpose.
    expect(milestoneKey({ kind: "tier_unlocked", tierNumber: 2, qualifyingUnits: 0 })).toBe("tier:2");
    expect(milestoneKey({ kind: "best_tier_unlocked", tierNumber: 5, qualifyingUnits: 0 })).toBe("best_tier:5");
    expect(milestoneKey({ kind: "campaign_closed", finalTierNumber: 2, finalQualifyingUnits: 0 })).toBe("closed");
  });
});

describe("the module is pure", () => {
  it("produces identical output for identical input", () => {
    const a = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: CLOSED });
    const b = buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone: CLOSED });
    expect(a).toEqual(b);
  });

  it("contains no link, matching every other customer email in this codebase", () => {
    for (const milestone of ALL) {
      expect(buildGroupBuyMilestoneEmail({ ...CAMPAIGN, milestone }).text).not.toMatch(/https?:\/\//);
    }
  });
});
