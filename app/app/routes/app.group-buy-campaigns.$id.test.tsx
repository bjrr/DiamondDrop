import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import GroupBuyCampaignDetailPage from "./app.group-buy-campaigns.$id";
import {
  GroupBuyCampaignNotDraftForConfigurationError,
  PRESENTATION_EDITABLE_STATUSES,
} from "~/db/repositories/groupBuyRepository.server";
import { validateGroupBuyCampaignOptions } from "~/domain/groupbuy/campaignOptions";
import {
  emptyCampaignBuilderState,
  MIN_PRESENTATION_REASON_LENGTH,
  type CampaignBuilderState,
} from "~/domain/groupbuy/campaignBuilder";

/**
 * Same technique as `app.warranty-claims.$id.test.tsx`: nothing is mocked.
 * Only the loader's (and, where relevant, the action's) RESULT is supplied —
 * running the real loader/action would call `authenticate.admin` and the
 * database. The domain/repository logic this page calls into (tier
 * validation, campaign-options validation, `openGroupBuyCampaign`'s tier
 * safety and price-ladder checks, the draft-only guard, and "a second open
 * is refused") is exercised for real elsewhere — `tiers.test.ts`,
 * `campaignOptions.test.ts`, `tierSafety.test.ts`, and
 * `tests/integration/groupbuy/openCampaign.test.ts` (see that file's
 * "REFUSES a second open attempt on an already-open campaign" case). This
 * file's job is the UI-gating and error-surfacing logic that is genuinely
 * new here: which controls a draft/open/closed campaign offers, that an
 * upload rejection is shown VERBATIM (offending key and path), that an
 * unoverridable price-ladder failure never renders an override control, and
 * that no cost/margin figure ever reaches rendered output.
 */

const ROUTE_ID = "group-buy-campaign-detail";

interface TierFixture {
  tierNumber: number;
  minQualifyingUnits: number;
  priceMultiplier: string;
  percentOff: string;
}
interface VariantFixture {
  masterVariantId: string;
  productName: string;
  metal: string;
  purity: string;
  bandLabel: string | null;
  frozenBaseBankPaymentPrice: string | null;
}
interface CampaignFixture {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  scheduledCloseAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  finalTierNumber: number | null;
  finalQualifyingUnits: number | null;
  unsafeOverrideBy: string | null;
  unsafeOverrideReason: string | null;
  unsafeOverrideAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  history: { describedParts: readonly string[]; hasHistory: boolean };
  tiers: TierFixture[];
  variants: VariantFixture[];
  tierPublish: { tierNumber: number; qualifyingUnits: number; published: boolean } | null;
}

const VARIANT_ID = "22222222-2222-2222-2222-222222222222";

const DRAFT_CAMPAIGN: CampaignFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "gb-summer-rings",
  name: "Summer Rings Group Buy",
  status: "draft",
  currency: "USD",
  scheduledCloseAt: null,
  openedAt: null,
  closedAt: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  finalTierNumber: null,
  finalQualifyingUnits: null,
  unsafeOverrideBy: null,
  unsafeOverrideReason: null,
  unsafeOverrideAt: null,
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  // An empty draft: nothing to lose, so deletion is genuinely available.
  history: { describedParts: [], hasHistory: false },
  tiers: [
    { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000", percentOff: "0.0000" },
    { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000", percentOff: "10.0000" },
  ],
  variants: [
    {
      masterVariantId: VARIANT_ID,
      productName: "Solitaire Band",
      metal: "gold",
      purity: "k14",
      bandLabel: "Size 7",
      frozenBaseBankPaymentPrice: null,
    },
  ],
  tierPublish: null,
};

const OPEN_CAMPAIGN: CampaignFixture = {
  ...DRAFT_CAMPAIGN,
  status: "open",
  openedAt: "2026-09-22T12:00:00.000Z",
  variants: [{ ...DRAFT_CAMPAIGN.variants[0]!, frozenBaseBankPaymentPrice: "120000" }],
  tierPublish: { tierNumber: 1, qualifyingUnits: 3, published: true },
};

// THE GAP `app.group-buy-campaigns.$id.tsx`'s "TIER-PRICE-SYNC RECOVERY"
// header comment describes: an open campaign whose current tier price never
// reached Shopify (e.g. `openGroupBuyCampaign`'s tier-1 publish failed, or a
// later tier's publish failed).
const OPEN_CAMPAIGN_UNPUBLISHED: CampaignFixture = {
  ...OPEN_CAMPAIGN,
  tierPublish: { tierNumber: 1, qualifyingUnits: 0, published: false },
};

const CLOSED_CAMPAIGN: CampaignFixture = {
  ...OPEN_CAMPAIGN,
  status: "closed",
  closedAt: "2026-09-25T12:00:00.000Z",
  finalTierNumber: 2,
  finalQualifyingUnits: 14,
  // Not applicable once closed — frozen pricing stays exactly as it was,
  // regardless of Shopify's last-known price. See getGroupBuyCampaignTierPublishStatus.
  tierPublish: null,
};

interface ActionFixture {
  ok: boolean;
  formError: string | null;
  problems: readonly string[];
  openBlocked?:
    | { kind: "unsafe"; entries: readonly { masterVariantId: string; tierNumber: number; failing: readonly string[] }[] }
    | {
        kind: "ladder";
        problems: readonly { masterVariantId: string; priorTierNumber: number; tierNumber: number; detail: string }[];
      };
  tierResyncResult?: { tierNumber: number; skipped: boolean; syncedVariantCount: number; unresolvedVariantCount: number };
  settlementComputeResult?: { created: number; skipped: number; owedCount: number; unresolvedLineRefs: readonly string[] };
}

interface RefundFixture {
  id: string;
  lineRef: string;
  orderRef: string;
  paymentBasis: string;
  paidPerUnit: string;
  finalPerUnit: string;
  qualifyingUnits: number;
  refundAmount: string;
  status: string;
  approvedAt: string | null;
  approvedByActorRef: string | null;
  processorReference: string | null;
  failureReason: string | null;
}

interface UnresolvedRefundLineFixture {
  masterVariantId: string;
  orderRef: string;
  lineRef: string;
  qualifyingUnits: number;
  reason: string;
}

function renderPage(
  campaign: CampaignFixture | null,
  options?: {
    candidateVariants?: { masterVariantId: string; label: string }[];
    optionsUpload?: unknown;
    actionData?: ActionFixture;
    refunds?: RefundFixture[];
    unresolvedRefundLines?: UnresolvedRefundLineFixture[];
    builderState?: CampaignBuilderState;
    mappableVariants?: { masterVariantId: string; label: string }[];
    pricePreview?: unknown;
    generatedOptionsJson?: string | null;
    presentationEditable?: boolean;
    presentationVersions?: {
      version: number;
      priorVersion: number | null;
      changedBy: string;
      changedAt: string;
      reason: string;
    }[];
  }
): string {
  const loaderData = {
    apiKey: "test-public-client-id",
    shop: "caratforus-dev.myshopify.com",
    campaign,
    candidateVariants: options?.candidateVariants ?? [],
    optionsUpload: options?.optionsUpload ?? null,
    refunds: options?.refunds ?? [],
    unresolvedRefundLines: options?.unresolvedRefundLines ?? [],
    // The visual campaign builder's half of the loader. An empty state is the
    // right default: a campaign nobody has configured yet.
    builderState: options?.builderState ?? emptyCampaignBuilderState(),
    builderSavedAt: null,
    mappableVariants: options?.mappableVariants ?? [],
    pricePreview: options?.pricePreview ?? null,
    generatedOptionsJson: options?.generatedOptionsJson ?? null,
    shopifyFilesUrl: "https://admin.shopify.com/store/caratforus-dev/content/files",
    // Mirrors the loader by USING THE SAME SET the loader and the write
    // gate use, rather than restating the rule. A restated copy is how the
    // "withdrawn once closed" test below went on passing for a moment after
    // the policy changed to allow closed campaigns: the stub still said
    // draft-or-open, so it was asserting the fixture, not the page.
    presentationEditable:
      options?.presentationEditable ??
      (campaign !== null && PRESENTATION_EDITABLE_STATUSES.has(campaign.status)),
    presentationVersions: options?.presentationVersions ?? [],
  };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/group-buy-campaigns/:id",
        Component: GroupBuyCampaignDetailPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: [`/app/group-buy-campaigns/${campaign?.id ?? "unknown"}`],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(options?.actionData ? { actionData: { [ROUTE_ID]: options.actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

// Strips tags/attributes (which also removes CSS `margin:`/`padding:` style
// text — those live only in `style="..."` attributes) and decodes the
// handful of entities React's SSR escaper actually produces, so a fixture
// string containing a literal quote or ampersand can still be compared
// against the rendered text directly.
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const NO_COST_MARGIN_LEAK = /grossmarginrate|bankpaymentcontribution|frozenlandedcost|landedcost|wholesale/i;

describe("campaign not found", () => {
  it("shows a clear not-found message rather than crashing", () => {
    expect(textOf(renderPage(null))).toMatch(/not found/i);
  });
});

describe("a draft campaign", () => {
  it("offers tier editing, variant add/remove, options upload, and the open action", () => {
    const html = renderPage(DRAFT_CAMPAIGN);
    expect(html).toMatch(/Save tiers/);
    expect(html).toMatch(/name="intent" value="remove_variant"/);
    expect(html).toMatch(/Validate &amp; upload/);
    expect(html).toMatch(/Open campaign and freeze pricing/);
    expect(textOf(html)).toMatch(/freezes this campaign.s cost inputs, tier prices/);
  });

  it("never renders cost, margin, or landed-cost data", () => {
    expect(renderPage(DRAFT_CAMPAIGN)).not.toMatch(NO_COST_MARGIN_LEAK);
  });

  it("does not show a frozen price column while draft (the stored value is a placeholder, never a real price)", () => {
    const html = renderPage(DRAFT_CAMPAIGN);
    expect(html).not.toMatch(/Frozen Bank Payment base/);
  });
});

describe("an open campaign", () => {
  it("has no draft-only mutation controls — the tier/variant/options forms are entirely absent, not merely disabled", () => {
    const html = renderPage(OPEN_CAMPAIGN);
    expect(html).not.toMatch(/Save tiers/);
    expect(html).not.toMatch(/name="intent" value="add_variant"/);
    expect(html).not.toMatch(/name="intent" value="remove_variant"/);
    expect(html).not.toMatch(/name="intent" value="upload_options"/);
    expect(html).not.toMatch(/Open campaign and freeze pricing/);
    expect(textOf(html)).toMatch(/frozen and cannot be edited/i);
    expect(textOf(html)).toMatch(/can only be changed while the campaign is draft/i);
  });

  it("shows the frozen Bank Payment base price once open", () => {
    const html = renderPage(OPEN_CAMPAIGN);
    expect(html).toMatch(/Frozen Bank Payment base/);
    expect(textOf(html)).toMatch(/USD 1,200\.00/);
  });

  it("a draft-only-mutation refusal (e.g. a stale tab retrying a save) is shown verbatim, not swallowed", () => {
    const message = new GroupBuyCampaignNotDraftForConfigurationError(OPEN_CAMPAIGN.id, "open").message;
    const html = renderPage(OPEN_CAMPAIGN, { actionData: { ok: false, formError: message, problems: [] } });
    expect(textOf(html)).toContain(message);
  });
});

describe("Shopify tier-price sync — the resync recovery surface", () => {
  it("does not render the sync section at all for a draft campaign (nothing frozen yet to publish)", () => {
    expect(textOf(renderPage(DRAFT_CAMPAIGN))).not.toMatch(/Shopify tier-price sync/i);
  });

  it("does not render the sync section for a closed campaign (frozen pricing stays exactly as it was)", () => {
    expect(textOf(renderPage(CLOSED_CAMPAIGN))).not.toMatch(/Shopify tier-price sync/i);
  });

  it("a healthy open campaign (tier published) shows a calm, non-alarming status and still offers the resync control", () => {
    const html = renderPage(OPEN_CAMPAIGN);
    const text = textOf(html);
    expect(text).toMatch(/Tier 1.*is published and live on Shopify/);
    expect(text).not.toMatch(/NOT reached Shopify/);
    expect(html).toMatch(/name="intent" value="resync_tier_price"/);
  });

  it("THE GAP — an open campaign whose tier price never reached Shopify is visibly and distinctly flagged, asserted on the field rather than styling", () => {
    // The assertion is on rendered TEXT driven by `campaign.tierPublish.published`
    // (the loader's view-model field), not on any style/color attribute —
    // proving the state is visible to someone who never opens devtools.
    const html = renderPage(OPEN_CAMPAIGN_UNPUBLISHED);
    const text = textOf(html);
    expect(text).toMatch(/Tier 1.*has NOT reached Shopify/);
    expect(text).not.toMatch(/is published and live on Shopify/);
  });

  it("offers the resync action only while the campaign is open, and never leaks cost/margin data from it", () => {
    const html = renderPage(OPEN_CAMPAIGN_UNPUBLISHED);
    expect(html).toMatch(/name="intent" value="resync_tier_price"/);
    expect(html).toMatch(/Resync tier price to Shopify/);
    expect(html).not.toMatch(NO_COST_MARGIN_LEAK);
  });

  it("attribution is server-derived from the authenticated session only — the resync form carries no staff-identity field a client could tamper with (D23)", () => {
    const html = renderPage(OPEN_CAMPAIGN_UNPUBLISHED);
    expect(html).not.toMatch(/name="staffActorRef"|name="authorizedBy"|name="openedBy"|name="triggeredBy"/);
  });

  it("a no-op resync result (already up to date) is reported plainly, distinct from a resync that actually published something", () => {
    const html = renderPage(OPEN_CAMPAIGN, {
      actionData: { ok: true, formError: null, problems: [], tierResyncResult: { tierNumber: 1, skipped: true, syncedVariantCount: 0, unresolvedVariantCount: 0 } },
    });
    expect(textOf(html)).toMatch(/Already up to date/);
  });

  it("a resync that actually published reports the tier and the number of variants published", () => {
    const html = renderPage(OPEN_CAMPAIGN_UNPUBLISHED, {
      actionData: { ok: true, formError: null, problems: [], tierResyncResult: { tierNumber: 1, skipped: false, syncedVariantCount: 1, unresolvedVariantCount: 0 } },
    });
    expect(textOf(html)).toMatch(/Published tier 1 to 1 variant\(s\)/);
  });

  it("a resync failure (GroupBuyTierPriceSyncError) is shown without leaking raw Shopify processor/API error text", () => {
    const message =
      "Resync could not publish tier 1 to Shopify for 1 variant(s). The frozen campaign pricing in our system is unaffected. Try again, or wait — the next order for this campaign retries the same publish automatically.";
    const html = renderPage(OPEN_CAMPAIGN_UNPUBLISHED, { actionData: { ok: false, formError: message, problems: [] } });
    const text = textOf(html);
    expect(text).toContain(message);
    // No raw Admin API error text or Shopify processor reference — only the
    // count and tier number, exactly what the route's error handling emits.
    expect(text).not.toMatch(/GraphQL|gid:\/\/shopify|AdminApiError/i);
  });
});

describe("a closed campaign", () => {
  it("shows the final tier and final qualifying units, and offers no mutation controls", () => {
    const html = renderPage(CLOSED_CAMPAIGN);
    expect(textOf(html)).toMatch(/Final tier: 2/);
    expect(textOf(html)).toMatch(/Final qualifying units: 14/);
    expect(html).not.toMatch(/Open campaign and freeze pricing/);
  });

  it("does not render the unresolved-lines section at all when there is nothing unresolved", () => {
    const html = renderPage(CLOSED_CAMPAIGN);
    expect(html).not.toMatch(/could not be priced automatically/);
  });

  it("surfaces an unresolved line with a form to record its paid price, never a refund-amount field", () => {
    const html = renderPage(CLOSED_CAMPAIGN, {
      unresolvedRefundLines: [
        {
          masterVariantId: VARIANT_ID,
          orderRef: "gid://shopify/Order/1",
          lineRef: "gid://shopify/LineItem/1",
          qualifyingUnits: 3,
          reason: "card-basis line; no order-lookup port was supplied",
        },
      ],
    });
    const text = textOf(html);
    expect(text).toMatch(/1 line\(s\) could not be priced automatically/);
    expect(html).toMatch(/name="intent" value="record_unresolved_refund_line"/);
    expect(html).toMatch(/name="paymentBasis"/);
    expect(html).toMatch(/name="paidAmount"/);
    expect(html).not.toMatch(/name="refundAmount"/);
  });
});

describe("campaign-options display — pinned-at-open vs. live draft revision", () => {
  it("a draft campaign's upload shows its revision number with no 'pinned at open' claim", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      optionsUpload: {
        sequence: 2,
        uploadedBy: "staff:1",
        uploadedAt: "2026-09-24T10:00:00.000Z",
        contentHash: "abc123",
        rawJson: "{}",
        pinnedAtOpen: false,
      },
    });
    expect(textOf(html)).toMatch(/Revision #2/);
    expect(textOf(html)).not.toMatch(/Pinned at campaign open/);
  });

  it("an open campaign's upload states plainly it is the configuration pinned at open, not a live re-read", () => {
    const html = renderPage(OPEN_CAMPAIGN, {
      optionsUpload: {
        sequence: 1,
        uploadedBy: "staff:1",
        uploadedAt: "2026-09-20T10:00:00.000Z",
        contentHash: "abc123",
        rawJson: "{}",
        pinnedAtOpen: true,
      },
    });
    expect(textOf(html)).toMatch(/Revision #1/);
    expect(textOf(html)).toMatch(/Pinned at campaign open/);
  });
});

describe("campaign-options upload rejection", () => {
  it("surfaces the REAL validator's rejection verbatim, including the offending key and its exact path", () => {
    // The real validator, not a hand-typed guess — if its message format ever
    // changes, this test changes with it rather than silently going stale.
    const result = validateGroupBuyCampaignOptions({
      schemaVersion: 1,
      campaign: { productType: "ring" },
      optionDimensions: [
        { key: "metal", label: "Metal", required: true, displayOrder: 1, allowedValues: [{ value: "gold", label: "Gold", margin: "0.30" }] },
      ],
      validCombinations: [{ values: { metal: "gold" } }],
      tableView: { columns: ["metal"] },
      orderingFlow: { steps: ["metal"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.problems.some((p) => p.includes("margin"))).toBe(true);

    const html = renderPage(DRAFT_CAMPAIGN, {
      actionData: { ok: false, formError: "The campaign-options upload was rejected.", problems: result.problems },
    });
    for (const problem of result.problems) {
      expect(textOf(html)).toContain(problem);
    }
    // The offending key's exact path is part of what got asserted above —
    // pinned again explicitly so this test fails loudly if that path ever
    // stops appearing.
    expect(textOf(html)).toMatch(/optionDimensions\[0\]\.allowedValues\[0\]\.margin/);
  });

  it("a not-valid-JSON upload is refused with a plain parse error, not a generic message", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      actionData: { ok: false, formError: 'That upload is not valid JSON: Unexpected token h in JSON at position 1', problems: [] },
    });
    expect(textOf(html)).toMatch(/not valid JSON/);
  });
});

describe("open-campaign safety failures", () => {
  it("an unsafe (overridable) tier failure names the failing floor(s) and offers a required-reason override", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      actionData: {
        ok: false,
        formError: "One or more tiers fail a configured pricing floor.",
        problems: [],
        openBlocked: {
          kind: "unsafe",
          entries: [{ masterVariantId: VARIANT_ID, tierNumber: 2, failing: ["min_gross_margin", "min_dollar_profit"] }],
        },
      },
    });
    const text = textOf(html);
    expect(text).toMatch(/Solitaire Band — gold k14 \(Size 7\)/);
    expect(text).toMatch(/tier 2/);
    expect(text).toMatch(/minimum gross margin/);
    expect(text).toMatch(/minimum dollar profit/);
    expect(html).toMatch(/name="overrideConfirmed"/);
    expect(html).toMatch(/name="overrideReason"[^>]*required/);
    // The checkbox and reason field are REQUIRED, not merely present.
    expect(html).toMatch(/type="checkbox" name="overrideConfirmed" required/);
  });

  it("never renders the actual margin rate or dollar contribution behind an unsafe failure — only the named floor", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      actionData: {
        ok: false,
        formError: "One or more tiers fail a configured pricing floor.",
        problems: [],
        openBlocked: { kind: "unsafe", entries: [{ masterVariantId: VARIANT_ID, tierNumber: 2, failing: ["min_gross_margin"] }] },
      },
    });
    expect(html).not.toMatch(NO_COST_MARGIN_LEAK);
    // Only the human label for the failing floor appears — never the raw
    // FloorId code the domain layer uses internally.
    expect(textOf(html)).not.toMatch(/min_gross_margin|min_dollar_profit|variant_floor/);
    // No percentage or dollar figure is attached to the margin floor name —
    // only the fact that it failed. Checked on the tag-stripped text (`textOf`)
    // so this cannot false-positive on an unrelated CSS `margin:` style
    // property, which is exactly what tripped this assertion the first time.
    expect(textOf(html)).not.toMatch(/margin.{0,40}[\d$%]/i);
  });

  it("a price-ladder failure states plainly it cannot be overridden and offers NO override control at all", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      actionData: {
        ok: false,
        formError: "The price ladder does not only fall for one or more variants. This cannot be overridden.",
        problems: [],
        openBlocked: {
          kind: "ladder",
          problems: [
            {
              masterVariantId: VARIANT_ID,
              priorTierNumber: 1,
              tierNumber: 2,
              detail:
                "variant 22222222-2222-2222-2222-222222222222, tier 1 -> tier 2: Bank Payment USD 100.00 -> USD 105.00, Regular/Card USD 110.00 -> USD 115.00 — the Bank Payment Price does not fall",
            },
          ],
        },
      },
    });
    const text = textOf(html);
    expect(text).toMatch(/NOT overridable/i);
    expect(text).toMatch(/Solitaire Band — gold k14 \(Size 7\)/);
    // No override path is offered for a ladder failure — not present, not disabled.
    expect(html).not.toMatch(/name="overrideConfirmed"/);
    expect(html).not.toMatch(/name="overrideReason"/);
    expect(html).not.toMatch(/I am authorized to open this/);
  });
});

/**
 * The archive / delete panel.
 *
 * THE FAILURE THIS GUARDS AGAINST IS A HUMAN ONE: staff reaching for
 * "archive" meaning "make this go away", and the screen not telling them what
 * actually happens. So most of these assert the page's WORDS, not its
 * plumbing — specifically that it says evidence survives, and that archiving
 * does not take a closed campaign off the customer-facing Past Group Buys
 * history (campaignVisibility.ts, owner-locked 2026-10-05).
 */
describe("archive and deletion panel", () => {
  const ARCHIVED: CampaignFixture = {
    ...CLOSED_CAMPAIGN,
    archivedAt: "2026-10-06T09:30:00.000Z",
    archivedBy: "staff:ada",
    archiveReason: "superseded by the spring campaign",
    history: { describedParts: ["14 qualifying unit event(s)", "2 refund(s)"], hasHistory: true },
  };

  it("offers archiving with a REQUIRED reason", () => {
    const html = renderPage(DRAFT_CAMPAIGN);
    expect(html).toMatch(/name="intent" value="archive_campaign"/);
    expect(html).toMatch(/name="archiveReason"[^>]*required/);
  });

  it("says plainly that archiving deletes nothing", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN));
    expect(text).toMatch(/does not delete anything/i);
    expect(text).toMatch(/does not change the campaign status/i);
  });

  it("warns that archiving does NOT remove a closed campaign from public Past Group Buys", () => {
    // The one consequence a staff member would otherwise get wrong and never
    // find out about.
    const text = textOf(renderPage(DRAFT_CAMPAIGN));
    expect(text).toMatch(/does not remove a closed campaign from the customer-facing Past Group Buys/i);
  });

  it("shows who archived it, when, and why — and that the evidence is intact", () => {
    const text = textOf(renderPage(ARCHIVED));
    expect(text).toMatch(/staff:ada/);
    expect(text).toMatch(/superseded by the spring campaign/);
    expect(text).toMatch(/unchanged and still queryable/i);
  });

  it("offers restore for an archived campaign, and does not re-offer archiving", () => {
    const html = renderPage(ARCHIVED);
    expect(html).toMatch(/name="intent" value="unarchive_campaign"/);
    expect(html).not.toMatch(/name="intent" value="archive_campaign"/);
  });

  it("offers deletion for an empty draft, behind typing the campaign code", () => {
    const html = renderPage(DRAFT_CAMPAIGN);
    expect(html).toMatch(/name="intent" value="delete_campaign"/);
    expect(html).toMatch(/name="confirmCode"/);
    // The expected code travels with the form so the server compares against
    // the campaign being viewed, not against whatever was typed.
    expect(html).toMatch(/name="expectedCode" value="gb-summer-rings"/);
  });

  it("does NOT offer deletion for a campaign carrying history, and NAMES the history", () => {
    const html = renderPage(ARCHIVED);
    expect(html).not.toMatch(/name="intent" value="delete_campaign"/);
    const text = textOf(html);
    expect(text).toMatch(/Deletion is not available/i);
    expect(text).toMatch(/14 qualifying unit event\(s\), 2 refund\(s\)/);
    // BOTH REASONS, because this campaign fails on both. Saying only "it is
    // closed" would imply a status change is all that stands in the way.
    expect(text).toMatch(/It is "closed"/);
    expect(text).toMatch(/Archive the campaign instead/i);
  });

  it("names history for a DRAFT that acquired some — the draft-only delete path is not a free pass", () => {
    const text = textOf(
      renderPage({
        ...DRAFT_CAMPAIGN,
        history: { describedParts: ["1 acknowledgment(s)"], hasHistory: true },
      })
    );
    expect(text).toMatch(/1 acknowledgment\(s\)/);
    // And NOT the status sentence — this one really is still a draft.
    expect(text).not.toMatch(/It is "draft"/);
  });

  it("does NOT offer deletion for an open campaign even with no history, and says why", () => {
    // The tempting case: opened, nobody bought, "nothing happened". It was
    // still offered to customers at a frozen price.
    const html = renderPage({ ...OPEN_CAMPAIGN, history: { describedParts: [], hasHistory: false } });
    expect(html).not.toMatch(/name="intent" value="delete_campaign"/);
    expect(textOf(html)).toMatch(/offered to customers at a frozen price/i);
  });

  it("never leaks cost or margin data through the new panel", () => {
    expect(renderPage(ARCHIVED).toLowerCase()).not.toMatch(NO_COST_MARGIN_LEAK);
  });
});

// ---------------------------------------------------------------------------
// THE VISUAL CAMPAIGN BUILDER (§1 to §14, §17, §18)
//
// The builder's own logic is tested directly in
// `app/domain/groupbuy/campaignBuilder.test.ts`. What is asserted HERE is
// what a merchant actually sees: that the sections render, that nothing
// internal leaks into them, and that a campaign which is no longer a draft
// cannot be edited through this page.
// ---------------------------------------------------------------------------

/** A small, complete configuration: two priced options and one preference. */
function configuredState(): CampaignBuilderState {
  return {
    ...emptyCampaignBuilderState(),
    productType: "Engagement ring",
    options: [
      {
        key: "metal",
        label: "Metal",
        required: true,
        displayOrder: 1,
        role: "variant_defining",
        allowedValues: [
          { value: "platinum", label: "Platinum" },
          { value: "14k_white", label: "14k white gold" },
        ],
      },
      {
        key: "ring_size",
        label: "Ring size",
        required: true,
        displayOrder: 2,
        role: "variant_defining_band",
        allowedValues: [
          { value: "6.5", label: "Size 6.5", bandValue: "band_6_5_8" },
          { value: "7", label: "Size 7", bandValue: "band_6_5_8" },
        ],
      },
      {
        key: "engraving_style",
        label: "Engraving style",
        required: false,
        displayOrder: 3,
        role: "customer_preference",
        allowedValues: [{ value: "none", label: "No engraving" }],
      },
    ],
    variantMappings: {},
  };
}

const MAPPABLE = [
  { masterVariantId: "aaaaaaaa-0000-0000-0000-000000000001", label: "Solitaire / platinum / PT950 / size 6.5-8" },
  { masterVariantId: "aaaaaaaa-0000-0000-0000-000000000002", label: "Solitaire / white gold / 14k / size 6.5-8" },
];

describe("the campaign builder on a draft campaign", () => {
  it("renders every configuration section the merchant needs", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Campaign basics/);
    expect(text).toMatch(/Content and images/);
    expect(text).toMatch(/Customer options/);
    expect(text).toMatch(/Available configurations/);
    expect(text).toMatch(/Mapped product variants/);
    expect(text).toMatch(/Price preview/);
    expect(text).toMatch(/Advanced configuration/);
    expect(text).toMatch(/Review/);
  });

  it("posts the whole configuration as one field, under its own intent", () => {
    const html = renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/name="intent" value="save_builder"/);
    expect(html).toMatch(/name="builderState"/);
    expect(html).toMatch(/Save configuration/);
  });

  it("describes options in the merchant's words, never in internal role names", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Affects price/);
    expect(text).toMatch(/Does not affect price/);
    expect(text).not.toMatch(/variant_defining/);
    expect(text).not.toMatch(/customer_preference/);
  });

  it("counts the configurations and collapses the sizes into one priced group", () => {
    // 2 metals x 2 sizes x 1 engraving = 4 configurations, but both sizes are
    // in one band and engraving does not affect price, so there are 2 priced
    // groups to map rather than 4.
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE })
    );
    expect(text).toMatch(/4 of 4 switched on/);
    expect(text).toMatch(/2 of 2 still need a product variant/);
  });

  it("asks for a variant by its readable label and never shows an id", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      builderState: configuredState(),
      mappableVariants: MAPPABLE,
    });
    expect(textOf(html)).toMatch(/Solitaire \/ platinum \/ PT950 \/ size 6\.5-8/);
    // The id is the option's value — necessary for the form — but it must
    // never be rendered as something the merchant reads.
    expect(textOf(html)).not.toMatch(/aaaaaaaa-0000/);
    expect(textOf(html)).not.toMatch(/gid:\/\//);
    // §6: no variant is pre-selected, so a mapping is never silently guessed.
    expect(html).toMatch(/Choose a variant/);
  });

  it("blocks the open and says what is missing, rather than letting it fail later", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/to fix before this campaign can open/);
    expect(text).toMatch(/Choose the product variant for Metal:/);
  });

  it("separates a display detail from a customer option", () => {
    // §14. A merchant who adds "Production time" as an option would create
    // purchasable combinations differing only by a label.
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Display details/);
    expect(text).toMatch(/Customers read these; they do not choose them/);
  });

  it("offers Shopify's native file picker rather than a URL field or its own uploader", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    // The buttons the owner specified.
    expect(text).toMatch(/Choose Hero Image/);
    expect(text).toMatch(/Choose Mobile Image/);
    expect(text).toMatch(/Choose Card Image/);
    expect(text).toMatch(/Add Gallery Images/);
    // No pasted CDN URL in the normal workflow, and no upload affordance of
    // our own (the app requests read_files, not write_files).
    expect(text).not.toMatch(/cdn\.shopify\.com\/s\/files/);
    expect(text).not.toMatch(/copy the file link/i);
    // Scoped to IMAGE uploading. A bare /upload/ check would catch the
    // advanced campaign-options JSON upload further down the page, which is
    // a legitimate and unrelated feature.
    expect(text).not.toMatch(/upload (?:an? )?(?:image|photo|file)/i);
    expect(text).not.toMatch(/drop (?:an? )?(?:image|file)/i);
  });

  it("renders no URL input for campaign imagery", () => {
    const html = renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() });
    // The old workflow had a text input per image holding a CDN address.
    // Its absence is the point: a merchant cannot hand-type an image source.
    expect(html).not.toMatch(/placeholder="https:\/\/cdn\.shopify\.com/);
  });

  it("offers the generated configuration read-only, and keeps the manual import separate (§12)", () => {
    const html = renderPage(DRAFT_CAMPAIGN, {
      builderState: configuredState(),
      generatedOptionsJson: '{\n  "schemaVersion": 1\n}',
    });
    expect(textOf(html)).toMatch(/Show generated configuration/);
    // Asserts the PROMISE (read-only, derived from the sections above),
    // not the punctuation — the explanatory copy was expanded for owner
    // readability and should be editable without breaking this.
    expect(textOf(html)).toMatch(/Read-only/);
    expect(textOf(html)).toMatch(/edit the sections above/);
    // The raw-JSON path survives as the advanced import, rather than being
    // replaced by the builder.
    expect(textOf(html)).toMatch(/Campaign-options upload \(advanced\)/);
    expect(html).toMatch(/name="intent" value="upload_options"/);
  });

  it("explains why no configuration file exists yet, rather than showing a broken one", () => {
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), generatedOptionsJson: null })
    );
    expect(text).toMatch(/not complete enough to generate a file yet/);
  });

  it("leaks no cost, margin or landed-cost data through any builder section", () => {
    expect(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE })
    ).not.toMatch(NO_COST_MARGIN_LEAK);
  });
});

describe("the campaign builder's price preview", () => {
  const PREVIEW = {
    currency: "USD",
    pricedAsOf: "2026-10-01T12:00:00.000Z",
    tiers: [
      { tierNumber: 1, label: "Tier 1 (from 1 unit)" },
      { tierNumber: 2, label: "Tier 2 (from 10 units)" },
    ],
    rows: [
      {
        variantGroupSignature: "group-platinum",
        description: "Metal: Platinum / Ring size: band_6_5_8",
        configurationCount: 2,
        tierPrices: [
          { tierNumber: 1, bankPaymentMinorUnits: "250000", regularCardMinorUnits: "261000" },
          { tierNumber: 2, bankPaymentMinorUnits: "225000", regularCardMinorUnits: "235000" },
        ],
      },
      {
        variantGroupSignature: "group-white-gold",
        description: "Metal: 14k white gold / Ring size: band_6_5_8",
        configurationCount: 2,
        problem: "Not priced yet: choose a product variant for this configuration first.",
      },
    ],
    problems: [],
  };

  it("shows both customer-facing prices per tier, formatted from minor units", () => {
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), pricePreview: PREVIEW })
    );
    expect(text).toMatch(/\$2,500\.00/);
    expect(text).toMatch(/\$2,610\.00 card/);
    expect(text).toMatch(/\$2,250\.00/);
    expect(text).toMatch(/\$2,350\.00 card/);
  });

  it("says plainly that the figures are provisional until open", () => {
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), pricePreview: PREVIEW })
    );
    expect(text).toMatch(/provisional until the campaign opens/i);
  });

  it("shows a row that could not be priced instead of dropping it", () => {
    // A merchant who cannot see that a variant failed to price would open the
    // campaign believing it was fine.
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), pricePreview: PREVIEW })
    );
    expect(text).toMatch(/Metal: 14k white gold/);
    expect(text).toMatch(/Not priced yet: choose a product variant/);
  });

  it("never shows an internal percentage or the words card fee or surcharge", () => {
    // CLAUDE.md rule 13 forbids this wording on customer surfaces; the admin
    // preview quotes the same two figures and has no reason to explain them
    // with a rate either.
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), pricePreview: PREVIEW })
    );
    expect(text).not.toMatch(/card fee|surcharge|cash discount/i);
    // Deliberately NOT a blanket "no percent sign anywhere" assertion. The
    // tier table elsewhere on this page legitimately shows each tier's
    // percent off, which is a Group Buy discount, not the card uplift rate
    // rule 13 forbids exposing. The wording is the real requirement, and
    // "uplift" is the term that would leak the internal rule.
    expect(text).not.toMatch(/uplift/i);
  });
});

describe("the campaign builder once a campaign is no longer draft (§17)", () => {
  it("says the configuration is locked and offers no save", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    expect(textOf(html)).toMatch(/Configuration is locked/);
    expect(html).not.toMatch(/Save configuration/);
    expect(html).not.toMatch(/name="intent" value="save_builder"/);
  });

  it("disables every control rather than leaving editable fields that would be refused", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    // The product type input is representative: if it is disabled, the
    // `disabled` flag reached the controls.
    expect(html).toMatch(/id="builder-product-type"[^>]*disabled/);
    expect(html).not.toMatch(/Add an option/);
  });

  it("still shows the configuration, so staff can see what was opened", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    // The product type sits in a read-only input, so it is an attribute
    // rather than page text — which is why this asserts on the markup.
    expect(html).toMatch(/id="builder-product-type"[^>]*value="Engagement ring"/);
    expect(textOf(html)).toMatch(/Mapped product variants/);
    expect(textOf(html)).toMatch(/Metal/);
  });

  it("runs no price preview, because the real prices are frozen", () => {
    const text = textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Save the configuration to see a price preview/);
  });
});

// ---------------------------------------------------------------------------
// FROZEN COMMERCE CONFIGURATION vs CORRECTABLE PRESENTATION
// (owner decision, 2026-11-06)
//
// A campaign that has opened has customers in it. Everything they relied on
// is frozen; the photography, headline and short description stay
// correctable through their own versioned, reasoned path.
// ---------------------------------------------------------------------------

describe("an open campaign's frozen commerce configuration", () => {
  it("offers no way to change options, bands, mappings or combinations", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE });
    // No commerce save intent at all.
    expect(html).not.toMatch(/name="intent" value="save_builder"/);
    // And no commerce mutation controls, absent rather than disabled.
    expect(html).not.toMatch(/Add an option/);
    expect(html).not.toMatch(/Remove this option/);
    expect(html).not.toMatch(/Add a choice/);
    expect(html).not.toMatch(/Switch all off/);
  });

  it("disables the variant mapping and option controls", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE });
    expect(html).toMatch(/id="builder-product-type"[^>]*disabled/);
    expect(html).toMatch(/id="option-label-0"[^>]*disabled/);
    expect(html).toMatch(/id="option-role-0"[^>]*disabled/);
  });

  it("keeps the frozen CLAIMS uneditable: highlights and display details", () => {
    // Display details are "Certification: GIA" and "Clarity: VS1"; a
    // highlight can carry the same claim in prose. Both are material and
    // certification claims, which the owner's frozen list names.
    const html = renderPage(OPEN_CAMPAIGN, { builderState: withClaims() });
    // React emits attributes in JSX order, and `disabled` is declared
    // before `aria-label` on these inputs, so the assertion reads in that
    // direction rather than assuming alphabetical output.
    expect(html).toMatch(/disabled=""[^>]*aria-label="Highlight 1"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Display detail 1 label"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Display detail 1 value"/);
    expect(html).not.toMatch(/Add a highlight/);
    expect(html).not.toMatch(/Add a display detail/);
  });

  it("says the commerce configuration is locked", () => {
    const text = textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Configuration is locked/);
  });
});

describe("an open campaign's correctable presentation", () => {
  it("offers its own intent, separate from the commerce save", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/name="intent" value="save_presentation"/);
    expect(html).not.toMatch(/name="intent" value="save_builder"/);
  });

  it("still lets the merchant choose imagery and edit the headline", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    expect(textOf(html)).toMatch(/Choose Hero Image/);
    expect(textOf(html)).toMatch(/Add Gallery Images/);
    // The headline input is NOT disabled, unlike the commerce fields above.
    expect(html).toMatch(/id="content-headline"/);
    expect(html).not.toMatch(/id="content-headline"[^>]*disabled/);
    expect(html).not.toMatch(/id="content-short-description"[^>]*disabled/);
  });

  it("REQUIRES a reason, with a minimum length", () => {
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/id="presentationReason"[^>]*required/);
    expect(html).toMatch(/name="reason"/);
    expect(html).toMatch(new RegExp(`minLength="${MIN_PRESENTATION_REASON_LENGTH}"`));
    expect(textOf(html)).toMatch(/Reason for this change/);
  });

  it("asks for no staff name, because identity comes from the signed-in session", () => {
    // D23. A browser-supplied actor would make the audit record worthless.
    const html = renderPage(OPEN_CAMPAIGN, { builderState: configuredState() });
    expect(html).not.toMatch(/name="actor"/);
    expect(html).not.toMatch(/name="changedBy"/);
    expect(html).not.toMatch(/name="staff/);
  });

  it("explains what can and cannot change, so nobody expects more", () => {
    const text = textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/only its images, headline and short description can change/);
    expect(text).toMatch(/Nothing is overwritten/);
    expect(text).toMatch(/options, variants, tiers and product claims stay exactly as they were/);
  });

  it("is offered on a draft campaign through the ordinary save, not a second form", () => {
    // While draft there is nothing to version: the builder save covers it.
    const html = renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/name="intent" value="save_builder"/);
    expect(html).not.toMatch(/name="intent" value="save_presentation"/);
  });

  /**
   * SUPERSEDES an earlier case asserting presentation editing was withdrawn
   * once a campaign closed. The owner changed that on 2026-11-07, and the
   * reason is sound: a closed campaign is still READ, in the public Past
   * Group Buys archive, so a typo in its headline stays customer-facing. The
   * old assertion was removed rather than loosened, because it asserted the
   * opposite of the current policy and keeping both would be incoherent.
   */
  it("is STILL offered once the campaign closes, because closed campaigns are still read", () => {
    const html = renderPage(CLOSED_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/name="intent" value="save_presentation"/);
    expect(textOf(html)).toMatch(/Choose Hero Image/);
    expect(html).toMatch(/id="presentationReason"[^>]*required/);
    // But the commerce configuration is as frozen as it was when open.
    expect(html).not.toMatch(/name="intent" value="save_builder"/);
    expect(html).not.toMatch(/Add an option/);
  });

  it("explains a closed campaign's situation in its own words, not an open campaign's", () => {
    const closed = textOf(renderPage(CLOSED_CAMPAIGN, { builderState: configuredState() }));
    expect(closed).toMatch(/has closed but is still shown in Past Group Buys/);
    expect(closed).not.toMatch(/This campaign is live/);

    const open = textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }));
    expect(open).toMatch(/This campaign is live/);
    expect(open).not.toMatch(/has closed but is still shown/);
  });
});

describe("a closed campaign's frozen commerce data stays frozen", () => {
  it("still refuses every commerce control", () => {
    const html = renderPage(CLOSED_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE });
    for (const control of [
      /Add an option/,
      /Remove this option/,
      /Add a choice/,
      /Switch all off/,
      /name="intent" value="save_builder"/,
      /name="intent" value="replace_tiers"/,
      /name="intent" value="add_variant"/,
      /name="intent" value="upload_options"/,
    ]) {
      expect(html, String(control)).not.toMatch(control);
    }
  });

  it("still refuses the frozen CLAIM fields", () => {
    // The historical campaign must truthfully represent what was sold, so a
    // certification or quality claim cannot be edited after the fact.
    const html = renderPage(CLOSED_CAMPAIGN, { builderState: withClaims() });
    expect(html).toMatch(/disabled=""[^>]*aria-label="Highlight 1"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Display detail 1 label"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Display detail 1 value"/);
    expect(html).not.toMatch(/Add a highlight/);
    expect(html).not.toMatch(/Add a display detail/);
  });

  it("still disables the option and mapping inputs", () => {
    const html = renderPage(CLOSED_CAMPAIGN, { builderState: configuredState(), mappableVariants: MAPPABLE });
    expect(html).toMatch(/id="builder-product-type"[^>]*disabled/);
    expect(html).toMatch(/id="option-role-0"[^>]*disabled/);
  });

  it("leaks no cost or margin data on a closed campaign either", () => {
    expect(
      renderPage(CLOSED_CAMPAIGN, { builderState: withClaims(), mappableVariants: MAPPABLE })
    ).not.toMatch(NO_COST_MARGIN_LEAK);
  });
});

describe("the three lifecycle states, side by side", () => {
  // One table, so the whole policy is readable in one place and a future
  // change has to come here and state its intent.
  const CASES = [
    { name: "draft", campaign: DRAFT_CAMPAIGN, commerceEditable: true, presentationEditable: true },
    { name: "open", campaign: OPEN_CAMPAIGN, commerceEditable: false, presentationEditable: true },
    { name: "closed", campaign: CLOSED_CAMPAIGN, commerceEditable: false, presentationEditable: true },
  ] as const;

  it.each(CASES)(
    "$name: commerce editable = $commerceEditable, presentation editable = $presentationEditable",
    ({ campaign, commerceEditable, presentationEditable }) => {
      const html = renderPage(campaign, { builderState: configuredState() });

      // Commerce: the draft-only save intent is the single tell.
      if (commerceEditable) {
        expect(html).toMatch(/name="intent" value="save_builder"/);
      } else {
        expect(html).not.toMatch(/name="intent" value="save_builder"/);
      }

      // Presentation: on a draft it rides the builder save; otherwise it has
      // its own reasoned, versioned intent.
      if (presentationEditable && !commerceEditable) {
        expect(html).toMatch(/name="intent" value="save_presentation"/);
      }
      if (presentationEditable) {
        expect(textOf(html)).toMatch(/Choose Hero Image/);
      }
    }
  );
});

describe("the presentation change history", () => {
  const VERSIONS = [
    {
      version: 2,
      priorVersion: 1,
      changedBy: "gid://shopify/StaffMember/77",
      changedAt: "2026-11-02T09:30:00.000Z",
      reason: "Replaced hero with final campaign photography",
    },
    {
      version: 1,
      priorVersion: null,
      changedBy: "gid://shopify/StaffMember/42",
      changedAt: "2026-11-01T12:00:00.000Z",
      reason: "Corrected headline typo",
    },
  ];

  it("shows every version with its prior version, actor, time and reason", () => {
    const text = textOf(
      renderPage(OPEN_CAMPAIGN, { builderState: configuredState(), presentationVersions: VERSIONS })
    );
    expect(text).toMatch(/Presentation change history/);
    expect(text).toMatch(/Replaced hero with final campaign photography/);
    expect(text).toMatch(/Corrected headline typo/);
    expect(text).toMatch(/Version 1/); // version 2's prior
    expect(text).toMatch(/First version/); // version 1 has no prior
    expect(text).toMatch(/StaffMember\/77/);
    expect(text).toMatch(/StaffMember\/42/);
  });

  it("states that nothing is ever removed", () => {
    const text = textOf(
      renderPage(OPEN_CAMPAIGN, { builderState: configuredState(), presentationVersions: VERSIONS })
    );
    expect(text).toMatch(/Every version is kept/);
    expect(text).toMatch(/Nothing here is ever removed/);
  });

  it("keeps the earlier version visible after a later one exists", () => {
    // The whole point of append-only: version 1 does not disappear when
    // version 2 is written.
    const text = textOf(
      renderPage(OPEN_CAMPAIGN, { builderState: configuredState(), presentationVersions: VERSIONS })
    );
    const first = text.indexOf("Replaced hero with final campaign photography");
    const second = text.indexOf("Corrected headline typo");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    // Newest first.
    expect(first).toBeLessThan(second);
  });

  it("renders no history section when there is nothing to show", () => {
    const text = textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }));
    expect(text).not.toMatch(/Presentation change history/);
  });
});

describe("saved-state price preview and the Open Campaign gate", () => {
  it("offers Open Campaign on a clean draft", () => {
    // The gate below must not block the normal case.
    const html = renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() });
    expect(html).toMatch(/Open campaign and freeze pricing/);
    expect(html).not.toMatch(/Save your configuration changes first/);
  });

  it("explains that the preview comes from the saved configuration", () => {
    const PREVIEW = {
      currency: "USD",
      pricedAsOf: "2026-11-01T12:00:00.000Z",
      tiers: [{ tierNumber: 1, label: "Tier 1 (from 1 unit)" }],
      rows: [
        {
          variantGroupSignature: "g1",
          description: "Metal: Platinum",
          configurationCount: 2,
          tierPrices: [{ tierNumber: 1, bankPaymentMinorUnits: "250000", regularCardMinorUnits: "261000" }],
        },
      ],
      problems: [],
    };
    const text = textOf(
      renderPage(DRAFT_CAMPAIGN, { builderState: configuredState(), pricePreview: PREVIEW })
    );
    expect(text).toMatch(/provisional until the campaign opens/i);
  });

  it("names the save action so it is obvious it refreshes the preview", () => {
    // The unsaved-changes banner and the renamed button are client state, so
    // what is asserted here is that the strings ship in the bundle for the
    // browser to show once an edit happens.
    const panel = readFileSync(
      join(process.cwd(), "app", "components", "groupbuy", "CampaignBuilderPanel.tsx"),
      "utf8"
    );
    expect(panel).toContain("Price preview is based on the last saved configuration.");

    const route = readFileSync(
      join(process.cwd(), "app", "routes", "app.group-buy-campaigns.$id.tsx"),
      "utf8"
    );
    expect(route).toContain("Save Changes & Refresh Price Preview");
    // And the Open control is gated on the same unsaved flag.
    expect(route).toMatch(/disabled=\{busy \|\| builderEdited\}/);
    expect(route).toContain("Save your configuration changes first");
  });

  it("does not compute prices in the browser", () => {
    // The architectural rule the owner asked to keep: the preview comes from
    // the real server-side pipeline, and the panel only formats it.
    const panel = readFileSync(
      join(process.cwd(), "app", "components", "groupbuy", "CampaignBuilderPanel.tsx"),
      "utf8"
    );
    expect(panel).not.toMatch(/computeBuyNowPrice/);
    expect(panel).not.toMatch(/campaignTierDualPrices/);
    expect(panel).not.toMatch(/priceMultiplier/);
    expect(panel).not.toMatch(/deriveRegularCardPrice/);
  });
});

/** The same configuration, plus the two frozen claim fields. */
function withClaims(): CampaignBuilderState {
  const base = configuredState();
  return {
    ...base,
    content: {
      ...base.content,
      highlights: ["Natural diamond, VS1 clarity"],
      displayDetails: [{ label: "Certification", value: "GIA" }],
    },
  };
}

// ---------------------------------------------------------------------------
// ADMIN EXPLANATORY TEXT
//
// The builder shipped without it, and the owner could not tell from the
// screen what several fields did. That is a defect in the page, not something
// a README fixes — so the explanations live in the UI, and these assert they
// are there and say the things that actually matter.
//
// Asserted on MEANING, not on exact sentences: the copy should be editable
// for clarity without breaking the suite. Each case picks the one fact a
// merchant would be harmed by not knowing.
// ---------------------------------------------------------------------------

describe("every major admin section explains itself", () => {
  // Each section only renders in the status where it is actionable, so the
  // fixture has to match: Open appears on a draft, Close and Settlement on an
  // open campaign, and the rest throughout.
  it.each([
    ["Tiers", "draft", /discount ladder/i],
    ["Eligible variants", "draft", /Which of your products/i],
    ["Open campaign", "draft", /one-way/i],
    ["Close campaign", "open", /final tier/i],
    ["Archive and deletion", "draft", /housekeeping only/i],
    ["Settlement", "closed", /approve and process/i],
  ])("%s (%s campaign) has explanatory text under the heading", (_section, status, pattern) => {
    const campaign =
      status === "draft" ? DRAFT_CAMPAIGN : status === "open" ? OPEN_CAMPAIGN : CLOSED_CAMPAIGN;
    expect(textOf(renderPage(campaign, { builderState: configuredState() }))).toMatch(pattern);
  });

  it("explains the page order, so the owner knows where to start", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/How this page is organised/i);
    expect(text).toMatch(/Work down the page/i);
  });

  it("says plainly that nothing is customer-visible until the campaign opens", () => {
    // The single most reassuring fact for someone configuring their first
    // campaign, and the one that stops cautious half-configuration.
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/Nothing is visible to customers until you open/i);
  });
});

describe("the dangerous steps carry warnings", () => {
  it("warns that opening freezes pricing AND publishes to Shopify", () => {
    // Opening is the only step that writes to the Shopify catalogue. A
    // merchant who does not know that cannot consent to it.
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    expect(text).toMatch(/freezes it permanently/i);
    expect(text).toMatch(/publishes the current tier price to the matching Shopify product/i);
    expect(text).toMatch(/cannot be undone|Nothing here can be undone/i);
  });

  it("warns that tiers freeze at open", () => {
    expect(textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }))).toMatch(
      /freeze permanently at open/i
    );
  });

  it("says closing moves no money by itself", () => {
    // The Close section renders on an OPEN campaign — that is when the
    // button is available and the warning is needed.
    expect(textOf(renderPage(OPEN_CAMPAIGN, { builderState: configuredState() }))).toMatch(
      /does not move any money/i
    );
  });
});

describe("fields say whether the customer sees them, and whether they freeze", () => {
  const text = () => textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));

  it("marks the internal-only fields as internal", () => {
    // Title and Description are internal; a merchant writing customer copy
    // into them would never see it on the storefront.
    expect(text()).toMatch(/Internal only/i);
  });

  it("says where each image appears", () => {
    expect(text()).toMatch(/Campaign card is the thumbnail/i);
    expect(text()).toMatch(/Mobile hero replaces it on phones/i);
  });

  it("warns that highlights and display details freeze, unlike the headline", () => {
    // This is the distinction the whole presentation/frozen split rests on,
    // and the one most likely to surprise someone.
    const t = text();
    expect(t).toMatch(/FREEZE when the campaign opens/i);
    expect(t).toMatch(/Correctable after the campaign opens/i);
  });

  it("explains what the Price setting on an option actually decides", () => {
    expect(text()).toMatch(/whether this option affects which variant is sold/i);
  });

  it("explains that mapping is required before the campaign can open", () => {
    expect(text()).toMatch(/cannot open until they all have one/i);
  });

  it("says the price preview is provisional and why", () => {
    expect(text()).toMatch(/metal costs move/i);
  });

  it("marks the size band as internal, so nobody thinks customers see it", () => {
    expect(text()).toMatch(/Internal only/i);
    // And the customer-facing promise is still stated.
    expect(text()).toMatch(/ring sizes inside one manufacturing band share a single variant/i);
  });
});

describe("the explanations use business language, not developer terms", () => {
  it("avoids internal vocabulary in the visible copy", () => {
    const text = textOf(renderPage(DRAFT_CAMPAIGN, { builderState: configuredState() }));
    for (const jargon of [
      "MasterVariant",
      "masterVariantId",
      "snapshot",
      "schemaVersion",
      "signature",
      "Prisma",
      "endpoint",
      "payload",
      "boolean",
      "null",
    ]) {
      expect(text, jargon).not.toContain(jargon);
    }
  });
});
