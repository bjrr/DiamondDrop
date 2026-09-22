import type { BankPaymentMethod as PrismaBankPaymentMethod, Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { getVariantsAvailability } from "~/shopify/metafields/variantAvailability.server";
import type { DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

import { completeBankPaymentOrder } from "./completeOrder.server";
import { chargedUnitPriceMinorUnits, type VerificationSubmission } from "./verification";

/**
 * Manual Bank Payment verification — the DATABASE/SHOPIFY-FACING half (owner
 * §23, spec §5.4/§14, phase 2C-c criteria 87-91, 103-104). Pure decision
 * logic (validation, the expected-total sum, the amount comparison, the
 * closed method enum) lives in `verification.ts` and is unit-tested there
 * with no database; this file is the thin, integration-tested layer that
 * turns those decisions into committed rows, audit evidence and a completed
 * Shopify order.
 *
 * "VERIFYING ADMIN" IS RECORDED AS A TYPED IDENTIFIER, NOT AN AUTHENTICATED
 * ONE, AND THAT IS A KNOWN WEAKNESS, NOT AN OVERSIGHT. This app authenticates
 * to Shopify with an OFFLINE session token (`app/shopify.server.ts`, D13),
 * which identifies the SHOP, not the individual staff member operating the
 * embedded admin session — Shopify does not hand this app a per-user
 * identity on an offline token. `bankPaymentOrder.verifiedBy` is therefore a
 * free-typed name the person enters themselves: weaker evidence than an
 * authenticated identity, because nothing stops a different person from
 * typing someone else's name. `shop` (recorded on every audit event this
 * module writes, as `actorRef`) is the one part of "who" that IS
 * authenticated. Real per-user attribution needs an ONLINE session token —
 * recorded as a follow-up for the architect, spec §15 (alongside F-2C-1
 * through F-2C-3).
 */

export class BankPaymentOrderNotFoundError extends Error {
  constructor(bankPaymentOrderId: string) {
    super(`bank payment order ${bankPaymentOrderId} does not exist`);
    this.name = "BankPaymentOrderNotFoundError";
  }
}

/**
 * Thrown only when an order was NEVER verified and is not `open` — a genuine
 * refusal (e.g. the guarantee sweep cancelled it between page load and
 * submit), never a duplicate. A duplicate submission of an ALREADY-verified
 * order takes the idempotent success path instead — see
 * `verifyAndCompleteBankPaymentOrder`.
 */
export class BankPaymentOrderNotOpenForVerificationError extends Error {
  constructor(bankPaymentOrderId: string, status: string) {
    super(`bank payment order ${bankPaymentOrderId} is ${status}; only an open order can be verified`);
    this.name = "BankPaymentOrderNotOpenForVerificationError";
  }
}

/** `"gold 14k, Comfort Fit 6.5-8"` — never null. Restated from `adminAlertEpisodes.server.ts`'s private, unexported helper of the same shape rather than imported, since that module is owned outside this task's file glob. */
function describeVariant(variant: { metal: string; purity: string; band: { label: string } | null }): string {
  const metalAndPurity = `${variant.metal} ${variant.purity}`;
  return variant.band ? `${metalAndPurity}, ${variant.band.label}` : metalAndPurity;
}

export interface BankPaymentOrderLineView {
  readonly id: string;
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly eligibleAtQuoteTime: boolean;
  readonly quotedBankPaymentPriceMinorUnits: bigint;
  readonly quotedRegularCardPriceMinorUnits: bigint;
  /** Bank price if `eligibleAtQuoteTime`, card price otherwise — what this line actually charges (owner §18). */
  readonly chargedUnitPriceMinorUnits: bigint;
  readonly currency: string;
}

export interface BankPaymentOrderDetail {
  readonly id: string;
  readonly status: "open" | "cancelled" | "completed";
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: Date;
  readonly guaranteeExpiresAt: Date;
  readonly verifiedAt: Date | null;
  readonly verifiedBy: string | null;
  readonly verifiedPaymentAmountMinorUnits: bigint | null;
  readonly verifiedPaymentCurrency: string | null;
  readonly verifiedPaymentMethod: PrismaBankPaymentMethod | null;
  readonly verifiedPaymentReference: string | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly lines: readonly BankPaymentOrderLineView[];
}

/** Never throws on a missing row — returns `null` so the route can render its own "not found" page instead of a crash. */
export async function loadBankPaymentOrderForVerification(id: string): Promise<BankPaymentOrderDetail | null> {
  const order = await prisma.bankPaymentOrder.findUnique({
    where: { id },
    include: {
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          masterVariant: {
            select: {
              id: true,
              metal: true,
              purity: true,
              shopifyVariantGid: true,
              band: { select: { label: true } },
              masterProduct: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!order) return null;

  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt,
    guaranteeExpiresAt: order.guaranteeExpiresAt,
    verifiedAt: order.verifiedAt,
    verifiedBy: order.verifiedBy,
    verifiedPaymentAmountMinorUnits: order.verifiedPaymentAmountMinorUnits,
    verifiedPaymentCurrency: order.verifiedPaymentCurrency,
    verifiedPaymentMethod: order.verifiedPaymentMethod,
    verifiedPaymentReference: order.verifiedPaymentReference,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    lines: order.lines.map((line) => ({
      id: line.id,
      masterVariantId: line.masterVariantId,
      shopifyVariantGid: line.masterVariant.shopifyVariantGid,
      productTitle: line.masterVariant.masterProduct.name,
      variantLabel: describeVariant(line.masterVariant),
      quantity: line.quantity,
      eligibleAtQuoteTime: line.eligibleAtQuoteTime,
      quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
      chargedUnitPriceMinorUnits: chargedUnitPriceMinorUnits(line),
      currency: line.currency,
    })),
  };
}

export interface LineAvailability {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  /**
   * `null` means "could not be confirmed" (no gid on file, or Shopify's
   * answer omitted this id — a deleted product/variant) and is DELIBERATELY
   * distinct from `false`. Criterion 103 requires an honest re-query, not a
   * default; a caller must treat `null` with the same caution as `false`,
   * never as `true`.
   */
  readonly availableForSale: boolean | null;
}

/**
 * Criterion 103: re-queries EVERY line's current `availableForSale` from
 * Shopify, live, at verification time — never a cached or stale value.
 * Criterion 104: this result is for DISPLAY only. Nothing in this module (or
 * `verifyAndCompleteBankPaymentOrder` below) refuses verification because a
 * line reads unavailable.
 */
export async function checkLinesAvailability(
  admin: AdminGraphqlClient,
  lines: readonly { masterVariantId: string; shopifyVariantGid: string | null }[]
): Promise<LineAvailability[]> {
  const gids = lines
    .map((line) => line.shopifyVariantGid)
    .filter((gid): gid is string => gid !== null);

  const availability = gids.length > 0 ? await getVariantsAvailability(admin, gids) : new Map<string, boolean>();

  return lines.map((line) => ({
    masterVariantId: line.masterVariantId,
    shopifyVariantGid: line.shopifyVariantGid,
    availableForSale: line.shopifyVariantGid ? availability.get(line.shopifyVariantGid) ?? null : null,
  }));
}

export interface BankPaymentOrderSummary {
  readonly id: string;
  readonly status: "open" | "cancelled" | "completed";
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: Date;
  readonly guaranteeExpiresAt: Date;
  readonly verifiedAt: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_RESULT_LIMIT = 50;

function toSummary(order: {
  id: string;
  status: "open" | "cancelled" | "completed";
  customerEmail: string;
  shopifyDraftOrderGid: string;
  shopifyOrderGid: string | null;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  verifiedAt: Date | null;
}): BankPaymentOrderSummary {
  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt,
    guaranteeExpiresAt: order.guaranteeExpiresAt,
    verifiedAt: order.verifiedAt,
  };
}

/**
 * Locates a Bank Payment order (the assigning message's "authorised staff
 * must be able to locate a Bank Payment order"). A blank query lists every
 * currently OPEN order — the ones still needing a verification decision —
 * newest first. A non-blank query matches the customer email, the Shopify
 * draft-order gid, the Shopify order gid (once completed), or (only when it
 * parses as a UUID) this app's own order id — so a staff member can paste
 * whichever identifier they have to hand.
 */
export async function searchBankPaymentOrders(query: string): Promise<BankPaymentOrderSummary[]> {
  const trimmed = query.trim();

  if (trimmed === "") {
    const rows = await prisma.bankPaymentOrder.findMany({
      where: { status: "open" },
      orderBy: { quotedAt: "desc" },
      take: SEARCH_RESULT_LIMIT,
    });
    return rows.map(toSummary);
  }

  const orConditions: Prisma.BankPaymentOrderWhereInput[] = [
    { customerEmail: { contains: trimmed, mode: "insensitive" } },
    { shopifyDraftOrderGid: { contains: trimmed, mode: "insensitive" } },
    { shopifyOrderGid: { contains: trimmed, mode: "insensitive" } },
  ];
  if (UUID_PATTERN.test(trimmed)) {
    orConditions.push({ id: trimmed });
  }

  const rows = await prisma.bankPaymentOrder.findMany({
    where: { OR: orConditions },
    orderBy: { quotedAt: "desc" },
    take: SEARCH_RESULT_LIMIT,
  });
  return rows.map(toSummary);
}

export interface VerifyAndCompleteInput {
  readonly bankPaymentOrderId: string;
  readonly submission: VerificationSubmission;
  /** This app's single connected shop domain — the authenticated half of "who verified this"; see this module's header comment. */
  readonly shop: string;
  readonly draftOrderPort: DraftOrderPort;
  /**
   * What the verifying admin was actually shown before confirming
   * (criterion 103) — carried through into the audit event as evidence of
   * what informed the decision, not re-queried a second time here. A blank
   * array is legitimate (an order whose lines all lack a Shopify variant
   * gid, or a genuinely empty availability check) and is recorded as such.
   */
  readonly availabilityShownToAdmin: readonly LineAvailability[];
  readonly now?: Date;
}

export interface VerifyAndCompleteResult {
  readonly outcome: "verified_and_completed" | "already_verified";
  readonly bankPaymentOrderId: string;
  readonly shopifyOrderGid: string;
  readonly orderName: string | null;
}

/**
 * The single entry point that turns a validated verification submission into
 * a committed row, its audit evidence, and a completed Shopify order.
 *
 * IDEMPOTENT BY COMPARE-AND-SET (criterion 88), the identical idiom
 * `completeOrder.server.ts` uses for `shopifyOrderGid`: the verification
 * write only succeeds if `verifiedAt IS NULL` (and the order is still
 * `open`) at the instant of the update, so two submissions racing each other
 * cannot both win. "Somebody got there first" is treated as SUCCESS — the
 * order is already verified, so this call proceeds straight to completion
 * (which is itself idempotent) — never as an error. A genuine refusal
 * (never verified, and not open) is the one case that throws.
 */
export async function verifyAndCompleteBankPaymentOrder(
  input: VerifyAndCompleteInput
): Promise<VerifyAndCompleteResult> {
  const now = input.now ?? new Date();

  const written = await prisma.bankPaymentOrder.updateMany({
    where: { id: input.bankPaymentOrderId, verifiedAt: null, status: "open" },
    data: {
      verifiedPaymentAmountMinorUnits: input.submission.amountReceivedMinorUnits,
      verifiedPaymentCurrency: input.submission.currency,
      verifiedPaymentMethod: input.submission.method,
      verifiedPaymentReference: input.submission.reference,
      verifiedAt: now,
      verifiedBy: input.submission.verifiedBy,
    },
  });

  const wonTheRace = written.count === 1;

  if (wonTheRace) {
    await createAuditEvent({
      actorType: "staff",
      actorRef: input.shop,
      action: "bank_payment_order.verified",
      entityType: "bank_payment_order",
      entityId: input.bankPaymentOrderId,
      after: {
        verifiedPaymentAmountMinorUnits: input.submission.amountReceivedMinorUnits.toString(),
        verifiedPaymentCurrency: input.submission.currency,
        verifiedPaymentMethod: input.submission.method,
        verifiedPaymentReference: input.submission.reference,
        verifiedAt: now.toISOString(),
        verifiedBy: input.submission.verifiedBy,
        // Evidence of what the admin was shown BEFORE confirming (criterion
        // 103) — durable, not merely rendered-and-discarded.
        availabilityShownToAdmin: input.availabilityShownToAdmin.map((line) => ({
          masterVariantId: line.masterVariantId,
          shopifyVariantGid: line.shopifyVariantGid,
          availableForSale: line.availableForSale,
        })),
      },
    });
  } else {
    const current = await prisma.bankPaymentOrder.findUnique({ where: { id: input.bankPaymentOrderId } });
    if (!current) {
      throw new BankPaymentOrderNotFoundError(input.bankPaymentOrderId);
    }
    if (current.verifiedAt === null) {
      // Never verified AND not open — a genuine refusal, not a duplicate
      // (e.g. the guarantee sweep cancelled it between page load and
      // submit). No audit event: nothing changed, and the caller surfaces
      // this as a real error.
      throw new BankPaymentOrderNotOpenForVerificationError(input.bankPaymentOrderId, current.status);
    }
    // A genuine duplicate: already verified by an earlier call. Recorded
    // distinctly from `.verified` so the audit trail shows the attempt
    // without a second write to the authoritative verification fields.
    await createAuditEvent({
      actorType: "staff",
      actorRef: input.shop,
      action: "bank_payment_order.verify_duplicate_ignored",
      entityType: "bank_payment_order",
      entityId: input.bankPaymentOrderId,
      reason: `already verified at ${current.verifiedAt.toISOString()} by "${current.verifiedBy ?? "unknown"}" — this submission changed nothing`,
    });
  }

  const completed = await completeBankPaymentOrder({
    bankPaymentOrderId: input.bankPaymentOrderId,
    port: input.draftOrderPort,
  });

  // Recorded only on the call that ACTUALLY completed the order — a replay
  // (`alreadyCompleted: true`) writes no second `.completed` event, so the
  // audit trail shows exactly one completion per order, matching criterion
  // 88's "completes one order" at the evidence layer too.
  if (!completed.alreadyCompleted) {
    await createAuditEvent({
      actorType: "staff",
      actorRef: input.shop,
      action: "bank_payment_order.completed",
      entityType: "bank_payment_order",
      entityId: input.bankPaymentOrderId,
      after: {
        shopifyOrderGid: completed.shopifyOrderGid,
        orderName: completed.orderName,
      },
    });
  }

  return {
    outcome: wonTheRace ? "verified_and_completed" : "already_verified",
    bankPaymentOrderId: input.bankPaymentOrderId,
    shopifyOrderGid: completed.shopifyOrderGid,
    orderName: completed.orderName,
  };
}
