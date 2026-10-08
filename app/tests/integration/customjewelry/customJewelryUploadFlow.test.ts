import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { recordIssuedUploadDestination } from "~/db/repositories/uploadDestinationRepository.server";
import { action as intakeAction } from "~/routes/apps.carat.custom-jewelry-intake";
import { action as destinationAction } from "~/routes/apps.carat.custom-jewelry-upload-destination";

/**
 * The Custom Jewelry upload path, against real Postgres.
 *
 * THE OWNER'S REQUIREMENT WAS EXPLICIT: "Do not accept 'shared code' as
 * proof; both real customer paths must exercise it." So these go through the
 * actual routes rather than calling the shared service directly — the
 * service's own suite already covers it in isolation.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER_A = "771111";
const CUSTOMER_A_GID = `gid://shopify/Customer/${CUSTOMER_A}`;
const CUSTOMER_B = "772222";
const CUSTOMER_B_GID = `gid://shopify/Customer/${CUSTOMER_B}`;

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

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(fn: typeof intakeAction, request: Request) {
  return fn({ request, params: {}, context: {} } as never);
}

function intakeBody(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${uniq()}@example.com`,
    phone: "+1 555 0100",
    startingPoint: "from_scratch",
    promptText: "A signet ring reworked from my grandmother's.",
    followUpPreference: "contact_me",
    ...overrides,
  };
}

function anUpload(storageKey: string) {
  return {
    kind: "photo" as const,
    storageKey,
    contentType: "image/jpeg",
    sizeBytes: 500_000,
    checksum: `sha256:${randomUUID().replace(/-/g, "")}`,
  };
}

/** Seeds a destination through the SHARED service, as the real route would. */
async function seedDestination(
  overrides: Partial<{
    purpose: "warranty_claim" | "custom_jewelry_project";
    ownerId: string;
    customerRef: string;
    expiresAt: Date;
  }> = {}
) {
  const input = {
    purpose: overrides.purpose ?? ("custom_jewelry_project" as const),
    ownerId: overrides.ownerId ?? randomUUID(),
    customerRef: overrides.customerRef ?? CUSTOMER_A_GID,
    kind: "photo" as const,
    contentType: "image/jpeg",
    storageKey: `custom-jewelry/${randomUUID()}/photo/${randomUUID()}.jpg`,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
  };
  await recordIssuedUploadDestination(input);
  return input;
}

describe("issuing a Custom Jewelry upload destination requires an account", () => {
  it("REFUSES an anonymous caller, even though the enquiry itself is open", async () => {
    // The asymmetry is the owner's decision: enquiry open, uploads gated.
    const response = await call(
      destinationAction,
      signedPost("/apps/carat/custom-jewelry-upload-destination", { shop: SHOP }, {
        projectId: randomUUID(),
        kind: "photo",
        contentType: "image/jpeg",
        sizeBytes: 500_000,
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("authentication_required");
    expect(body.message).toBe("Please sign in or create a CaratForUs account to continue.");
  });

  it("refuses an unsigned request before anything else", async () => {
    const url = new URL("https://shop.example.com/apps/carat/custom-jewelry-upload-destination?shop=" + SHOP);
    const response = await call(
      destinationAction,
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    expect(response.status).toBe(401);
  });

  it("refuses a project id belonging to SOMEONE ELSE, indistinguishably from one that does not exist", async () => {
    // Customer B's project, requested by customer A.
    const bResponse = await call(
      intakeAction,
      signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP, logged_in_customer_id: CUSTOMER_B }, intakeBody())
    );
    expect(bResponse.status).toBe(201);
    const { projectReference } = (await bResponse.json()) as { projectReference: string };
    const bProject = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });

    const stolen = await call(
      destinationAction,
      signedPost(
        "/apps/carat/custom-jewelry-upload-destination",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        { projectId: bProject.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 500_000 }
      )
    );
    expect(stolen.status).toBe(422);
    expect(((await stolen.json()) as { error: string }).error).toBe("project_unresolved");
  });
});

describe("intake accepts verified uploads and refuses everything else", () => {
  it("records an upload whose destination was genuinely issued", async () => {
    const projectId = randomUUID();
    const destination = await seedDestination({ ownerId: projectId, customerRef: CUSTOMER_A_GID });

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(destination.storageKey)] })
      )
    );
    expect(response.status).toBe(201);

    const uploads = await prisma.customJewelryProjectUpload.findMany({ where: { projectId } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.storageKey).toBe(destination.storageKey);
    // METADATA ONLY — no byte payload column anywhere on this row.
    expect(Object.keys(uploads[0]!).sort()).toEqual(
      [
        "checksum",
        "contentType",
        "id",
        "kind",
        "projectId",
        "sizeBytes",
        "storageKey",
        "uploadedAt",
        "uploadedByActorRef",
        "uploadedByActorType",
      ].sort()
    );
  });

  it("REFUSES an invented storage key and creates NO project", async () => {
    const projectId = randomUUID();
    const before = await prisma.customJewelryProject.count();

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(`custom-jewelry/${randomUUID()}/photo/x.jpg`)] })
      )
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_upload_reference");
    expect(await prisma.customJewelryProject.count()).toBe(before);
  });

  it("REFUSES uploads from an anonymous submitter, and still allows a file-less enquiry", async () => {
    const response = await call(
      intakeAction,
      signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP }, intakeBody({
        projectId: randomUUID(),
        uploads: [anUpload("custom-jewelry/x/photo/y.jpg")],
      }))
    );
    expect(response.status).toBe(401);

    // ...but the enquiry itself still goes through without files.
    const fileless = await call(
      intakeAction,
      signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP }, intakeBody())
    );
    expect(fileless.status).toBe(201);
  });

  it("a batch with ONE bad key is refused whole — the good key is not consumed", async () => {
    const projectId = randomUUID();
    const good = await seedDestination({ ownerId: projectId, customerRef: CUSTOMER_A_GID });

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({
          projectId,
          uploads: [anUpload(good.storageKey), anUpload(`custom-jewelry/${randomUUID()}/photo/x.jpg`)],
        })
      )
    );
    expect(response.status).toBe(422);

    // The transaction rolled back, so the good destination is still spendable.
    const row = await prisma.warrantyClaimUploadDestination.findUniqueOrThrow({
      where: { storageKey: good.storageKey },
    });
    expect(row.consumedAt).toBeNull();
  });

  it("ignores a projectId when the submission carries NO uploads", async () => {
    // A client-chosen primary key is accepted only to bind files. With none
    // there is nothing to bind, and honouring it would make creation an
    // existence oracle for a guessed id.
    const attempted = randomUUID();
    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId: attempted })
      )
    );
    expect(response.status).toBe(201);
    expect(await prisma.customJewelryProject.findUnique({ where: { id: attempted } })).toBeNull();
  });
});

/**
 * CROSS-PURPOSE ISOLATION THROUGH THE REAL ROUTES (owner requirement
 * 2026-10-05). The shared service's own suite proves the predicate; this
 * proves the customer paths actually carry it.
 */
describe("a destination cannot cross between Warranty and Custom Jewelry", () => {
  it("a WARRANTY-issued key is rejected by Custom Jewelry intake", async () => {
    const projectId = randomUUID();
    const warrantyKey = await seedDestination({
      purpose: "warranty_claim",
      ownerId: projectId,
      customerRef: CUSTOMER_A_GID,
    });

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(warrantyKey.storageKey)] })
      )
    );
    expect(response.status).toBe(422);

    // Unspent: a cross-purpose attempt must not burn the warranty destination.
    const row = await prisma.warrantyClaimUploadDestination.findUniqueOrThrow({
      where: { storageKey: warrantyKey.storageKey },
    });
    expect(row.consumedAt).toBeNull();
  });

  it("CUSTOMER A cannot spend CUSTOMER B's Custom Jewelry destination", async () => {
    const projectId = randomUUID();
    const bDestination = await seedDestination({ ownerId: projectId, customerRef: CUSTOMER_B_GID });

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(bDestination.storageKey)] })
      )
    );
    expect(response.status).toBe(422);
  });

  it("an EXPIRED destination is rejected", async () => {
    const projectId = randomUUID();
    const expired = await seedDestination({
      ownerId: projectId,
      customerRef: CUSTOMER_A_GID,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(expired.storageKey)] })
      )
    );
    expect(response.status).toBe(422);
  });

  it("a destination is SINGLE USE across submissions", async () => {
    const projectId = randomUUID();
    const destination = await seedDestination({ ownerId: projectId, customerRef: CUSTOMER_A_GID });

    const first = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId, uploads: [anUpload(destination.storageKey)] })
      )
    );
    expect(first.status).toBe(201);

    const reuse = await call(
      intakeAction,
      signedPost(
        "/apps/carat/custom-jewelry-intake",
        { shop: SHOP, logged_in_customer_id: CUSTOMER_A },
        intakeBody({ projectId: randomUUID(), uploads: [anUpload(destination.storageKey)] })
      )
    );
    expect(reuse.status).toBe(422);
  });
});
