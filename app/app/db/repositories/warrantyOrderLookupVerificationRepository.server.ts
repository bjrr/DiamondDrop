import { randomBytes } from "node:crypto";

import type { WarrantyOrderLookupVerificationEmailStatus } from "@prisma/client";

import { sha256Hex } from "~/domain/evidence/hash";
import { computeWarrantyOrderVerificationExpiry } from "~/domain/warranty/orderLookupVerification";

import { prisma } from "../client.server";

/**
 * D33 — persistence for the guest warranty-order-lookup verification token.
 * See `warranty_order_lookup_verification`'s schema.prisma doc comment for
 * the data-model reasoning; this module is the ONLY place the raw token is
 * ever handled outside the route that emails it.
 *
 * THE RAW TOKEN IS RETURNED EXACTLY ONCE, by `createWarrantyOrderLookupVerification`,
 * to be embedded in the verification email. It is never logged, never
 * returned from any other function, and never re-derivable from what is
 * stored (`tokenHash` is a one-way SHA-256 digest — see `sha256Hex`).
 *
 * REDEMPTION IS RE-FETCHED, NOT SERVED FROM HERE. `redeemWarrantyOrderLookupVerification`
 * returns only `orderRef`/`orderName`/`purchaserEmail` — the ORIGINAL
 * request's identifying facts. The caller (`apps.carat.warranty-order-
 * verify.tsx`) re-resolves the order's current line items from Shopify via
 * `WarrantyOrderLookupPort.findOrderByGid`, rather than trusting whatever
 * line items existed when the lookup was first requested — an order can
 * change between request and redemption inside the (short) verification
 * window, and a customer selecting an item that Shopify no longer agrees is
 * on that order would be a worse failure mode than one extra API call.
 */

const RAW_TOKEN_BYTES = 32; // 256 bits of entropy — matches WarrantyClaim's own high-entropy reference generation in spirit, but larger, since this token is a bearer credential, not a human-typed reference.

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

export interface CreateWarrantyOrderLookupVerificationInput {
  orderRef: string;
  orderName: string;
  purchaserEmail: string;
}

export interface CreateWarrantyOrderLookupVerificationResult {
  id: string;
  /** The RAW token — embed it in the verification link. Never persisted in this form; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export async function createWarrantyOrderLookupVerification(
  input: CreateWarrantyOrderLookupVerificationInput
): Promise<CreateWarrantyOrderLookupVerificationResult> {
  const token = generateRawToken();
  const tokenHash = sha256Hex(token);
  const now = new Date();
  const expiresAt = computeWarrantyOrderVerificationExpiry(now);

  const row = await prisma.warrantyOrderLookupVerification.create({
    data: {
      tokenHash,
      orderRef: input.orderRef,
      orderName: input.orderName,
      purchaserEmail: input.purchaserEmail,
      expiresAt,
    },
    select: { id: true },
  });

  return { id: row.id, token, expiresAt };
}

/**
 * Deliberate anti-timing-oracle approximation for the guest lookup route's
 * "no match" branch (see that route's own comment). Performs a Postgres
 * round trip — a `count()`, i.e. a READ — so a miss does not resolve
 * "for free" purely because it skipped talking to the database at all. This
 * is NOT claimed to be the same cost or lock/WAL shape as
 * `createWarrantyOrderLookupVerification`'s INSERT (a write costs more, and
 * the match branch also does other synchronous work a `count()` does not —
 * see the route's own comment). The dominant cost either way is the shared
 * Shopify Admin API round trip that happens before this is ever called; this
 * narrows the remaining, smaller gap without pretending to close it exactly.
 */
export async function performDummyWarrantyOrderLookupRoundTrip(): Promise<void> {
  await prisma.warrantyOrderLookupVerification.count();
}

export interface RecordWarrantyOrderLookupVerificationEmailOutcomeInput {
  verificationId: string;
  status: WarrantyOrderLookupVerificationEmailStatus;
  /** Only meaningful when `status = "sent"` — enforced by `warranty_order_lookup_verification_email_message_id_only_when_sent`. */
  providerMessageId?: string | null;
  attemptedAt?: Date;
}

/**
 * THE DURABLE RECORD of the fire-and-forget verification email's outcome —
 * team-lead review note on task #26. Mirrors `BankPaymentOrder`'s
 * cancellation-email columns exactly: a support agent looking at THIS row
 * must be able to tell "sent" apart from "attempted and failed" apart from
 * "never attempted because unconfigured" without cross-referencing logs.
 *
 * CALLED FROM THE SAME FIRE-AND-FORGET PATH the route already uses for the
 * send itself (`apps.carat.warranty-order-lookup.tsx`'s `dispatchVerificationEmail`),
 * and — critically — only AFTER the HTTP response has already been returned
 * to the caller. This function is never awaited by anything the response
 * waits on, so it cannot reintroduce the timing side-channel the route's own
 * module comment describes. The caller wraps this in a try/catch and never
 * lets a failure here propagate — a failure to RECORD the outcome must never
 * become a reason the customer's original lookup request fails; it already
 * succeeded by the time this runs.
 */
export async function recordWarrantyOrderLookupVerificationEmailOutcome(
  input: RecordWarrantyOrderLookupVerificationEmailOutcomeInput
): Promise<void> {
  await prisma.warrantyOrderLookupVerification.update({
    where: { id: input.verificationId },
    data: {
      verificationEmailStatus: input.status,
      verificationEmailProviderMessageId: input.providerMessageId ?? null,
      verificationEmailAttemptedAt: input.attemptedAt ?? new Date(),
    },
  });
}

export type RedeemWarrantyOrderLookupVerificationResult =
  | { outcome: "invalid" }
  | { outcome: "expired" }
  | { outcome: "already_used" }
  | { outcome: "success"; orderRef: string; orderName: string; purchaserEmail: string };

type WarrantyOrderLookupVerificationRow = { consumedAt: Date | null; expiresAt: Date; orderRef: string; orderName: string; purchaserEmail: string };

/** Shared by `peekWarrantyOrderLookupVerification` and `redeemWarrantyOrderLookupVerification`'s follow-up-read path — one classification, not two that could drift apart. */
function classifyWarrantyOrderLookupVerificationRow(
  row: WarrantyOrderLookupVerificationRow | null,
  now: Date
): { outcome: "invalid" } | { outcome: "expired" } | { outcome: "already_used" } | { outcome: "active_or_success"; row: WarrantyOrderLookupVerificationRow } {
  if (!row) return { outcome: "invalid" };
  if (row.consumedAt) return { outcome: "already_used" };
  if (row.expiresAt <= now) return { outcome: "expired" };
  return { outcome: "active_or_success", row };
}

export type PeekWarrantyOrderLookupVerificationResult =
  | { outcome: "invalid" }
  | { outcome: "expired" }
  | { outcome: "already_used" }
  | { outcome: "active"; orderRef: string; orderName: string; purchaserEmail: string };

/**
 * READ-ONLY classification of a token by its RAW value — does NOT consume
 * it. Exists so the caller (`apps.carat.warranty-order-verify.tsx`) can
 * learn WHICH order to re-fetch from Shopify BEFORE spending the token's one
 * use, per the team-lead review note on task #26's follow-up: consuming
 * before confirming Shopify can actually answer meant a transient Shopify
 * outage permanently stranded the customer — a real order lookup failure and
 * a burned single-use link, from one blip. See `redeemWarrantyOrderLookupVerification`'s
 * own comment for why the ATOMIC UPDATE, not this read, remains the only
 * thing that can ever change `consumed_at` — this function changes nothing.
 */
export async function peekWarrantyOrderLookupVerification(rawToken: string): Promise<PeekWarrantyOrderLookupVerificationResult> {
  const tokenHash = sha256Hex(rawToken);
  const row = await prisma.warrantyOrderLookupVerification.findUnique({ where: { tokenHash } });
  const classified = classifyWarrantyOrderLookupVerificationRow(row, new Date());
  if (classified.outcome !== "active_or_success") return classified;
  return { outcome: "active", orderRef: classified.row.orderRef, orderName: classified.row.orderName, purchaserEmail: classified.row.purchaserEmail };
}

/**
 * Atomically redeems a token by its RAW value: hashes it, then issues ONE
 * conditional UPDATE (`WHERE token_hash = ? AND consumed_at IS NULL AND
 * expires_at > now()`) that can succeed for at most one caller no matter how
 * many redemption attempts race on the same token — Postgres serializes
 * concurrent UPDATEs to the same row, so exactly one gets `count === 1` and
 * every other racing caller gets `count === 0` and therefore `already_used`.
 * This is read-then-write in appearance only; the WRITE's own WHERE clause
 * is the actual race-safe check, not a preceding SELECT (a preceding read
 * would be exactly the TOCTOU gap the assigning message called out).
 *
 * CALL THIS ONLY AFTER `apps.carat.warranty-order-verify.tsx` has already
 * confirmed, via `peekWarrantyOrderLookupVerification` PLUS a successful
 * Shopify re-fetch, that it can actually hand back real order data — see
 * that route's own comment for the full ordering and why moving THIS call to
 * be the LAST step (not the first) is what stops a transient Shopify failure
 * from burning a token that was never actually redeemed for anything. This
 * function's own atomicity guarantee is unchanged by that reordering: it is
 * still the ONLY place `consumed_at` is ever set, still via one conditional
 * UPDATE, so two callers racing to reach this point (both having peeked
 * "active" and both having independently re-fetched from Shopify) still
 * resolve to exactly one success — see the concurrency test for both this
 * function directly and the route's own end-to-end ordering.
 *
 * The follow-up read (only reached when the UPDATE did not affect a row) is
 * purely to produce a more useful error for someone who already possesses a
 * real, high-entropy token — not a security-relevant lookup, since knowing
 * simply "invalid vs. expired vs. already-used" for a token you already hold
 * reveals nothing about any OTHER order or email address.
 */
export async function redeemWarrantyOrderLookupVerification(
  rawToken: string
): Promise<RedeemWarrantyOrderLookupVerificationResult> {
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();

  const updated = await prisma.warrantyOrderLookupVerification.updateMany({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  if (updated.count === 1) {
    const row = await prisma.warrantyOrderLookupVerification.findUniqueOrThrow({ where: { tokenHash } });
    return { outcome: "success", orderRef: row.orderRef, orderName: row.orderName, purchaserEmail: row.purchaserEmail };
  }

  // BY ELIMINATION: the UPDATE above already excludes any row that is both
  // unconsumed AND unexpired (that combination is exactly its WHERE clause,
  // so it would have matched and returned above). Reaching `active_or_success`
  // here would mean the row changed between the UPDATE and this SELECT in a
  // way that made it MORE valid, which cannot happen — `consumed_at` only
  // ever moves from null to set, never back, and `expires_at` never moves at
  // all. Treated as `expired` only as a defensive fallback that can never
  // wrongly report a consumption that did not happen; it should be
  // unreachable in practice.
  const existing = await prisma.warrantyOrderLookupVerification.findUnique({ where: { tokenHash } });
  const classified = classifyWarrantyOrderLookupVerificationRow(existing, now);
  return classified.outcome === "active_or_success" ? { outcome: "expired" } : classified;
}
