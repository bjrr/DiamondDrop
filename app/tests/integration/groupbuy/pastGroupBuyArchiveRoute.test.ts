import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } from "~/domain/groupbuy/testFixtureCampaign";
import { archiveGroupBuyCampaign } from "~/db/repositories/groupBuyRepository.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { loader } from "~/routes/apps.carat.past-group-buys";

/**
 * The PUBLIC Past Group Buys archive, end to end.
 *
 * ============================================================================
 * THE TWO DIRECTIONS OF THE SAME MISTAKE
 * ============================================================================
 * Owner-locked 2026-10-05, and the reason `campaignVisibility.ts` keeps the
 * two predicates separate:
 *
 *   - a TEST campaign must never appear here, archived or not;
 *   - a real completed campaign must STAY here even after staff archive it
 *     internally, because archiving is a dashboard decision and says nothing
 *     about whether customers may see that the campaign happened.
 *
 * Both are asserted below against real campaigns in a real database, because
 * both are filter mistakes that leave every other test passing.
 *
 * The third assertion that matters is the negative one: a signed, public
 * response must carry no cost, margin, or customer data — this endpoint needs
 * no authentication at all, so whatever it returns is world-readable.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

/** Signs query params exactly as Shopify's App Proxy does. */
function signed(path: string, params: Record<string, string>): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url);
}

function call(params: Record<string, string> = {}) {
  return loader({
    request: signed("/apps/carat/past-group-buys", {
      shop: "caratforus-dev.myshopify.com",
      ...params,
    }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

interface ArchiveBody {
  campaigns: {
    code: string;
    name: string;
    currency: string;
    closedAt: string;
    finalQualifyingUnits: number;
    startingRegularCardPrice: string;
    finalRegularCardPrice: string;
    finalTierNumber: number;
    priceIsFromLowestVariant: boolean;
    priceFellBy: string | null;
  }[];
  regularCardPriceNote: string;
}

/** A real campaign: opened through the freeze, bought from, then closed. */
async function closedCampaign(options?: { code?: string; units?: number }) {
  const variant = await prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });

  const code = options?.code ?? `gb-past-${uniq()}`;
  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code,
      name: `archive fixture ${code}`,
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [
          { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
        ],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

  const units = options?.units ?? 6;
  await recordUnitEvent({
    campaignId: draft.id,
    masterVariantId: variant.id,
    kind: "purchased",
    quantity: units,
    orderRef: `order-${uniq()}`,
    lineRef: `line-${uniq()}`,
    externalRef: `ext-${uniq()}`,
    occurredAt: ASOF,
    recordedBy: "test",
  });

  await closeGroupBuyCampaign({ campaignId: draft.id, closedBy: "staff" });
  return { campaignId: draft.id, code, units };
}

describe("the App Proxy boundary", () => {
  it("REJECTS an unsigned request", async () => {
    const response = await loader({
      request: new Request("https://shop.example.com/apps/carat/past-group-buys"),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(response.status).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    const response = await call();
    expect(response.status).toBe(200);
  });
});

describe("what the archive publishes", () => {
  it("includes a real closed campaign with its LOCKED final unit count", async () => {
    const { code, units } = await closedCampaign({ units: 7 });
    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;

    const row = body.campaigns.find((c) => c.code === code);
    expect(row).toBeDefined();
    expect(row!.finalQualifyingUnits).toBe(units);
    expect(row!.finalTierNumber).toBe(2);
    expect(row!.currency).toBe("USD");
  });

  it("carries the Regular/Card note required by the pricing policy", async () => {
    const body = (await (await call()).json()) as ArchiveBody;
    expect(body.regularCardPriceNote).toMatch(/Regular\/Card/);
    expect(body.regularCardPriceNote).toMatch(/Bank Payment/);
    // NEVER THE INTERNAL PERCENTAGE, and never the words the policy forbids.
    expect(body.regularCardPriceNote).not.toMatch(/surcharge|card fee|cash discount|%/i);
  });

  it("does NOT include an open campaign — only past ones", async () => {
    const variant = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", isLuxurySteal: false },
      orderBy: { baseWeightGrams: "desc" },
    });
    const code = `gb-still-open-${uniq()}`;
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code,
        name: "still open",
        currency: "USD",
        createdBy: "integration-test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          ],
        },
        variants: {
          create: [
            { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
          ],
        },
      },
    });
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;
    expect(body.campaigns.some((c) => c.code === code)).toBe(false);
  });
});

describe("the two directions of the visibility mistake", () => {
  it("NEVER includes a live-gate fixture campaign", async () => {
    const { code } = await closedCampaign({
      code: `${TEST_FIXTURE_CAMPAIGN_CODE_PREFIX}past-${uniq()}`,
    });
    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;
    expect(body.campaigns.some((c) => c.code === code)).toBe(false);
  });

  it("STILL includes a real campaign that staff archived internally", async () => {
    // THE ASSERTION MOST AT RISK OF BEING "TIDIED" AWAY. Someone adding
    // `archivedAt: null` to this query would make a real campaign vanish from
    // customer-visible history the moment staff cleaned up their dashboard,
    // and nothing else would fail.
    const { campaignId, code } = await closedCampaign();
    await archiveGroupBuyCampaign({
      campaignId,
      archivedBy: "staff:ada",
      reason: "tidying the operational list",
    });

    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;
    expect(body.campaigns.some((c) => c.code === code)).toBe(true);
  });
});

describe("the limit", () => {
  it("defaults to the five most recent", async () => {
    for (let i = 0; i < 6; i += 1) await closedCampaign();
    const body = (await (await call()).json()) as ArchiveBody;
    expect(body.campaigns.length).toBeLessThanOrEqual(5);
  });

  it("returns newest first", async () => {
    await closedCampaign();
    await closedCampaign();
    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;
    const dates = body.campaigns.map((c) => Date.parse(c.closedAt));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("ignores a nonsense limit rather than coercing it", async () => {
    for (const bad of ["-5", "abc", "5.5", "1e3", ""]) {
      const response = await call({ limit: bad });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ArchiveBody;
      expect(body.campaigns.length).toBeLessThanOrEqual(5);
    }
  });

  it("caps a huge limit", async () => {
    const response = await call({ limit: "999" });
    expect(response.status).toBe(200);
  });
});

describe("nothing private reaches this public endpoint", () => {
  it("returns no cost, margin, supplier, profile or customer data", async () => {
    await closedCampaign();
    const raw = await (await call({ limit: "50" })).text();
    const lower = raw.toLowerCase();
    for (const forbidden of [
      "landedcost",
      "frozenlandedcost",
      "grossmargin",
      "wholesale",
      "supplier",
      "pricingprofile",
      "snapshot",
      "mastervariant",
      "multiplier",
      "orderref",
      "customer",
      "email",
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("returns no bank payment price — Regular/Card only", async () => {
    await closedCampaign();
    const body = (await (await call({ limit: "50" })).json()) as ArchiveBody;
    const row = body.campaigns[0]!;
    expect(Object.keys(row).join(",")).not.toMatch(/bank/i);
  });

  it("is publicly cacheable, because locked history cannot go stale", async () => {
    const response = await call();
    expect(response.headers.get("Cache-Control")).toMatch(/public/);
  });
});
