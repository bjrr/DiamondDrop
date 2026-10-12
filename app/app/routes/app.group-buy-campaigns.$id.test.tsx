import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import GroupBuyCampaignDetailPage from "./app.group-buy-campaigns.$id";
import { GroupBuyCampaignNotDraftForConfigurationError } from "~/db/repositories/groupBuyRepository.server";
import { validateGroupBuyCampaignOptions } from "~/domain/groupbuy/campaignOptions";

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
