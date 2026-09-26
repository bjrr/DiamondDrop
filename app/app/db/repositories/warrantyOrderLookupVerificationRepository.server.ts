import { randomBytes } from "node:crypto";

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

export type RedeemWarrantyOrderLookupVerificationResult =
  | { outcome: "invalid" }
  | { outcome: "expired" }
  | { outcome: "already_used" }
  | { outcome: "success"; orderRef: string; orderName: string; purchaserEmail: string };

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

  const existing = await prisma.warrantyOrderLookupVerification.findUnique({ where: { tokenHash } });
  if (!existing) return { outcome: "invalid" };
  if (existing.consumedAt) return { outcome: "already_used" };
  return { outcome: "expired" };
}
