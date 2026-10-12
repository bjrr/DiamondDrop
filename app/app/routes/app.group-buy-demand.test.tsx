import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import GroupBuyDemandPage from "./app.group-buy-demand";

/**
 * The Group Buy demand worklist.
 *
 * Same technique as the other admin-page tests: nothing is mocked, only the
 * loader's result is supplied. The repository's own guarantees (dedup,
 * idempotent marking, the shapes) are proven for real in
 * `tests/integration/groupbuy/demandCapture.test.ts`.
 *
 * What is genuinely new here is the GATING: that an already-notified row
 * cannot be selected again, and that the page says what it does and does not
 * do — it records that staff contacted someone, it does not send email.
 */

const ROUTE_ID = "group-buy-demand";

interface SignalFixture {
  id: string;
  kind: "bring_it_back" | "new_campaign_request";
  email: string;
  campaignRef: string | null;
  note: string | null;
  notifiedAt: string | null;
  notifiedBy: string | null;
  createdAt: string;
}

const WAITING: SignalFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "bring_it_back",
  email: "ada@example.com",
  campaignRef: "gb-summer-rings",
  note: null,
  notifiedAt: null,
  notifiedBy: null,
  createdAt: "2026-10-01T10:00:00.000Z",
};

const ALREADY_TOLD: SignalFixture = {
  ...WAITING,
  id: "22222222-2222-2222-2222-222222222222",
  email: "grace@example.com",
  notifiedAt: "2026-10-05T10:00:00.000Z",
  notifiedBy: "staff:ada",
};

const WISH: SignalFixture = {
  id: "33333333-3333-3333-3333-333333333333",
  kind: "new_campaign_request",
  email: "hopper@example.com",
  campaignRef: null,
  note: "a wider band in platinum",
  notifiedAt: null,
  notifiedBy: null,
  createdAt: "2026-10-02T10:00:00.000Z",
};

function renderPage(
  signals: SignalFixture[],
  options?: {
    view?: "outstanding" | "all";
    byCampaign?: { campaignRef: string; outstanding: number }[];
    actionData?: { ok: boolean; formError: string | null; markedCount?: number };
  }
): string {
  const loaderData = {
    apiKey: "test-public-client-id",
    shop: "caratforus-dev.myshopify.com",
    view: options?.view ?? "outstanding",
    signals,
    byCampaign: options?.byCampaign ?? [],
  };
  const router = createMemoryRouter(
    [{ id: ROUTE_ID, path: "/app/group-buy-demand", Component: GroupBuyDemandPage, loader: () => loaderData }],
    {
      initialEntries: ["/app/group-buy-demand"],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(options?.actionData ? { actionData: { [ROUTE_ID]: options.actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("what the page shows", () => {
  it("lists a bring-it-back with the campaign it names", () => {
    const text = textOf(renderPage([WAITING]));
    expect(text).toMatch(/ada@example\.com/);
    expect(text).toMatch(/Bring back/i);
    expect(text).toMatch(/gb-summer-rings/);
  });

  it("lists a new-campaign request with what they asked for", () => {
    const text = textOf(renderPage([WISH]));
    expect(text).toMatch(/A new Group Buy/i);
    expect(text).toMatch(/a wider band in platinum/);
  });

  it("shows who was notified and by whom", () => {
    const text = textOf(renderPage([ALREADY_TOLD], { view: "all" }));
    expect(text).toMatch(/staff:ada/);
  });

  it("summarises outstanding counts per past campaign", () => {
    const text = textOf(renderPage([WAITING], { byCampaign: [{ campaignRef: "gb-summer-rings", outstanding: 12 }] }));
    expect(text).toMatch(/gb-summer-rings — 12 waiting/);
  });
});

describe("an already-notified person cannot be selected again", () => {
  it("renders NO checkbox for a notified row", () => {
    // The repository refuses to re-transition them anyway; the page not
    // offering it is what stops a staff member believing they did something.
    const html = renderPage([ALREADY_TOLD], { view: "all" });
    expect(html).not.toMatch(/value="22222222-2222-2222-2222-222222222222"/);
  });

  it("renders a checkbox for someone still waiting", () => {
    // Attributes asserted independently — React chooses their order, and
    // pinning it would make this test about the renderer rather than the page.
    const html = renderPage([WAITING]);
    expect(html).toMatch(/value="11111111-1111-1111-1111-111111111111"/);
    expect(html).toMatch(/name="signalId"/);
  });

  it("labels each checkbox with the address it belongs to", () => {
    // A column of unlabelled checkboxes is unusable with a screen reader, and
    // this is a list where picking the wrong row emails the wrong person.
    expect(renderPage([WAITING])).toMatch(/aria-label="Mark ada@example\.com as notified"/);
  });
});

describe("the page is honest about what the button does", () => {
  it("says it records contact rather than sending email", () => {
    const text = textOf(renderPage([WAITING]));
    expect(text).toMatch(/does not send email/i);
  });

  it("says when nobody moved, rather than reporting the request as the result", () => {
    const text = textOf(renderPage([WAITING], { actionData: { ok: true, formError: null, markedCount: 0 } }));
    expect(text).toMatch(/nobody was notified twice/i);
  });

  it("reports how many actually moved", () => {
    const text = textOf(renderPage([WAITING], { actionData: { ok: true, formError: null, markedCount: 3 } }));
    expect(text).toMatch(/Marked 3 as notified/);
  });

  it("surfaces a form error rather than crashing", () => {
    const text = textOf(
      renderPage([WAITING], { actionData: { ok: false, formError: "Select at least one person to mark as notified." } })
    );
    expect(text).toMatch(/Select at least one person/);
  });
});

describe("the empty states say something useful", () => {
  it("points at the All view when nobody is outstanding", () => {
    const text = textOf(renderPage([]));
    expect(text).toMatch(/Nobody is waiting/i);
    expect(text).toMatch(/Switch to All/i);
  });

  it("says nothing has been captured at all in the All view", () => {
    const text = textOf(renderPage([], { view: "all" }));
    expect(text).toMatch(/No Group Buy interest has been captured yet/i);
  });
});

describe("no voting, and nothing beyond the address", () => {
  it("presents no ranking, score or leaderboard — voting is Post-MVP", () => {
    const text = textOf(renderPage([WAITING, WISH], { byCampaign: [{ campaignRef: "gb-x", outstanding: 2 }] }));
    expect(text).not.toMatch(/vote|ballot|rank|leaderboard|score/i);
  });

  it("renders no customer, order or pricing data", () => {
    const html = renderPage([WAITING, WISH, ALREADY_TOLD], { view: "all" }).toLowerCase();
    // "margin" alone is NOT usable here: it matches the CSS margin-bottom in
    // every style attribute on the page. The money terms are named exactly.
    for (const forbidden of ["orderref", "gid://shopify/order", "landedcost", "grossmargin", "bankpaymentprice"]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
