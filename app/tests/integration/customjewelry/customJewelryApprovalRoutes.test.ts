import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { issueApprovalPackage } from "~/db/repositories/customJewelryApprovalRepository.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_SALE_TEXT,
} from "~/domain/customjewelry/finalApprovalCopy";
import { Money } from "~/domain/money/money";
import { loader as approvalPageLoader } from "~/routes/apps.carat.custom-jewelry-approval.$packageId";
import { action as approveAction } from "~/routes/apps.carat.custom-jewelry-approve";

/**
 * The customer-facing final approval surface.
 *
 * ============================================================================
 * THE TWO PROPERTIES THAT MATTER MOST
 * ============================================================================
 * Customer A cannot see or approve customer B's project, and nothing a browser
 * posts can change the design, the price or the identity being approved. Both
 * are tested through the REAL route functions against a real database and a
 * real App Proxy signature, because both have failed in this codebase before
 * at the wiring rather than in the logic.
 */

const CUSTOMER_A_ID = "1111";
const CUSTOMER_A = `gid://shopify/Customer/${CUSTOMER_A_ID}`;
const CUSTOMER_B_ID = "2222";
const STAFF = "staff:gid://shopify/StaffMember/9";
const SHOP = "caratforus-dev.myshopify.com";
const NOW = new Date("2026-11-01T12:00:00.000Z");

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

function signedQuery(customerId?: string): Record<string, string> {
  return {
    shop: SHOP,
    ...(customerId ? { logged_in_customer_id: customerId } : {}),
    path_prefix: "/apps/carat",
    timestamp: "1760000000",
  };
}

function signUrl(path: string, query: Record<string, string>): URL {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return url;
}

function getPackage(packageId: string, customerId?: string) {
  const url = signUrl(`/apps/carat/custom-jewelry-approval/${packageId}`, signedQuery(customerId));
  return approvalPageLoader({
    request: new Request(url, { method: "GET" }),
    params: { packageId },
    context: {},
  } as never) as Promise<Response>;
}

function postApprove(body: unknown, customerId?: string) {
  const url = signUrl("/apps/carat/custom-jewelry-approve", signedQuery(customerId));
  return approveAction({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

async function project(customerRef: string | null): Promise<string> {
  const row = await prisma.customJewelryProject.create({
    data: {
      projectReference: `CJ-R-${uniq()}`,
      customerRef,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-cjr-${uniq()}@example.com`,
      phone: "+15555550123",
      startingPoint: "from_scratch",
      promptText: "A solitaire with a hidden halo.",
      followUpPreference: "contact_me",
      status: "submitted",
    },
  });
  return row.id;
}

const SPEC = {
  metalType: "platinum",
  metalColor: "white",
  centerStone: { kind: "lab_diamond", shape: "oval", carat: "1.80" },
  dimensions: "Band 2.0mm",
  ringSize: "6.5",
  engraving: "ALWAYS",
  constructionNotes: "Hidden halo.",
  mediaReferences: [{ kind: "cad", ref: "r2://custom-jewelry/cad-1.stl" }],
  approvedTimelineText: "Casting begins the week of 18 November, as agreed by email.",
} as const;

async function issuedPackage(customerRef: string | null = CUSTOMER_A) {
  const projectId = await project(customerRef);
  const result = await issueApprovalPackage({
    projectId,
    spec: SPEC,
    bankPaymentPrice: usd(500_000n),
    regularCardPrice: usd(517_500n),
    issuedByActorRef: STAFF,
    now: NOW,
  });
  if (result.outcome !== "issued") throw new Error("expected an issue");
  return { projectId, packageId: result.package.id, version: result.package.version };
}

describe("viewing the package", () => {
  it("returns the frozen spec, both bases, and the material terms", async () => {
    const { packageId } = await issuedPackage();
    const response = await getPackage(packageId, CUSTOMER_A_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;

    const spec = body.specification as unknown as Record<string, unknown>;
    expect(spec.metalType).toBe("platinum");
    expect(spec.ringSize).toBe("6.5");
    expect(spec.engraving).toBe("ALWAYS");

    // BOTH BASES, NEITHER CHOSEN. The owner forbade comparing them behind the
    // scenes and silently picking one.
    const card = body.card as unknown as Record<string, string>;
    const bank = body.bankPayment as unknown as Record<string, string>;
    expect(card.price).toBe("5175.00");
    expect(bank.price).toBe("5000.00");
    expect(card.balanceDue).toBe("5175.00");
    expect(bank.balanceDue).toBe("5000.00");
    // Money as strings, never as JSON numbers.
    expect(typeof card.priceMinorUnits).toBe("string");

    // The material terms, verbatim from the pinned module.
    const terms = body.terms as unknown as Record<string, string>;
    expect(terms.finalSale).toBe(CUSTOM_JEWELRY_FINAL_SALE_TEXT);
    expect(terms.warranty).toContain("1-year limited manufacturing warranty");
    expect(terms.shipping).toContain("included in the price");

    // The acknowledgment, with the exact words and the exact button caption.
    const ack = body.acknowledgment as unknown as Record<string, unknown>;
    expect(ack.exactText).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
    expect(ack.affirmativeActionLabel).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL);
    expect(ack.mustBeUnchecked).toBe(true);
  });

  it("omits fields that do not apply rather than sending blanks", async () => {
    // A pendant has no ring size. An empty row on the page is worse than no
    // row: it reads as a specification nobody filled in.
    const projectId = await project(CUSTOMER_A);
    const result = await issueApprovalPackage({
      projectId,
      spec: { metalType: "gold", metalColor: "yellow", mediaReferences: [] },
      bankPaymentPrice: usd(100_000n),
      regularCardPrice: usd(104_000n),
      issuedByActorRef: STAFF,
      now: NOW,
    });
    if (result.outcome !== "issued") throw new Error("expected an issue");

    const body = (await (await getPackage(result.package.id, CUSTOMER_A_ID)).json()) as Record<string, never>;
    const spec = body.specification as unknown as Record<string, unknown>;
    expect(spec).not.toHaveProperty("ringSize");
    expect(spec).not.toHaveProperty("engraving");
    expect(spec).not.toHaveProperty("centerStone");
    expect(body.approvedTimeline).toBeNull();
  });

  it("NEVER returns cost, margin or supplier data", async () => {
    const { packageId } = await issuedPackage();
    const raw = await (await getPackage(packageId, CUSTOMER_A_ID)).text();
    for (const forbidden of ["landedCost", "landed_cost", "margin", "supplier", "floor", "profile"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("customer A cannot view or approve customer B's project", () => {
  it("REFUSES the page for another customer", async () => {
    const { packageId } = await issuedPackage(CUSTOMER_A);
    const response = await getPackage(packageId, CUSTOMER_B_ID);
    expect(response.status).toBe(404);
  });

  it("REFUSES the approval for another customer", async () => {
    const { packageId } = await issuedPackage(CUSTOMER_A);
    const response = await postApprove(
      { packageId, finalApprovalAccepted: true },
      CUSTOMER_B_ID
    );
    expect(response.status).toBe(404);

    // Nothing approved, and no acknowledgment written.
    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.status).toBe("issued");
    expect(pkg.approvedAt).toBeNull();
  });

  it("gives the SAME answer for a foreign package and a nonexistent one", async () => {
    // Distinguishing them would turn this into an oracle for discovering other
    // people's project ids, and an id is enough to start guessing.
    const { packageId } = await issuedPackage(CUSTOMER_A);
    const foreign = await getPackage(packageId, CUSTOMER_B_ID);
    const missing = await getPackage(randomUUID(), CUSTOMER_B_ID);
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});

describe("no guest final approval", () => {
  it("REFUSES the page without a signed-in customer", async () => {
    const { packageId } = await issuedPackage();
    const response = await getPackage(packageId);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("authentication_required");
  });

  it("REFUSES the approval without a signed-in customer", async () => {
    const { packageId } = await issuedPackage();
    const response = await postApprove({ packageId, finalApprovalAccepted: true });
    expect(response.status).toBe(401);

    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.approvedAt).toBeNull();
  });

  it("REFUSES an unsigned request", async () => {
    const { packageId } = await issuedPackage();
    const url = new URL(
      `https://shop.example.com/apps/carat/custom-jewelry-approval/${packageId}?shop=x&signature=bogus`
    );
    const response = (await approvalPageLoader({
      request: new Request(url, { method: "GET" }),
      params: { packageId },
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(401);
  });

  it("a package on a project with NO account is invisible", async () => {
    // There is nobody to match, and the owner requires an authenticated
    // customer — so this cannot be approved by anyone.
    const { packageId } = await issuedPackage(null);
    expect((await getPackage(packageId, CUSTOMER_A_ID)).status).toBe(404);
    expect((await getPackage(packageId, CUSTOMER_B_ID)).status).toBe(404);
  });
});

describe("the request affirms and names a package. It decides nothing.", () => {
  it("REQUIRES the literal true affirmation", async () => {
    const { packageId } = await issuedPackage();
    for (const value of [false, "true", 1, null, undefined]) {
      const response = await postApprove(
        { packageId, ...(value === undefined ? {} : { finalApprovalAccepted: value }) },
        CUSTOMER_A_ID
      );
      expect(response.status, `affirmation ${JSON.stringify(value)}`).toBe(400);
    }
    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.approvedAt).toBeNull();
  });

  it.each([
    ["a price", { bankPaymentPriceMinorUnits: "1" }],
    ["a balance", { balanceDueMinorUnits: "0" }],
    ["a deposit credit", { depositCreditMinorUnits: "500000" }],
    ["a specification", { ringSize: "13" }],
    ["a customer id", { customerRef: `gid://shopify/Customer/${CUSTOMER_B_ID}` }],
    ["the acknowledgment text", { exactText: "I approve nothing" }],
    ["a payment basis", { paymentBasis: "bank_payment" }],
  ])("REJECTS a body carrying %s", async (_label, extra) => {
    // `.strict()`. An accepted-and-ignored field is one somebody later wires
    // up, and the failure mode here is a customer setting the price of a
    // custom piece.
    const { packageId } = await issuedPackage();
    const response = await postApprove(
      { packageId, finalApprovalAccepted: true, ...extra },
      CUSTOMER_A_ID
    );
    expect(response.status).toBe(400);
  });
});

describe("approving", () => {
  it("records the approval with real acknowledgment evidence", async () => {
    const { packageId, projectId } = await issuedPackage();
    const response = await postApprove({ packageId, finalApprovalAccepted: true }, CUSTOMER_A_ID);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, string>;
    expect(body.outcome).toBe("approved");
    // The balances on each basis come back, so the theme can offer both paths.
    expect(body.cardBalanceDueMinorUnits).toBe("517500");
    expect(body.bankPaymentBalanceDueMinorUnits).toBe("500000");

    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({
      where: { id: packageId },
      include: { approvalAcknowledgment: { include: { policyVersion: true } } },
    });
    expect(pkg.status).toBe("approved");
    expect(pkg.approvedByCustomerRef).toBe(CUSTOMER_A);
    // THE EVIDENCE. The exact text, the exact button, the policy version.
    expect(pkg.approvalAcknowledgment?.exactText).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
    expect(pkg.approvalAcknowledgment?.affirmativeActionLabel).toBe(
      CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL
    );
    expect(pkg.approvalAcknowledgment?.customerRef).toBe(CUSTOMER_A);
    expect(pkg.approvalAcknowledgment?.policyVersion.slug).toBe("custom-jewelry-final-approval");

    const projectRow = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(projectRow.status).toBe("approved");
  });

  it("is IDEMPOTENT, and writes ONE acknowledgment", async () => {
    // A retried request must not leave two pieces of evidence for one decision.
    //
    // A CUSTOMER OF ITS OWN, because this is the only test here that counts
    // rows. Every other test in this file approves as CUSTOMER_A too, so a
    // count scoped to that shared constant picks up their acknowledgments and
    // reports 2 — which is the test depending on its neighbours rather than
    // the route misbehaving. The first version of this test did exactly that.
    const ownCustomerId = `9${uniq().replace(/-/g, "")}`;
    const ownCustomer = `gid://shopify/Customer/${ownCustomerId}`;
    const projectId = await project(ownCustomer);
    const issued = await issueApprovalPackage({
      projectId,
      spec: SPEC,
      bankPaymentPrice: usd(500_000n),
      regularCardPrice: usd(517_500n),
      issuedByActorRef: STAFF,
      now: NOW,
    });
    if (issued.outcome !== "issued") throw new Error("expected an issue");
    const packageId = issued.package.id;

    const first = await postApprove({ packageId, finalApprovalAccepted: true }, ownCustomerId);
    expect(first.status).toBe(201);
    const second = await postApprove({ packageId, finalApprovalAccepted: true }, ownCustomerId);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { outcome: string }).outcome).toBe("already_approved");

    const pkg = await prisma.customJewelryApprovalPackage.findUniqueOrThrow({ where: { id: packageId } });
    const acks = await prisma.acknowledgment.count({
      where: { customerRef: ownCustomer, policyVersion: { slug: "custom-jewelry-final-approval" } },
    });
    expect(acks).toBe(1);
    expect(pkg.approvedAt).not.toBeNull();
  });

  it("REFUSES a superseded version, telling the customer to reload", async () => {
    const { projectId, packageId } = await issuedPackage();
    await issueApprovalPackage({
      projectId,
      spec: { ...SPEC, ringSize: "8" },
      bankPaymentPrice: usd(520_000n),
      regularCardPrice: usd(538_200n),
      issuedByActorRef: STAFF,
      now: NOW,
    });

    const response = await postApprove({ packageId, finalApprovalAccepted: true }, CUSTOMER_A_ID);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("superseded");
    expect(body.message).toMatch(/replaced by a newer one/i);

    expect(
      await prisma.customJewelryApprovalPackage.count({ where: { projectId, status: "approved" } })
    ).toBe(0);
  });

  it("the page SHOWS a recorded approval rather than inviting a second", async () => {
    const { packageId } = await issuedPackage();
    await postApprove({ packageId, finalApprovalAccepted: true }, CUSTOMER_A_ID);

    const body = (await (await getPackage(packageId, CUSTOMER_A_ID)).json()) as Record<string, never>;
    expect(body.status).toBe("approved");
    expect(body.approval).not.toBeNull();
  });
});
