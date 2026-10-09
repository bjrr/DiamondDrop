import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { issueCustomJewelryDepositInvoice } from "~/jobs/customjewelry/issueDepositInvoice.server";
import { action as acceptanceAction } from "~/routes/apps.carat.custom-jewelry-deposit-acceptance";
import { action as intakeAction } from "~/routes/apps.carat.custom-jewelry-intake";
import type {
  CreateServiceDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Issuing the Design Deposit invoice, against real Postgres.
 *
 * The property under test throughout is the money-critical invariant: NO
 * INVOICE WITHOUT AN ACCEPTANCE. It is asserted twice over — once through the
 * issuing path, which refuses, and once by direct SQL, which the schema
 * refuses. The second is what makes the first a convenience rather than the
 * guarantee.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER_A = "991111";
const CUSTOMER_A_GID = `gid://shopify/Customer/${CUSTOMER_A}`;
const STAFF = "staff:tester";

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

/** Records every call so the tests can assert what Shopify was actually asked for. */
function fakeDraftOrders(): DraftOrderPort & { serviceCalls: CreateServiceDraftOrderInput[] } {
  const serviceCalls: CreateServiceDraftOrderInput[] = [];
  return {
    serviceCalls,
    async createServiceDraftOrder(input: CreateServiceDraftOrderInput): Promise<CreatedDraftOrder> {
      serviceCalls.push(input);
      return { draftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`, invoiceUrl: "https://example.test/invoice" };
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("createDraftOrder is not expected in this test");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("sendInvoice is not expected in this test — issuing must not email the customer");
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
  const email = `ada-${uniq()}@example.com`;
  const response = await call(
    intakeAction,
    signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP, logged_in_customer_id: CUSTOMER_A }, {
      firstName: "Ada",
      lastName: "Lovelace",
      email,
      phone: "+1 555 0100",
      startingPoint: "from_scratch",
      promptText: "A signet ring reworked from my grandmother's.",
      followUpPreference: "contact_me",
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
      { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
      { projectId, depositTermsAccepted: true }
    )
  );
  expect(response.status).toBe(201);
}

describe("no invoice without an acceptance", () => {
  it("REFUSES to issue for a project whose customer never accepted", async () => {
    const project = await seedProject();
    const draftOrders = fakeDraftOrders();

    const result = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders,
    });

    expect(result.outcome).toBe("not_accepted");
    // AND NOTHING WAS CREATED IN SHOPIFY. The refusal happens before any
    // external call, so there is no orphaned draft order to clean up.
    expect(draftOrders.serviceCalls).toHaveLength(0);
    expect(await prisma.customJewelryDepositInvoice.count()).toBeGreaterThanOrEqual(0);
  });

  it("the SCHEMA refuses it too — the code check is a good error, not the guarantee", async () => {
    // An invoice row whose FK points at a nonexistent acceptance cannot be
    // written at all. This is what makes the invariant hold even if the
    // issuing path were bypassed or wrong.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_deposit_invoice"
          ("id", "acceptance_id", "draft_order_gid", "amount_minor_units", "currency", "issued_by_actor_type")
        VALUES (gen_random_uuid(), gen_random_uuid(), 'gid://shopify/DraftOrder/1', 4900, 'USD', 'staff')`
    ).rejects.toThrow();
  });

  it("refuses a project that does not exist", async () => {
    const draftOrders = fakeDraftOrders();
    const result = await issueCustomJewelryDepositInvoice({
      projectId: randomUUID(),
      issuedByActorRef: STAFF,
      draftOrders,
    });
    expect(result.outcome).toBe("project_not_found");
    expect(draftOrders.serviceCalls).toHaveLength(0);
  });
});

describe("issuing, once the customer has accepted", () => {
  it("creates ONE custom line for exactly the authorized amount, attached to the authorizing customer", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);
    const draftOrders = fakeDraftOrders();

    const result = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders,
    });

    expect(result.outcome).toBe("issued");
    expect(draftOrders.serviceCalls).toHaveLength(1);
    const sent = draftOrders.serviceCalls[0]!;

    expect(sent.unitPrice.amountMinorUnits).toBe(4900n);
    expect(sent.unitPrice.currency).toBe("USD");
    // THE AUTHENTICATED CUSTOMER, explicitly. Without it Shopify invents a
    // customer from the email — the defect that attached every Group Buy Bank
    // Payment order to the wrong person.
    expect(sent.customerGid).toBe(CUSTOMER_A_GID);
    expect(sent.email).toBe(project.email);
    expect(sent.title).toContain(project.projectReference);
    expect(sent.tags).toContain("carat-design-deposit");
  });

  it("records the invoice against the ACCEPTANCE, with the staff actor", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);

    const result = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });
    expect(result.outcome).toBe("issued");

    const acceptance = await prisma.customJewelryDepositAcceptance.findUniqueOrThrow({
      where: { projectId: project.id },
      include: { invoice: true },
    });
    expect(acceptance.invoice).not.toBeNull();
    expect(acceptance.invoice!.amountMinorUnits).toBe(acceptance.amountMinorUnits);
    expect(acceptance.invoice!.currency).toBe(acceptance.currency);
    expect(acceptance.invoice!.issuedByActorType).toBe("staff");
    expect(acceptance.invoice!.issuedByActorRef).toBe(STAFF);
  });

  it("does NOT email the customer — the fake throws if `sendInvoice` is called", async () => {
    // Asked for money is a separate act from an invoice existing, and the
    // invoice email's wording is not approved. The fake makes an accidental
    // send a hard failure rather than something nobody notices.
    const project = await seedProject();
    await acceptTerms(project.id);
    const result = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });
    expect(result.outcome).toBe("issued");
  });

  it("does NOT advance the project status — issuing is not collecting", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);
    await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });

    const after = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe("submitted");
  });
});

describe("one invoice per deposit", () => {
  it("a second attempt returns the EXISTING invoice and creates nothing new", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);

    const first = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });
    expect(first.outcome).toBe("issued");

    const secondPort = fakeDraftOrders();
    const second = await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: secondPort,
    });

    expect(second.outcome).toBe("already_issued");
    // TWO LIVE PAYMENT LINKS FOR ONE $49 IS A CUSTOMER WHO CAN PAY TWICE, so
    // the second attempt must not reach Shopify at all.
    expect(secondPort.serviceCalls).toHaveLength(0);
    expect(await prisma.customJewelryDepositInvoice.count({ where: { acceptance: { projectId: project.id } } })).toBe(1);
  });

  it("the UNIQUE index refuses a second invoice even by direct SQL", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);
    await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });

    const acceptance = await prisma.customJewelryDepositAcceptance.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_deposit_invoice"
          ("id", "acceptance_id", "draft_order_gid", "amount_minor_units", "currency", "issued_by_actor_type")
        VALUES (gen_random_uuid(), ${acceptance.id}::uuid, 'gid://shopify/DraftOrder/second', 4900, 'USD', 'staff')`
    ).rejects.toThrow();
  });
});

describe("the invoice record cannot be altered once written", () => {
  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    const project = await seedProject();
    await acceptTerms(project.id);
    await issueCustomJewelryDepositInvoice({
      projectId: project.id,
      issuedByActorRef: STAFF,
      draftOrders: fakeDraftOrders(),
    });
    const acceptance = await prisma.customJewelryDepositAcceptance.findUniqueOrThrow({
      where: { projectId: project.id },
    });

    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_deposit_invoice" SET "amount_minor_units" = 1 WHERE "acceptance_id" = ${acceptance.id}::uuid`
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRaw`DELETE FROM "custom_jewelry_deposit_invoice" WHERE "acceptance_id" = ${acceptance.id}::uuid`
    ).rejects.toThrow(/append-only/i);
    // TRUNCATE is asserted the same two-part way as on the acceptance table,
    // and for the reason that table taught: Postgres refuses to truncate a
    // table referenced by a foreign key and checks that BEFORE firing BEFORE
    // TRUNCATE triggers. Nothing references this table today, so the trigger
    // is what refuses — but the day something does, a message-matching
    // assertion would break while the protection was fine, and deleting the
    // trigger would then go unnoticed. So: refused for any reason, and the
    // guard is still present.
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "custom_jewelry_deposit_invoice"`)).rejects.toThrow();

    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'custom_jewelry_deposit_invoice'
         AND NOT t.tgisinternal`;
    const names = triggers.map((t) => t.tgname);
    expect(names).toContain("custom_jewelry_deposit_invoice_no_update");
    expect(names).toContain("custom_jewelry_deposit_invoice_no_delete");
    expect(names, "the append-only TRUNCATE guard is missing").toContain(
      "custom_jewelry_deposit_invoice_no_truncate"
    );
  });
});
