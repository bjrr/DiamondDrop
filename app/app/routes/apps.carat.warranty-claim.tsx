import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { createWarrantyClaim, recordWarrantyClaimUpload } from "~/db/repositories/warrantyClaimRepository.server";
import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "~/domain/warranty/acknowledgmentText";
import { validateWarrantyUploadMetadata } from "~/jobs/warranty/uploadValidation";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { WarrantyClaimOrderLookupPort } from "~/shopify/admin/warrantyClaimOrderLookupAdapter.server";
import { ShopifyWarrantyClaimOrderLookupAdapter } from "~/shopify/admin/warrantyClaimOrderLookupAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/warranty-claim — the Warranty Claim Form intake endpoint
 * (Slice 5 task 5-3, docs/WARRANTY-CLAIMS.md, docs/specs/
 * SLICE-5-WARRANTY-CLAIMS.md criteria 153-157).
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route (see
 * `apps.carat.luxury-acknowledgment.tsx`'s module comment, and
 * `csrfResourceRouteFence.test.ts`, which enforces this mechanically).
 *
 * ============================================================================
 * CRITERION 156 — THE GATE THIS FILE IS MOST CAREFUL ABOUT
 * ============================================================================
 * This route NEVER produces a shipping instruction of any kind — no address,
 * no "send it to", no hint the customer might post the item. `WARRANTY-
 * CLAIMS.md` §3 is explicit that authorization for inspection is a later,
 * separate, explicit staff act (task 5-4's admin surface calls
 * `authorizeWarrantyClaimForInspection`), and this route never calls it. The
 * success response below (`buildConfirmationDto`) is a closed allow-list of
 * fields — `claimId` / `claimReference` / `status` only — specifically so
 * that no future field addition here can smuggle shipping content in by
 * accident. See `warrantyClaim.test.ts`'s fence test for the literal check.
 *
 * ============================================================================
 * ACKNOWLEDGMENT COPY — APPROVED 2026-09-25, ONE MERGED ACKNOWLEDGMENT
 * ============================================================================
 * `docs/specs/SLICE-5-WARRANTY-COPY-PROPOSAL.md` proposed two separate
 * acknowledgments (accuracy certification, coverage-not-established); the
 * owner approved a single merged statement instead, which also covers the
 * shipping undertaking (§4) — see `~/domain/warranty/acknowledgmentText.ts`'s
 * own header for the exact text and why it is one acknowledgment, not two.
 * `WarrantyClaim`'s two FK columns (`accuracyCertificationAcknowledgmentId` /
 * `coverageNotEstablishedAcknowledgmentId`, task 5-1's schema, out of this
 * task's scope to change) both reference the SAME `Acknowledgment` row for a
 * given claim — a correct, if slightly redundant, way to represent "the
 * owner merged these two into one".
 *
 * `recordClaimAcknowledgment` resolves `WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG`
 * via `getLatestPolicyVersion`, exactly like
 * `apps.carat.luxury-acknowledgment.tsx` resolves the Final Sale policy —
 * the pinned `exactText`/`affirmativeActionLabel` constants are recorded
 * against whatever `policy_version` row migration
 * `20260925030000_warranty_claim_policy_version` provisions. The 503
 * `acknowledgment_copy_pending_approval` response STAYS in place even though
 * the copy is now approved: it is the honest answer for a misprovisioned
 * environment where that migration has not run — exactly the safety net
 * `/health`'s `checkRequiredPolicyVersionsProvisioned` exists for (see
 * `~/domain/evidence/requiredPolicyVersions.ts`, which this policy is now
 * registered in).
 *
 * ============================================================================
 * CRITERION 155 — ORDER/LINE RESOLUTION, AND WHAT THIS ROUTE DOES NOT DO
 * ============================================================================
 * `orderRef`/`lineRef` are resolved against Shopify via
 * `WarrantyClaimOrderLookupPort` (see that module's own confidence-grading
 * comment — its GraphQL shape is recalled, not live-introspected). A claim
 * whose order or line cannot be found this way is refused, unwritten.
 *
 * `shopifyVariantId` -> `MasterVariant` resolution is SEPARATE and
 * deliberately does NOT gate claim creation — `WarrantyClaim.masterVariantId`
 * is nullable precisely because "a resolved order line does not guarantee a
 * MasterVariant match exists for every historical/Shopify-native SKU" (see
 * that column's schema.prisma comment). Conflating the two would refuse
 * legitimate claims on older or Shopify-native products never modelled in
 * our catalogue.
 *
 * NOT DONE HERE: full verification that the order belongs to the person
 * filing the claim. This route does a LIGHT check (if the App Proxy
 * identifies a logged-in customer AND the resolved order has a customer on
 * file, they must match) but does not require either side to be present —
 * a guest checkout order and a guest-filed claim are both real. Deeper
 * ownership verification is `WARRANTY-CLAIMS.md` §3's job: staff reviews
 * every claim before authorizing anything.
 */

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;
const LINE_ITEM_GID_PATTERN = /^gid:\/\/shopify\/LineItem\/\d+$/;

function normalizeOrderGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/Order/${raw}`;
}
function normalizeLineItemGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/LineItem/${raw}`;
}
function normalizeVariantGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/ProductVariant/${raw}`;
}
/** `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`, or `null` for a guest — mirrors `apps.carat.luxury-acknowledgment.tsx`. */
function normalizeCustomerGid(rawId: string | null): string | null {
  if (!rawId) return null;
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .optional();

const uploadSchema = z.object({
  kind: z.enum(["photo", "video"]),
  /** Produced by a prior call against `~/jobs/warranty/ports`' upload port — this route never issues destinations itself. */
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive(),
  checksum: z.string().min(1).max(200),
});

const bodySchema = z
  .object({
    orderRef: z.string().min(1).max(200),
    lineRef: z.string().min(1).max(200),
    /** Optional — see this file's module comment on why variant resolution never gates claim creation. */
    shopifyVariantId: z.string().min(1).max(200).optional(),

    purchaserName: z.string().min(1).max(200),
    purchaserEmail: z.string().email().max(320),

    itemConfigurationDescription: z.string().min(1).max(2000),
    purchaseDate: dateOnly,
    deliveryDate: dateOnly,
    issueFirstNoticedDate: dateOnly,

    problemDescription: z.string().min(1).max(5000),

    hadImpactOrDamageEvent: z.boolean(),
    impactOrDamageDetails: z.string().max(2000).optional(),

    wasAlteredAfterDelivery: z.boolean(),
    alterationDetails: z.string().max(2000).optional(),

    certificateOrSerialIdentifier: z.string().max(500).optional(),

    // ONE affirmative action (criterion 154 — the owner merged the two
    // proposed acknowledgments into a single statement, see
    // `~/domain/warranty/acknowledgmentText.ts`). Must be the LITERAL
    // boolean `true`; there is no default and nothing here infers
    // acceptance from a missing/absent field — never pre-checked.
    claimAcknowledgmentAccepted: z.literal(true),

    uploads: z.array(uploadSchema).max(10).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.hadImpactOrDamageEvent && !value.impactOrDamageDetails?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["impactOrDamageDetails"],
        message: "impactOrDamageDetails is required when hadImpactOrDamageEvent is true",
      });
    }
    if (value.wasAlteredAfterDelivery && !value.alterationDetails?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alterationDetails"],
        message: "alterationDetails is required when wasAlteredAfterDelivery is true",
      });
    }
  });

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Order/line lookup port wiring — mirrors `apps.carat.bank-checkout.tsx`'s
// `createDraftOrderPort`/`__setDraftOrderPortForTests` exactly.
// ---------------------------------------------------------------------------

let orderLookupPortOverrideForTests: WarrantyClaimOrderLookupPort | null = null;
export function __setWarrantyClaimOrderLookupPortForTests(port: WarrantyClaimOrderLookupPort | null): void {
  orderLookupPortOverrideForTests = port;
}

async function createOrderLookupPort(): Promise<WarrantyClaimOrderLookupPort> {
  if (orderLookupPortOverrideForTests) return orderLookupPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured; the warranty claim route cannot reach the Shopify Admin API.");
  }
  // Dynamic import for the same reason `apps.carat.bank-checkout.tsx` does
  // this: importing `~/shopify.server` at module scope would require
  // Shopify OAuth configured merely to LOAD this route file.
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyWarrantyClaimOrderLookupAdapter(admin);
}

// ---------------------------------------------------------------------------
// Acknowledgment — pinned, approved copy. See this file's module comment.
// ---------------------------------------------------------------------------

/**
 * Records the ONE required acknowledgment (criterion 154) and returns its
 * id, or `null` (never throws) if `WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG`
 * has no provisioned `policy_version` — the caller turns that into the 503
 * safety-net response. Mirrors `apps.carat.luxury-acknowledgment.tsx`'s
 * `policyVersion`/`policy_unavailable` handling exactly.
 */
async function recordClaimAcknowledgment(input: {
  orderRef: string;
  customerRef: string | null;
  productRef: string | null;
  variantRef: string | null;
}): Promise<string | null> {
  const policyVersion = await getLatestPolicyVersion(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!policyVersion) return null;

  const acknowledgment = await createAcknowledgment({
    exactText: WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
    policyVersionId: policyVersion.id,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    customerRef: input.customerRef ?? undefined,
    orderRef: input.orderRef,
    productRef: input.productRef ?? undefined,
    variantRef: input.variantRef ?? undefined,
  });
  return acknowledgment.id;
}

// ---------------------------------------------------------------------------
// Success response — CLOSED allow-list (criterion 156, see module comment).
// ---------------------------------------------------------------------------

function buildConfirmationDto(claim: { id: string; claimReference: string; status: string }) {
  return { claimId: claim.id, claimReference: claim.claimReference, status: claim.status };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("warranty_claim.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the warranty claim request contract");
  }
  const body = parsed.data;

  const orderGid = normalizeOrderGid(body.orderRef);
  const lineGid = normalizeLineItemGid(body.lineRef);
  if (!ORDER_GID_PATTERN.test(orderGid) || !LINE_ITEM_GID_PATTERN.test(lineGid)) {
    return badRequest("orderRef/lineRef do not look like Shopify order/line-item identifiers");
  }

  // Pre-validate any upload metadata BEFORE writing anything (pure, no I/O) —
  // fail the whole submission on a bad item rather than partially recording it.
  for (const upload of body.uploads ?? []) {
    const validation = validateWarrantyUploadMetadata(upload);
    if (!validation.ok) {
      return Response.json({ error: "invalid_upload", reason: validation.reason }, { status: 422 });
    }
  }

  // ACKNOWLEDGMENT GATE FIRST (criterion 154) — cheap, local, and avoids
  // ever calling the Shopify Admin API for a submission this route cannot
  // complete anyway if the environment is misprovisioned. See module comment.
  const customerRef = normalizeCustomerGid(loggedInCustomerId);
  const acknowledgmentId = await recordClaimAcknowledgment({
    orderRef: orderGid,
    customerRef,
    productRef: null,
    variantRef: body.shopifyVariantId ? normalizeVariantGid(body.shopifyVariantId) : null,
  });
  if (!acknowledgmentId) {
    logger.error("warranty_claim.acknowledgment_copy_pending_approval", {});
    return Response.json({ error: "acknowledgment_copy_pending_approval" }, { status: 503 });
  }

  // CRITERION 155 — the order/line must resolve against Shopify.
  let orderLookupPort: WarrantyClaimOrderLookupPort;
  try {
    orderLookupPort = await createOrderLookupPort();
  } catch (error) {
    logger.error("warranty_claim.order_lookup_port_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_unavailable" }, { status: 500 });
  }

  let resolvedOrder;
  try {
    resolvedOrder = await orderLookupPort.resolveOrderLine({ orderGid, lineItemGid: lineGid });
  } catch (error) {
    logger.error("warranty_claim.order_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_failed" }, { status: 502 });
  }
  if (!resolvedOrder) {
    logger.warn("warranty_claim.order_or_line_unresolved", {});
    return Response.json({ error: "order_or_line_unresolved" }, { status: 422 });
  }

  // Light ownership check — see module comment for why this is intentionally
  // not the whole answer. Only blocks when BOTH sides are known and disagree.
  if (customerRef && resolvedOrder.customerGid && customerRef !== resolvedOrder.customerGid) {
    logger.warn("warranty_claim.order_customer_mismatch", {});
    return Response.json({ error: "order_or_line_unresolved" }, { status: 422 });
  }

  // MasterVariant resolution — best-effort, never gates claim creation. See
  // module comment on why this is deliberately separate from criterion 155.
  let masterVariantId: string | null = null;
  if (body.shopifyVariantId) {
    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: normalizeVariantGid(body.shopifyVariantId) },
      select: { id: true },
    });
    masterVariantId = variant?.id ?? null;
  }

  const claim = await createWarrantyClaim({
    orderRef: orderGid,
    lineRef: lineGid,
    customerRef,
    masterVariantId,
    itemConfigurationDescription: body.itemConfigurationDescription,
    purchaserName: body.purchaserName,
    purchaserEmail: body.purchaserEmail,
    purchaseDate: body.purchaseDate ?? null,
    deliveryDate: body.deliveryDate ?? null,
    issueFirstNoticedDate: body.issueFirstNoticedDate ?? null,
    problemDescription: body.problemDescription,
    hadImpactOrDamageEvent: body.hadImpactOrDamageEvent,
    impactOrDamageDetails: body.impactOrDamageDetails ?? null,
    wasAlteredAfterDelivery: body.wasAlteredAfterDelivery,
    alterationDetails: body.alterationDetails ?? null,
    certificateOrSerialIdentifier: body.certificateOrSerialIdentifier ?? null,
    // Same acknowledgment row referenced by both FK columns — the owner
    // merged the two proposed acknowledgments into one (see module comment).
    accuracyCertificationAcknowledgmentId: acknowledgmentId,
    coverageNotEstablishedAcknowledgmentId: acknowledgmentId,
    actor: { actorType: "customer", actorRef: customerRef, reason: "claim submitted via warranty claim form" },
  });

  // Uploads — already validated above; recorded per-item. A failure here
  // still leaves the customer with a real, valid claim (see this route's
  // handoff notes on why this is not wrapped in the same transaction as
  // claim creation).
  for (const upload of body.uploads ?? []) {
    try {
      await recordWarrantyClaimUpload({
        claimId: claim.id,
        kind: upload.kind,
        storageKey: upload.storageKey,
        contentType: upload.contentType,
        sizeBytes: BigInt(upload.sizeBytes),
        checksum: upload.checksum,
        uploadedByActorType: "customer",
        uploadedByActorRef: customerRef,
      });
    } catch (error) {
      logger.error("warranty_claim.upload_record_failed", {
        claimId: claim.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  logger.info("warranty_claim.submitted", { claimId: claim.id });

  return Response.json(buildConfirmationDto(claim), { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
