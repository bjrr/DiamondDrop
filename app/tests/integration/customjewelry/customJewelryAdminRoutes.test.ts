import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { searchCustomJewelryProjectsForStaff } from "~/db/repositories/customJewelryProjectRepository.server";
import { action as acceptanceAction } from "~/routes/apps.carat.custom-jewelry-deposit-acceptance";
import { action as intakeAction } from "~/routes/apps.carat.custom-jewelry-intake";
import { issueCustomJewelryDepositInvoice } from "~/jobs/customjewelry/issueDepositInvoice.server";
import type { CreateServiceDraftOrderInput, CreatedDraftOrder, DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * The staff-facing query behind `/app/custom-jewelry`.
 *
 * Tested at the repository level rather than by rendering the route: the
 * route's loader is a thin mapping over this function plus
 * `authenticate.admin`, and the things worth protecting — which columns reach
 * a staff screen, and whether the three deposit states stay distinguishable —
 * all live here. Rendering it would mostly test Shopify's session helper.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER = "661111";

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function signedPost(path: string, query: Record<string, string>, body: unknown): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function call(fn: typeof intakeAction, request: Request) {
  return fn({ request, params: {}, context: {} } as never);
}

function fakeDraftOrders(): DraftOrderPort {
  return {
    // The fallback-benefit redemption path. Refused rather than stubbed
    // permissively: no Bank Payment, deposit or admin flow should ever create a
    // redemption draft order, so a call here is a defect worth failing on.
    // The Custom Jewelry final-purchase path. Refused rather than stubbed
    // permissively: no Bank Payment, Group Buy, redemption or deposit flow
    // should ever create a custom jewelry draft order, so a call here is a
    // defect worth failing on.
    async createCustomJewelryDraftOrder(): Promise<never> {
      throw new Error("createCustomJewelryDraftOrder is not expected in this test");
    },
    async createRedemptionDraftOrder(): Promise<never> {
      throw new Error("createRedemptionDraftOrder is not expected in this test");
    },
    async createServiceDraftOrder(_input: CreateServiceDraftOrderInput): Promise<CreatedDraftOrder> {
      return { draftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`, invoiceUrl: null };
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("createDraftOrder is not expected in this test");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("sendInvoice is not expected in this test");
    },
    async completeDraftOrder(): Promise<never> {
      throw new Error("completeDraftOrder is not expected in this test");
    },
    async cancelDraftOrder(): Promise<never> {
      throw new Error("cancelDraftOrder is not expected in this test");
    },
  };
}

async function seedProject(): Promise<{ id: string; projectReference: string; email: string }> {
  const email = `staff-list-${uniq()}@example.com`;
  const response = await call(
    intakeAction,
    signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP, logged_in_customer_id: CUSTOMER }, {
      firstName: "Grace",
      lastName: "Hopper",
      email,
      phone: "+1 555 0177",
      startingPoint: "existing_design",
      promptText: "Rework an heirloom brooch into a pendant.",
      followUpPreference: "schedule_consultation",
    })
  );
  expect(response.status).toBe(201);
  const { projectReference } = (await response.json()) as { projectReference: string };
  const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
  return { id: project.id, projectReference, email };
}

async function acceptTerms(projectId: string): Promise<void> {
  const response = await call(
    acceptanceAction,
    signedPost(
      "/apps/carat/custom-jewelry-deposit-acceptance",
      { shop: SHOP, logged_in_customer_id: CUSTOMER },
      { projectId, depositTermsAccepted: true }
    )
  );
  expect(response.status).toBe(201);
}

describe("the staff list keeps the three deposit states distinguishable", () => {
  it("reports 'not accepted', 'accepted but not invoiced', and 'invoiced' as different rows", async () => {
    // These are three different queues of work. Conflating any two would hide
    // one of them, which is the whole reason the list carries these columns.
    const notAccepted = await seedProject();
    const accepted = await seedProject();
    const invoiced = await seedProject();

    await acceptTerms(accepted.id);
    await acceptTerms(invoiced.id);
    const issued = await issueCustomJewelryDepositInvoice({
      projectId: invoiced.id,
      issuedByActorRef: "staff:tester",
      draftOrders: fakeDraftOrders(),
    });
    expect(issued.outcome).toBe("issued");

    const byReference = new Map(
      (await searchCustomJewelryProjectsForStaff({ page: 1 })).rows.map((row) => [row.projectReference, row])
    );

    const a = byReference.get(notAccepted.projectReference);
    expect(a, "the un-accepted project is missing from the open queue").toBeDefined();
    expect(a!.depositAcceptedAt).toBeNull();
    expect(a!.depositInvoiceIssuedAt).toBeNull();

    const b = byReference.get(accepted.projectReference);
    expect(b!.depositAcceptedAt).not.toBeNull();
    expect(b!.depositInvoiceIssuedAt, "an accepted deposit must not read as invoiced").toBeNull();

    const c = byReference.get(invoiced.projectReference);
    expect(c!.depositAcceptedAt).not.toBeNull();
    expect(c!.depositInvoiceIssuedAt).not.toBeNull();
  });
});

describe("the staff list exposes only what it should", () => {
  it("carries no budget figure and no prompt text", async () => {
    // Not a leak of internal pricing — there is none on these records — but a
    // budget is a figure the customer volunteered, and the prompt is long free
    // text that makes a list unreadable. Neither is needed to triage, so
    // neither is selected. Asserted on the row's own keys so adding a column
    // to the model cannot quietly put it on a staff screen.
    const project = await seedProject();
    const result = await searchCustomJewelryProjectsForStaff({ query: project.projectReference });
    expect(result.rows).toHaveLength(1);

    expect(Object.keys(result.rows[0]!).sort()).toEqual(
      [
        "createdAt",
        "customerName",
        "depositAcceptedAt",
        "depositInvoiceIssuedAt",
        "email",
        "id",
        "projectReference",
        "status",
      ].sort()
    );
  });
});

describe("search", () => {
  it("finds a project by reference and by email, case-insensitively", async () => {
    const project = await seedProject();

    const byReference = await searchCustomJewelryProjectsForStaff({
      query: project.projectReference.toLowerCase(),
    });
    expect(byReference.rows.map((r) => r.projectReference)).toContain(project.projectReference);

    const byEmail = await searchCustomJewelryProjectsForStaff({ query: project.email.toUpperCase() });
    expect(byEmail.rows.map((r) => r.projectReference)).toContain(project.projectReference);
  });

  it("returns nothing rather than everything for a query that matches nothing", async () => {
    // The failure mode worth guarding: an empty filter silently falling back
    // to "all rows" would show a staff member someone else's enquiry as if it
    // matched their search.
    const result = await searchCustomJewelryProjectsForStaff({ query: `no-such-${randomUUID()}` });
    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it("paginates with a stable page size and a total that is not the page length", async () => {
    const result = await searchCustomJewelryProjectsForStaff({ page: 1 });
    expect(result.pageSize).toBe(25);
    expect(result.rows.length).toBeLessThanOrEqual(result.pageSize);
    // totalCount must be the count of MATCHES, not of the returned page —
    // otherwise "Next" disappears exactly when it is needed.
    expect(result.totalCount).toBeGreaterThanOrEqual(result.rows.length);
  });
});
