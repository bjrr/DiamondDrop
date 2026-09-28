import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE TEMPORARY PRODUCTION LOCK on opening a Group Buy campaign (owner-directed
 * 2026-09-28). Deleted together with the guard itself once the seven-case
 * acknowledgment live gate passes in production.
 *
 * WHY IT IS TESTED IN BOTH DIRECTIONS. A lock that refuses everything is not a
 * lock, it is an outage — and one that refuses nothing is decoration. The
 * cases below pin exactly three things:
 *
 *   - production + flag unset            -> REFUSED
 *   - production + flag set to "true"    -> allowed through the guard
 *   - non-production                     -> never consulted at all
 *
 * THE REFUSAL IS ASSERTED TO HAPPEN BEFORE ANY DATABASE READ. `prisma` is
 * mocked to throw on use, so if the guard were ever moved below the campaign
 * lookup this test fails with that error instead of the lock error — which is
 * the point, since opening freezes pricing and publishes to Shopify, and a
 * guard that runs after those have begun is refusing a decision already partly
 * taken.
 */

const mockEnv = vi.hoisted(() => ({
  value: { APP_ENV: "production", GROUP_BUY_CAMPAIGN_OPEN_ENABLED: undefined } as {
    APP_ENV: string;
    GROUP_BUY_CAMPAIGN_OPEN_ENABLED?: string;
  },
}));

vi.mock("~/lib/env.server", () => ({
  getEnv: () => mockEnv.value,
}));

// Any database use at all is a failure for the refusal case — see the header.
vi.mock("~/db/client.server", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("the production lock must refuse BEFORE any database access");
      },
    }
  ),
}));

const { openGroupBuyCampaign, GroupBuyCampaignOpenLockedError } = await import(
  "~/jobs/groupbuy/openCampaign.server"
);

afterEach(() => {
  mockEnv.value = { APP_ENV: "production", GROUP_BUY_CAMPAIGN_OPEN_ENABLED: undefined };
});

describe("opening a Group Buy campaign is locked in production", () => {
  it("REFUSES in production when the flag is absent — before touching the database", async () => {
    mockEnv.value = { APP_ENV: "production" };
    await expect(openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" })).rejects.toBeInstanceOf(
      GroupBuyCampaignOpenLockedError
    );
  });

  it("REFUSES in production for any value that is not exactly \"true\"", async () => {
    // Guards written as truthiness checks accept "false", "0" and "no" — each
    // of which a human would read as OFF. This one compares to "true".
    for (const value of ["false", "0", "no", "TRUE", "True", "1", "yes", ""]) {
      mockEnv.value = { APP_ENV: "production", GROUP_BUY_CAMPAIGN_OPEN_ENABLED: value };
      await expect(
        openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" }),
        `GROUP_BUY_CAMPAIGN_OPEN_ENABLED=${JSON.stringify(value)} must not unlock production`
      ).rejects.toBeInstanceOf(GroupBuyCampaignOpenLockedError);
    }
  });

  it("carries a message naming the flag and why the lock exists", async () => {
    mockEnv.value = { APP_ENV: "production" };
    await expect(openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" })).rejects.toThrow(
      /GROUP_BUY_CAMPAIGN_OPEN_ENABLED/
    );
    await expect(openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" })).rejects.toThrow(/monotonic/);
  });

  it("does NOT refuse in production once the flag is exactly \"true\" — it proceeds to real work", async () => {
    mockEnv.value = { APP_ENV: "production", GROUP_BUY_CAMPAIGN_OPEN_ENABLED: "true" };
    // Passes the guard, then hits the mocked database — proving the lock is
    // what stopped the calls above, not something else failing earlier.
    await expect(openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" })).rejects.toThrow(
      /must refuse BEFORE any database access/
    );
  });

  it("is never consulted outside production, whatever the flag says", async () => {
    for (const appEnv of ["development", "test", "staging"]) {
      mockEnv.value = { APP_ENV: appEnv };
      await expect(
        openGroupBuyCampaign({ campaignId: "any", openedBy: "staff" }),
        `${appEnv} must not be locked`
      ).rejects.toThrow(/must refuse BEFORE any database access/);
    }
  });
});
