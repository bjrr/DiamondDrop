import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { createWarrantyClaim, recordWarrantyClaimUpload } from "~/db/repositories/warrantyClaimRepository.server";
import { consumeWarrantyClaimUploadDestination } from "~/db/repositories/warrantyClaimUploadDestinationRepository.server";
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
 * UPLOAD DESTINATIONS ARE VERIFIED, NOT TRUSTED — closes the storageKey trust
 * gap flagged in the R2 adapter handoff
 * ============================================================================
 * `uploads[].storageKey` used to be accepted as an opaque client-supplied
 * string with nothing checking that a destination was ever actually issued
 * for it — "a claim can name a key nobody ever uploaded to. It matters
 * because those rows ARE the dispute evidence" (assigning message). Every
 * upload is now verified AND CONSUMED (`consumeWarrantyClaimUploadDestination`,
 * one atomic conditional UPDATE per key, never a read-then-write) before this
 * route creates anything. An unverifiable key — never issued, issued for a
 * DIFFERENT claim, issued to a DIFFERENT customer, expired, or already
 * consumed — REFUSES THE ENTIRE SUBMISSION with 422 `invalid_upload_reference`
 * and creates NO claim at all. This is a deliberate reversal of this route's
 * earlier behaviour (uploads used to be recorded best-effort, outside the
 * claim-creation path, so a bad one would silently leave "a real, valid claim"
 * minus that evidence) — the assigning message is explicit that succeeding
 * minus evidence is the worse outcome, not the safer one, because the
 * resulting claim reads as substantiated when it is not.
 *
 * `claimId` in the body is the mechanism that makes this possible before the
 * claim exists: the client generates it (`crypto.randomUUID()`), uses it to
 * request every destination it needs from `apps.carat.warranty-claim-upload-
 * destination.tsx` WHILE the form is being filled out, and submits that same
 * id here so `createWarrantyClaim` creates the row with that EXACT id — see
 * `CreateWarrantyClaimInput.id`'s comment and that route's "WHY A
 * NOT-YET-EXISTING CLAIM ID IS ALLOWED" module comment. Required whenever
 * `uploads` is non-empty; a submission with uploads but no `claimId` is
 * refused with 400 before anything is touched.
 *
 * Verification never distinguishes WHY a key failed in its response — a key
 * issued for someone else's claim and a key that never existed are
 * indistinguishable, by design (assigning message's enumeration-oracle
 * constraint). The specific reason is logged server-side only.
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
 * ============================================================================
 * REQUIRED CUSTOMER ACCOUNTS — docs/REQUIRED-CUSTOMER-ACCOUNTS.md (LOCKED,
 * approved 2026-09-26). READ THAT DOCUMENT IN FULL BEFORE CHANGING THIS ROUTE.
 * ============================================================================
 * SECURITY FIX, 2026-09-26, SUPERSEDES THE PARAGRAPH THIS REPLACES. This
 * route used to do only a LIGHT ownership check — "if the App Proxy
 * identifies a logged-in customer AND the resolved order has a customer on
 * file, they must match" — which blocks ONLY when both sides happen to be
 * known. A `null` `customerRef` (an anonymous caller) skipped the check
 * entirely, so any signed-out visitor who could guess or discover a
 * low-entropy Shopify order gid could file a real `WarrantyClaim` against
 * it with no account at all. Policy §5/§9 cases 3-5 require this to fail
 * closed. "A guest checkout order and a guest-filed claim are both real" was
 * the deliberate design of this route until this policy landed; it is now
 * superseded, not merely tightened.
 *
 * Fixed the same way `apps.carat.rma-intake.tsx` fixes the identical bug
 * class — self-service warranty claims are no longer a guest path at all:
 *   - Identity comes ONLY from the signed App Proxy `logged_in_customer_id`,
 *     never from any client-supplied field. A request with no
 *     `logged_in_customer_id` is refused with `401 authentication_required`
 *     (the owner-approved gate copy, verbatim) BEFORE the body is even
 *     parsed — an anonymous visitor cannot reach any further branch of this
 *     route, including the acknowledgment gate or order lookup.
 *   - Ownership of the resolved order is now a HARD requirement, not the
 *     light check described above: `resolvedOrder.customerGid` must equal
 *     the authenticated identity EXACTLY. An order with no customer on file,
 *     or with a DIFFERENT customer, is refused with the SAME generic
 *     `order_or_line_unresolved` response as an order that does not exist at
 *     all — collapsing "doesn't exist," "isn't yours," and "has no customer
 *     on file" into one outcome, so this endpoint cannot be used to
 *     enumerate orders or learn anything about one that is not the caller's
 *     own (docs §5, §9 case 5).
 *   - A customer who cannot access the purchasing account is directed to
 *     Customer Care (docs §5, §9 case 9) — this route does not, and must
 *     never, offer a self-service bypass for that case.
 *
 * Deeper ownership verification beyond "this claim belongs to the
 * authenticated caller" is still `WARRANTY-CLAIMS.md` §3's job: staff
 * reviews every claim before authorizing anything.
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
/**
 * `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`.
 * UNLIKE the earlier version of this function (and unlike the still-guest
 * -tolerant `apps.carat.luxury-acknowledgment.tsx`, which predates
 * docs/REQUIRED-CUSTOMER-ACCOUNTS.md and is a separate agent's concurrent
 * work — not touched here), this route's caller in `action` below NEVER
 * passes a `null`/absent id past the authentication gate — see this file's
 * REQUIRED CUSTOMER ACCOUNTS module comment. Mirrors
 * `apps.carat.rma-intake.tsx`'s `normalizeCustomerGid` exactly.
 */
function normalizeCustomerGid(rawId: string): string {
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
    /**
     * Client-generated (`crypto.randomUUID()`), REQUIRED whenever `uploads`
     * is non-empty — see this file's "UPLOAD DESTINATIONS ARE VERIFIED, NOT
     * TRUSTED" module comment. Becomes the created claim's actual `id`.
     * Optional here (rather than always-required) so a submission with no
     * uploads is unaffected by this change.
     */
    claimId: z.string().uuid().optional(),
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

/**
 * Thrown INSIDE the upload-destination-consumption transaction to force an
 * actual rollback — see that transaction's own comment on why returning a
 * sentinel value instead does not roll anything back. Caught immediately
 * outside the transaction and turned into the generic 422 response; never
 * escapes this file.
 */
class UnverifiableUploadReferenceError extends Error {}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim
      // (reused here — no warranty-specific gate copy has been separately
      // approved, same as `apps.carat.rma-intake.tsx`).
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
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
  /** Always the authenticated identity now (docs/REQUIRED-CUSTOMER-ACCOUNTS.md) — the action() gate below refuses the request before this is ever called with an absent identity. */
  customerRef: string;
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
    customerRef: input.customerRef,
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

  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5/§9 cases 3-5 — checked BEFORE the
  // body is even parsed. An anonymous visitor (no `logged_in_customer_id` in
  // the signed App Proxy params) gets refused here, unconditionally; there
  // is no downstream branch of this route an anonymous caller can reach.
  // See this file's REQUIRED CUSTOMER ACCOUNTS module comment.
  if (!loggedInCustomerId) {
    logger.warn("warranty_claim.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerRef = normalizeCustomerGid(loggedInCustomerId);

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

  const uploads = body.uploads ?? [];
  if (uploads.length > 0 && !body.claimId) {
    return badRequest("claimId is required when uploads are provided");
  }

  // VERIFY + CONSUME every upload destination BEFORE anything else is
  // written — see this file's "UPLOAD DESTINATIONS ARE VERIFIED, NOT
  // TRUSTED" module comment. Cheap and entirely local (no Shopify Admin API
  // call), so it runs before the acknowledgment write and the order lookup:
  // a submission with a bad key is refused before either of those happen.
  // One transaction across every upload in this submission — if ANY key
  // fails verification, destinations already consumed earlier in this same
  // loop are rolled back too, so a partially-bad submission never leaves
  // some of its evidence silently consumed and orphaned.
  if (uploads.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const upload of uploads) {
          const consumed = await consumeWarrantyClaimUploadDestination(
            { storageKey: upload.storageKey, claimId: body.claimId!, customerRef },
            tx
          );
          // THROW, do not merely return/break. Returning a sentinel value
          // from a Prisma `$transaction` callback does NOT roll it back —
          // only a thrown error does. A first draft of this route returned
          // `false` here, which meant destinations consumed EARLIER in this
          // same loop stayed consumed even though the overall submission was
          // about to be refused — exactly the "spent but attached to
          // nothing" state this whole fix exists to prevent. Caught by
          // `warrantyClaimRoute.test.ts`'s "the SAME key referenced TWICE in
          // one submission" test before this ever shipped.
          if (!consumed) throw new UnverifiableUploadReferenceError();
        }
      });
    } catch (error) {
      if (error instanceof UnverifiableUploadReferenceError) {
        // Deliberately generic — see this file's module comment on why a key
        // issued for someone else's claim and a key that never existed must
        // be indistinguishable. The actual reason is never recoverable from
        // this check anyway (`consumeWarrantyClaimUploadDestination`
        // collapses every failure mode into `false` by construction).
        logger.warn("warranty_claim.invalid_upload_reference", {});
        return Response.json({ error: "invalid_upload_reference" }, { status: 422 });
      }
      throw error;
    }
  }

  // ACKNOWLEDGMENT GATE (criterion 154) — cheap, local, and avoids ever
  // calling the Shopify Admin API for a submission this route cannot
  // complete anyway if the environment is misprovisioned. `customerRef` was
  // already established by the authentication gate above, before the body
  // was even parsed. See module comment.
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

  // HARD ownership requirement (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5, §9
  // case 5) — NOT the light check this route used before. An order with no
  // customer on file, or with a DIFFERENT customer, is refused with the SAME
  // generic response as an order that does not exist at all, so this
  // endpoint cannot be used to enumerate orders or learn anything about one
  // that is not the caller's own.
  if (resolvedOrder.customerGid !== customerRef) {
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
    // Keyed on `uploads.length`, NOT on whether `body.claimId` happens to be
    // present. A client-chosen primary key is accepted for exactly one
    // reason — to bind evidence that was uploaded before the claim existed —
    // so with no uploads there is nothing to bind and the column default
    // (`@default(uuid())`) generates the id, exactly as before this field
    // existed. Writing this as `body.claimId ?? undefined` would also honour
    // a `claimId` sent alongside an EMPTY `uploads` array, which nothing
    // refuses: that turns claim creation into a weak existence oracle for a
    // guessed id (collision fails distinctively, a free id succeeds) and
    // hands a caller control of a primary key they never supplied evidence
    // for. Unguessable in practice — these are v4 UUIDs — but it costs one
    // expression to not offer it at all.
    //
    // When uploads WERE provided, `body.claimId` is guaranteed non-null here
    // (the check above already refused the request otherwise) and is the SAME
    // id every destination was just verified+consumed against, so this INSERT
    // lands under the id the client and the now-consumed destination rows
    // already agreed on.
    id: uploads.length > 0 ? body.claimId : undefined,
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

  // Uploads — metadata already validated AND the destination already
  // verified+consumed above, so every item here is known-good; recorded
  // per-item, not wrapped in the same transaction as claim creation. A
  // failure in THIS specific write (an unexpected DB error, not a bad key —
  // that case is already refused earlier) still leaves the customer with a
  // real, valid claim rather than none at all, which is the deliberately
  // accepted residual risk of this ordering.
  for (const upload of uploads) {
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
