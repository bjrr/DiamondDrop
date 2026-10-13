import { describe, expect, it } from "vitest";

import {
  EXCLUDE_TEST_FIXTURE_CAMPAIGNS,
  TEST_FIXTURE_CAMPAIGN_CODE_PREFIX,
  isTestFixtureCampaignCode,
} from "./testFixtureCampaign";

describe("live-gate fixture campaigns are identifiable from their code alone", () => {
  it("recognises a fixture code", () => {
    expect(isTestFixtureCampaignCode("zz-live-gate-1791171465467")).toBe(true);
  });

  it("does not mistake a business campaign for a fixture", () => {
    for (const code of ["spring-halo", "zz-top-tribute", "live-gate-not-prefixed", "ZZ-LIVE-GATE-UPPER"]) {
      expect(isTestFixtureCampaignCode(code), `"${code}" is a business code`).toBe(false);
    }
  });

  it("is case-sensitive on purpose", () => {
    // Every gate CREATES the prefix in lower case, so a case-insensitive match
    // would only ever add false positives — it could silently hide a real
    // campaign somebody happened to name "ZZ-Live-Gate-Spring". Hiding a real
    // campaign from the dashboard is the worse failure of the two.
    expect(isTestFixtureCampaignCode("ZZ-Live-Gate-1")).toBe(false);
  });

  it("the Prisma fragment excludes exactly the prefix, not a looser pattern", () => {
    // `startsWith`, not `contains`: a business campaign whose code merely
    // CONTAINS the phrase must stay visible.
    expect(EXCLUDE_TEST_FIXTURE_CAMPAIGNS).toEqual({
      code: { not: { startsWith: TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } },
    });
    expect(isTestFixtureCampaignCode("spring-zz-live-gate-lookalike")).toBe(false);
  });

  it("the prefix is what the gates actually create", () => {
    // Guard against this constant drifting away from the scripts. If a gate
    // ever changes its prefix, fixtures stop being excluded ANYWHERE and the
    // failure is silent — a test campaign appearing on a dashboard, or worse,
    // reachable on the storefront.
    expect(TEST_FIXTURE_CAMPAIGN_CODE_PREFIX).toBe("zz-live-gate-");
  });
});
