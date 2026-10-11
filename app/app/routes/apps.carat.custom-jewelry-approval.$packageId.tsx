import type { LoaderFunctionArgs } from "react-router";

import { findApprovalPackageForCustomer } from "~/db/repositories/customJewelryApprovalRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_SALE_TEXT,
  CUSTOM_JEWELRY_SHIPPING_TEXT,
  CUSTOM_JEWELRY_WARRANTY_TEXT,
} from "~/domain/customjewelry/finalApprovalCopy";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/custom-jewelry-approval/:packageId
 *
 * The customer-specific final approval package, served through Shopify's App
 * Proxy so it appears on the shop's own domain. The theme renders it; this
 * endpoint is the authority on what it contains.
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route.
 *
 * ============================================================================
 * THIS CUSTOMER, THIS PROJECT. NOTHING ELSE.
 * ============================================================================
 * Owner requirement: "The customer must only be able to view and approve their
 * own project." Two gates, in this order:
 *
 *   1. the App Proxy signature — an unsigned request is a direct hit on our
 *      origin pretending to be a storefront, and this endpoint reveals a
 *      customer's design, specifications and price;
 *   2. an AUTHENTICATED customer, and the package is then located by a query
 *      JOINED on that customer. There is no path that loads a package and
 *      compares afterwards.
 *
 * A package belonging to someone else and a package that does not exist return
 * the SAME 404. Distinguishing them would turn this into an oracle for
 * discovering other people's project ids, and a project id is enough to start
 * guessing.
 *
 * ============================================================================
 * EVERY FIGURE COMES FROM THE FROZEN PACKAGE
 * ============================================================================
 * Not from the project, not from today's prices, not recomputed. The customer
 * is approving a specific version, and the version is what it says it is. A
 * price re-derived at display time could differ from the one they approve a
 * second later.
 *
 * BOTH BASES ARE SHOWN, SIDE BY SIDE, DELIBERATELY. The owner's instruction:
 * "Do not compare Card-vs-Bank behind the scenes and silently choose one. Show
 * the applicable price/benefit clearly for the payment path they select." So
 * the response carries the card figures and the bank figures as separate,
 * clearly named objects and picks neither.
 *
 * WHAT THIS NEVER RETURNS: no landed cost, no margin, no supplier data, no
 * other customer's anything, and no internal percentage. The deposit is a
 * CREDIT line, never a discount.
 */

function notFound() {
  // The same answer for a foreign package and a nonexistent one. See the
  // header: the distinction is an oracle.
  return Response.json({ error: "not_found" }, { status: 404 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

/** Minor units to a decimal string by integer arithmetic. Never a float. */
function decimalString(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET
  );
  if (!verified) {
    logger.warn("custom_jewelry_approval.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // NO GUEST FINAL APPROVAL (owner requirement, and
  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md). Checked before the database is
  // touched, so an unauthenticated caller cannot use response timing to learn
  // whether a package id exists.
  if (!loggedInCustomerId) {
    logger.warn("custom_jewelry_approval.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerRef = normalizeCustomerGid(loggedInCustomerId);

  const packageId = params.packageId;
  if (!packageId) return notFound();

  const pkg = await findApprovalPackageForCustomer({ packageId, customerRef });
  if (!pkg) {
    logger.info("custom_jewelry_approval.not_visible", { packageId, customerRef });
    return notFound();
  }

  // THE POLICY MUST EXIST BEFORE WE OFFER AN APPROVAL. A page that invites a
  // customer to accept an acknowledgment we cannot record is a page that loses
  // their approval — the same fail-closed guard the Group Buy and RMA
  // acknowledgment surfaces use, and the one whose absence caused a live
  // Luxury Steals 500.
  const policy = await getLatestPolicyVersion(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG);
  if (!policy) {
    logger.error("custom_jewelry_approval.acknowledgment_copy_pending_approval", { packageId });
    return Response.json({ error: "acknowledgment_copy_pending_approval" }, { status: 503 });
  }

  return Response.json(
    {
      packageId: pkg.id,
      projectId: pkg.projectId,
      version: pkg.version,
      status: pkg.status,

      /* The design and specification, exactly as frozen. Absent keys mean the
         field does not apply — a pendant has no ring size — which the theme
         renders as absence rather than as an empty row. */
      specification: {
        metalType: pkg.metalType,
        metalColor: pkg.metalColor,
        ...(pkg.centerStone !== null ? { centerStone: pkg.centerStone } : {}),
        ...(pkg.accentStones !== null ? { accentStones: pkg.accentStones } : {}),
        ...(pkg.dimensions !== null ? { dimensions: pkg.dimensions } : {}),
        ...(pkg.ringSize !== null ? { ringSize: pkg.ringSize } : {}),
        ...(pkg.engraving !== null ? { engraving: pkg.engraving } : {}),
        ...(pkg.constructionNotes !== null ? { constructionNotes: pkg.constructionNotes } : {}),
        ...(pkg.agreedCustomizations !== null ? { agreedCustomizations: pkg.agreedCustomizations } : {}),
      },

      /* CAD, renderings and final design images, as references the theme
         resolves to signed URLs through the existing upload machinery. */
      media: pkg.mediaReferences,

      /* ONLY WHAT IS ACTUALLY APPROVED. Null when no timeline has been agreed,
         which is honest — the owner forbade unsupported turnaround promises,
         and a default sentence here is exactly how one would appear. */
      approvedTimeline: pkg.approvedTimelineText,

      /* ============================================================
         BOTH BASES, NEITHER CHOSEN FOR THEM
         ============================================================ */
      currency: pkg.currency,
      card: {
        price: decimalString(pkg.regularCardPriceMinorUnits),
        depositCredit: decimalString(pkg.depositCreditMinorUnits),
        balanceDue: decimalString(pkg.regularCardBalanceDueMinorUnits),
        priceMinorUnits: pkg.regularCardPriceMinorUnits.toString(),
        balanceDueMinorUnits: pkg.regularCardBalanceDueMinorUnits.toString(),
      },
      bankPayment: {
        price: decimalString(pkg.bankPaymentPriceMinorUnits),
        depositCredit: decimalString(pkg.depositCreditMinorUnits),
        balanceDue: decimalString(pkg.bankPaymentBalanceDueMinorUnits),
        priceMinorUnits: pkg.bankPaymentPriceMinorUnits.toString(),
        balanceDueMinorUnits: pkg.bankPaymentBalanceDueMinorUnits.toString(),
      },
      deposit: {
        paid: decimalString(pkg.depositPaidMinorUnits),
        credited: decimalString(pkg.depositCreditMinorUnits),
        /* A CREDIT, never a discount. The word matters: a discount reduces the
           price, a credit reduces what is collected while the price stands. */
        text: CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT,
      },

      /* The material terms, from the pinned copy module. The theme must render
         these verbatim rather than restating them. */
      terms: {
        finalSale: CUSTOM_JEWELRY_FINAL_SALE_TEXT,
        warranty: CUSTOM_JEWELRY_WARRANTY_TEXT,
        shipping: CUSTOM_JEWELRY_SHIPPING_TEXT,
        finalSaleCopyVersion: pkg.finalSaleCopyVersion,
        warrantyCopyVersion: pkg.warrantyCopyVersion,
      },

      /* The acknowledgment the customer must affirmatively accept. The EXACT
         text and the EXACT button caption, so the evidence row cannot describe
         words or a button they never saw. */
      acknowledgment: {
        exactText: CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
        affirmativeActionLabel: CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
        policySlug: policy.slug,
        policyVersion: policy.version,
        /* NEVER PRE-CHECKED. The theme must render an unchecked control; this
           flag exists so a reviewer reading the contract can see the
           requirement rather than inferring it from the absence of a default. */
        mustBeUnchecked: true,
      },

      /* Already approved? The theme shows the recorded approval rather than
         inviting a second one. */
      approval:
        pkg.approvedAt !== null
          ? {
              approvedAt: pkg.approvedAt.toISOString(),
              acknowledgmentPolicyVersion: pkg.approvalAcknowledgmentPolicyVersion,
            }
          : null,
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
