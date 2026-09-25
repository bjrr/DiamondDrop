import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { createWarrantyClaim, recordWarrantyClaimUpload } from "~/db/repositories/warrantyClaimRepository.server";
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
 * ACKNOWLEDGMENT COPY — NOT YET APPROVED (criterion 154)
 * ============================================================================
 * `docs/specs/SLICE-5-WARRANTY-COPY-PROPOSAL.md` proposes both required
 * acknowledgments' text but is still sitting with the owner. This route does
 * NOT pin any acknowledgment string, add a locale key, or create a
 * `policy_version` row — shipping unapproved copy would be worse than
 * leaving the seam open (this task's explicit instruction).
 *
 * THE SEAM, so pinning later is a small, obvious change:
 *   1. `exactText` for each acknowledgment is read directly from the
 *      resolved `PolicyVersion.text` (below) — NOT a second hardcoded
 *      constant. Once a `policy_version` row exists under
 *      `WARRANTY_ACCURACY_CERTIFICATION_POLICY_SLUG` /
 *      `WARRANTY_COVERAGE_NOT_ESTABLISHED_POLICY_SLUG` (data only, via
 *      `prisma/seed.ts` — no migration required, matching how every other
 *      `policy_version` row is provisioned), that row's `text` IS what gets
 *      recorded — there is no second copy of the words to drift out of sync
 *      with it, unlike `~/domain/luxurysteals/acknowledgmentText.ts`'s
 *      pinned-constant-plus-drift-fence design.
 *   2. `PolicyVersion` carries no affirmative-action-LABEL column (see
 *      `Acknowledgment.affirmativeActionLabel`'s own schema comment) and the
 *      proposal's button labels ("I Certify This Is Accurate", "I
 *      Understand & Agree") are themselves still unapproved — so
 *      `getAcknowledgmentLabelSource()` below is an injectable seam with NO
 *      production default (`productionAcknowledgmentLabelSource` always
 *      throws `WarrantyAcknowledgmentLabelsNotConfiguredError`), exactly
 *      like `apps.carat.bank-checkout.tsx`'s `__setDraftOrderPortForTests`.
 *      WHAT CHANGES: once the owner approves surfaces 2/3, replace
 *      `productionAcknowledgmentLabelSource`'s two methods with imports from
 *      the new `~/domain/warranty/acknowledgmentText.ts` module (task
 *      5-1/5-4's territory) — no other line in this route changes.
 * Until BOTH the policy versions exist AND the label source is configured,
 * `recordClaimAcknowledgments` returns `null` and the route refuses every
 * submission with `acknowledgment_copy_pending_approval` (503) — an honest
 * "not live yet" state, not a guess, exactly as instructed.
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

    // Two SEPARATE affirmative actions (criterion 154) — never one combined
    // checkbox. Each must be the LITERAL boolean `true`; there is no default
    // and nothing here infers acceptance from a missing/absent field.
    accuracyCertificationAccepted: z.literal(true),
    coverageNotEstablishedAccepted: z.literal(true),

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
// Acknowledgment copy seam — see this file's module comment.
// ---------------------------------------------------------------------------

export const WARRANTY_ACCURACY_CERTIFICATION_POLICY_SLUG = "warranty-accuracy-certification";
export const WARRANTY_COVERAGE_NOT_ESTABLISHED_POLICY_SLUG = "warranty-coverage-not-established";

export interface WarrantyAcknowledgmentLabelSource {
  accuracyCertificationLabel(): string;
  coverageNotEstablishedLabel(): string;
}

export class WarrantyAcknowledgmentLabelsNotConfiguredError extends Error {
  constructor() {
    super("Warranty claim acknowledgment copy is not yet approved; no affirmative-action labels are configured.");
    this.name = "WarrantyAcknowledgmentLabelsNotConfiguredError";
  }
}

const productionAcknowledgmentLabelSource: WarrantyAcknowledgmentLabelSource = {
  accuracyCertificationLabel(): string {
    throw new WarrantyAcknowledgmentLabelsNotConfiguredError();
  },
  coverageNotEstablishedLabel(): string {
    throw new WarrantyAcknowledgmentLabelsNotConfiguredError();
  },
};

let acknowledgmentLabelSourceOverrideForTests: WarrantyAcknowledgmentLabelSource | null = null;
export function __setWarrantyAcknowledgmentLabelSourceForTests(source: WarrantyAcknowledgmentLabelSource | null): void {
  acknowledgmentLabelSourceOverrideForTests = source;
}
function getAcknowledgmentLabelSource(): WarrantyAcknowledgmentLabelSource {
  return acknowledgmentLabelSourceOverrideForTests ?? productionAcknowledgmentLabelSource;
}

interface ClaimAcknowledgmentIds {
  readonly accuracyCertificationAcknowledgmentId: string;
  readonly coverageNotEstablishedAcknowledgmentId: string;
}

/** Returns `null` (never throws) when copy is not yet approved/configured — the caller turns that into the 503 response. */
async function recordClaimAcknowledgments(input: {
  orderRef: string;
  customerRef: string | null;
  productRef: string | null;
  variantRef: string | null;
}): Promise<ClaimAcknowledgmentIds | null> {
  const [accuracyPolicy, coveragePolicy] = await Promise.all([
    getLatestPolicyVersion(WARRANTY_ACCURACY_CERTIFICATION_POLICY_SLUG),
    getLatestPolicyVersion(WARRANTY_COVERAGE_NOT_ESTABLISHED_POLICY_SLUG),
  ]);
  if (!accuracyPolicy || !coveragePolicy) return null;

  const labelSource = getAcknowledgmentLabelSource();
  let accuracyLabel: string;
  let coverageLabel: string;
  try {
    accuracyLabel = labelSource.accuracyCertificationLabel();
    coverageLabel = labelSource.coverageNotEstablishedLabel();
  } catch {
    return null;
  }

  const acknowledgedAt = new Date();
  const accuracyAck = await createAcknowledgment({
    exactText: accuracyPolicy.text,
    policyVersionId: accuracyPolicy.id,
    acknowledgedAt,
    affirmativeActionLabel: accuracyLabel,
    customerRef: input.customerRef ?? undefined,
    orderRef: input.orderRef,
    productRef: input.productRef ?? undefined,
    variantRef: input.variantRef ?? undefined,
  });
  const coverageAck = await createAcknowledgment({
    exactText: coveragePolicy.text,
    policyVersionId: coveragePolicy.id,
    acknowledgedAt,
    affirmativeActionLabel: coverageLabel,
    customerRef: input.customerRef ?? undefined,
    orderRef: input.orderRef,
    productRef: input.productRef ?? undefined,
    variantRef: input.variantRef ?? undefined,
  });

  return {
    accuracyCertificationAcknowledgmentId: accuracyAck.id,
    coverageNotEstablishedAcknowledgmentId: coverageAck.id,
  };
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
  // complete anyway while copy is unapproved. See module comment.
  const customerRef = normalizeCustomerGid(loggedInCustomerId);
  const acknowledgments = await recordClaimAcknowledgments({
    orderRef: orderGid,
    customerRef,
    productRef: null,
    variantRef: body.shopifyVariantId ? normalizeVariantGid(body.shopifyVariantId) : null,
  });
  if (!acknowledgments) {
    logger.warn("warranty_claim.acknowledgment_copy_pending_approval", {});
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
    accuracyCertificationAcknowledgmentId: acknowledgments.accuracyCertificationAcknowledgmentId,
    coverageNotEstablishedAcknowledgmentId: acknowledgments.coverageNotEstablishedAcknowledgmentId,
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
