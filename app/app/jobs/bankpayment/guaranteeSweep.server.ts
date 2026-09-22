import { prisma } from "~/db/client.server";
import { dispatchAdminAlert } from "~/db/repositories/adminAlertDispatch.server";
import {
  decideGuaranteeOutcome,
  type GuaranteeCancellingLine,
  type GuaranteeDecision,
  type GuaranteeDecisionLine,
  type VariantPriceFacts,
} from "~/domain/bankpayment/guaranteeDecision";
import { buildGuaranteeCancellationEmail } from "~/domain/bankpayment/guaranteeCancellationEmail";
import { resolveEmailPort as resolveRealEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { logger } from "~/lib/logger.server";

import { gatherVariantPriceFacts } from "./guaranteeFacts.server";

/**
 * The 24-hour guarantee sweep (spec §13/§14, criteria 78-82, 96, 100-102).
 *
 * CADENCE IS THE CALLER'S JOB (criterion 100). This function does not know
 * or care how often it runs — `app/routes/internal.jobs.bank-payment
 * -guarantee.tsx` is invoked HOURLY by the platform scheduler, exactly like
 * `internal.jobs.price-recalculation.tsx`'s own daily cadence is entirely
 * external to `runPriceRecalculation`. Encoding "hourly" here would be the
 * same mistake that route's own header comment warns against.
 *
 * IDEMPOTENT UNDER CONCURRENT/OVERLAPPING RUNS (criterion 101), the same way
 * `completeBankPaymentOrder` is: cancellation is a `updateMany` GUARDED on
 * `status: "open"` still being true at the moment of the write, never a
 * blind `update` by id. A losing concurrent caller's `count === 0` is a
 * successful idempotent no-op — the order IS cancelled, just not by this
 * call — and sends no second email.
 *
 * NEVER CANCELS ON ITS OWN FAILURE (criterion 102). Each order is processed
 * inside its own try/catch; a thrown error (including one gathering
 * `VariantPriceFacts`) leaves that order untouched — still `open`, still
 * fully payable at the quoted price if it arrives — and raises an admin
 * alert, rather than either cancelling defensively or aborting the whole
 * sweep and leaving every OTHER order unevaluated for another hour.
 */

export interface GuaranteeSweepSummary {
  /** ISO-8601 — the instant this sweep evaluated against. */
  now: string;
  ordersConsidered: number;
  cancelled: number;
  flagged: number;
  kept: number;
  /** An order the sweep could not evaluate at all — left untouched, admin alerted (criterion 102). */
  errored: number;
}

export interface GuaranteeSweepDeps {
  /** Defaults to `new Date()`. Injectable so the 24-hour boundary can be tested exactly. */
  now?: Date;
  /**
   * Defaults to the real `resolveEmailPort` (reads process env). Injectable
   * so a test can exercise `sent`/`failed`/`skipped_unconfigured` with a
   * fake `EmailPort` — same seam `dispatchAdminAlert` uses.
   */
  resolveEmailPort?: () => EmailPortResolution;
  /**
   * Defaults to the real `gatherVariantPriceFacts`. Injectable for the SAME
   * reason `SyncApprovedIntentDeps.port` is: a test proving criterion 102
   * ("one order failing must not abort the sweep") needs a genuine,
   * unpredictable-in-production failure mode — a thrown error while
   * gathering facts for one specific variant — that cannot be produced by
   * arranging ordinary fixture data, since every real query this function
   * issues is guarded by the schema's own foreign keys. A wrapper that
   * throws for a chosen variant and delegates to the real function
   * otherwise exercises the actual per-order try/catch in
   * `runGuaranteeSweep`, not a substitute for it.
   */
  gatherVariantPriceFacts?: typeof gatherVariantPriceFacts;
}

type EmailDeliveryOutcome = "sent" | "skipped_unconfigured" | "failed";

interface OpenOrderForSweep {
  id: string;
  status: string;
  customerEmail: string;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  verifiedAt: Date | null;
  lines: readonly { masterVariantId: string; quotedBankPaymentPriceMinorUnits: bigint }[];
}

type OrderOutcome = "kept" | "cancelled" | "flagged";

export async function runGuaranteeSweep(deps: GuaranteeSweepDeps = {}): Promise<GuaranteeSweepSummary> {
  const now = deps.now ?? new Date();
  const resolvePort = deps.resolveEmailPort ?? resolveRealEmailPort;
  const gatherFacts = deps.gatherVariantPriceFacts ?? gatherVariantPriceFacts;


  const openOrders: OpenOrderForSweep[] = await prisma.bankPaymentOrder.findMany({
    where: { status: "open" },
    select: {
      id: true,
      status: true,
      customerEmail: true,
      quotedAt: true,
      guaranteeExpiresAt: true,
      verifiedAt: true,
      lines: { select: { masterVariantId: true, quotedBankPaymentPriceMinorUnits: true } },
    },
  });

  let cancelled = 0;
  let flagged = 0;
  let kept = 0;
  let errored = 0;

  for (const order of openOrders) {
    try {
      const outcome = await processOneOrder(order, now, resolvePort, gatherFacts);
      if (outcome === "kept") kept += 1;
      else if (outcome === "cancelled") cancelled += 1;
      else flagged += 1;
    } catch (error) {
      errored += 1;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.error("bank_payment.guarantee_sweep_order_errored", {
        bankPaymentOrderId: order.id,
        error: errorName,
      });
      // Criterion 102: a failure to EVALUATE is not a reason to cancel. The
      // order is left exactly as it was found — this alert's own try/catch
      // (inside sendAdminAlert) means a notification failure here still
      // cannot turn into an uncaught rejection that would abort the loop.
      await sendAdminAlert(resolvePort, {
        subject: `[CaratForUs admin] Bank Payment guarantee sweep could not evaluate order ${order.id}`,
        text:
          `The guarantee sweep raised ${errorName} while evaluating bank payment order ${order.id}. ` +
          "The order has NOT been touched and remains open at its quoted price pending investigation.",
      });
    }
  }

  // Closing cleared alerts runs AFTER every order, and outside the per-order
  // try/catch, because it is keyed on episodes rather than orders — an
  // episode can have been cleared by something that never appears in this
  // run's order list at all.
  await resolveClearedGuaranteeAlerts(now, resolvePort, gatherFacts).catch((error) => {
    logger.error("bank_payment.guarantee_alert_resolve_pass_failed", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  });

  logger.info("bank_payment.guarantee_sweep_completed", {
    ordersConsidered: openOrders.length,
    cancelled,
    flagged,
    kept,
    errored,
  });

  return { now: now.toISOString(), ordersConsidered: openOrders.length, cancelled, flagged, kept, errored };
}

async function processOneOrder(
  order: OpenOrderForSweep,
  now: Date,
  resolvePort: () => EmailPortResolution,
  gatherFacts: typeof gatherVariantPriceFacts
): Promise<OrderOutcome> {
  const uniqueVariantIds = [...new Set(order.lines.map((line) => line.masterVariantId))];
  const factsByVariant = new Map<string, VariantPriceFacts>();
  for (const variantId of uniqueVariantIds) {
    factsByVariant.set(variantId, await gatherFacts(variantId, order.quotedAt));
  }

  const decisionLines: GuaranteeDecisionLine[] = order.lines.map((line) => ({
    masterVariantId: line.masterVariantId,
    quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
    // Populated for every id above — never undefined here.
    facts: factsByVariant.get(line.masterVariantId)!,
  }));

  const decision = decideGuaranteeOutcome({
    // The query above filters `status: "open"`, so this is always "open" in
    // practice; passed through rather than hardcoded so a future caller
    // that loosens the query cannot silently mis-evaluate a settled order.
    status: order.status as "open" | "cancelled" | "completed",
    paymentVerified: order.verifiedAt !== null,
    quotedAt: order.quotedAt,
    guaranteeExpiresAt: order.guaranteeExpiresAt,
    now,
    lines: decisionLines,
  });

  // Dedup/opened-vs-resolved bookkeeping for the "flag" alert channel (D22
  // review; criterion 102). Its own try/catch: a notification-plumbing
  // hiccup here must never block the CORE decision (cancel/keep) below from
  // being applied — same discipline `syncApprovedIntent.server.ts` uses
  // around its own `dispatchAdminAlert` calls.
  try {
    if (decision.action === "flag") {
      const unresolvable = decisionLines.find(
        (line) => line.facts.publishedBankPaymentPriceMinorUnits === null
      );
      // Guaranteed present by decideGuaranteeOutcome's step 3; the guard is
      // here so a future change to that ordering fails loudly rather than
      // alerting against the wrong variant.
      if (unresolvable?.facts.unresolvableEpisodeId) {
        await openGuaranteeAlertForEpisode(
          unresolvable.facts.unresolvableEpisodeId,
          unresolvable.masterVariantId,
          decision.reason,
          // The episode's own firstFailedAt when a real episode row backs
          // it; falls back to this order's guaranteeExpiresAt only in the
          // rare case `gatherVariantPriceFacts` had no episode to point at
          // (see its own doc comment) — an approximation, but a variant in
          // that state has no episode that could flap in the first place.
          unresolvable.facts.unresolvableEpisodeFirstFailedAt ?? order.guaranteeExpiresAt,
          now,
          resolvePort
        );
      }
    }
  } catch (alertError) {
    logger.error("bank_payment.guarantee_alert_sync_failed", {
      bankPaymentOrderId: order.id,
      error: alertError instanceof Error ? alertError.name : "UnknownError",
    });
  }

  if (decision.action === "keep") {
    return "kept";
  }

  if (decision.action === "flag") {
    logger.warn("bank_payment.guarantee_sweep_flagged", {
      bankPaymentOrderId: order.id,
      reason: decision.reason,
    });
    return "flagged";
  }

  // action === "cancel"
  const cancellationReason = buildCancellationReason(decision.cancellingLines ?? []);
  const claimed = await prisma.bankPaymentOrder.updateMany({
    where: { id: order.id, status: "open" },
    data: { status: "cancelled", cancelledAt: now, cancellationReason },
  });

  if (claimed.count === 0) {
    // Lost the race to a concurrent sweep run (or the order was settled by
    // something else in the interim). The order IS cancelled — just not by
    // this call — so this is a successful idempotent no-op, not an error,
    // and it must NOT send a second email (criterion 101).
    logger.info("bank_payment.guarantee_sweep_cancel_already_claimed", { bankPaymentOrderId: order.id });
    return "cancelled";
  }

  logger.warn("bank_payment.guarantee_sweep_cancelled", {
    bankPaymentOrderId: order.id,
    reason: decision.reason,
  });

  const email = buildGuaranteeCancellationEmail({
    bankPaymentOrderId: order.id,
    customerEmail: order.customerEmail,
  });
  const delivery = await sendCustomerEmail(resolvePort, order.customerEmail, email);

  // THE DECISION MADE EXPLICITLY FOR THIS TASK: the cancellation stands
  // regardless of whether the notification succeeded — protecting us from
  // honouring a withdrawn price must not depend on the mail server being
  // up. An undelivered cancellation email is a real duty left undischarged,
  // so it raises its own, separate admin alert loud enough for a human to
  // contact the customer by hand. "Cancelled" and "told them" are recorded
  // as two distinct facts (this log line plus the alert below), never
  // conflated into one.
  if (delivery !== "sent") {
    await sendAdminAlert(resolvePort, {
      subject: `[CaratForUs admin] Cancellation email NOT delivered — bank payment order ${order.id}`,
      text:
        `Bank payment order ${order.id} was cancelled (24-hour guarantee expired; price changed via a ` +
        `human-approved publication or override) but the customer cancellation email to ` +
        `${order.customerEmail} was NOT delivered (${delivery}). Please contact the customer directly.`,
    });
  }

  return "cancelled";
}

function buildCancellationReason(lines: readonly GuaranteeCancellingLine[]): string {
  const detail = lines
    .map(
      (line) =>
        `variant ${line.masterVariantId}: quoted ${line.quotedPriceMinorUnits} -> ` +
        `published ${line.publishedPriceMinorUnits} minor units`
    )
    .join("; ");
  return (
    "24-hour guarantee expired; at least one line's price changed via a human-approved publication " +
    `or override since the quote (D22): ${detail}`
  );
}

/**
 * THE ALERT IS KEYED ON THE FAILURE EPISODE, NOT ON THE ORDER, and that is a
 * correctness requirement rather than a preference.
 *
 * `admin_alert_notification` is unique on `(sourceKind, sourceId, event)`.
 * An order id outlives every episode, so keying on it permits exactly one
 * `opened` and one `resolved` for the whole life of the order: flag,
 * resolve, flag again, and the index silently refuses the second `opened`.
 * The order sits flagged and nobody is ever told — a worse failure than the
 * hourly repetition this dedupe replaced, because noise is visible and
 * silence is not.
 *
 * Episode ids are created fresh per episode, which is exactly why the
 * calculation- and sync-failure alerts already key on theirs. Keying the
 * same way makes a new suspension a new alert, automatically.
 *
 * THE ORDERS ARE NOT LOST. One episode can block several bank orders, and
 * the thing at risk is the order even though the thing to fix is the
 * episode. Every affected open order is named in the alert's reason, so one
 * alert carries the whole blast radius rather than naming whichever order
 * the sweep happened to reach first.
 */
async function hasOpenGuaranteeAlertForEpisode(episodeId: string): Promise<boolean> {
  const [opened, resolved] = await Promise.all([
    prisma.adminAlertNotification.findFirst({
      where: { sourceKind: "bank_payment_guarantee", sourceId: episodeId, event: "opened" },
      select: { id: true },
    }),
    prisma.adminAlertNotification.findFirst({
      where: { sourceKind: "bank_payment_guarantee", sourceId: episodeId, event: "resolved" },
      select: { id: true },
    }),
  ]);
  return opened !== null && resolved === null;
}

async function openGuaranteeAlertForEpisode(
  episodeId: string,
  masterVariantId: string,
  reason: string,
  flaggedSince: Date,
  now: Date,
  resolvePort: () => EmailPortResolution
): Promise<void> {
  if (await hasOpenGuaranteeAlertForEpisode(episodeId)) return;

  const affected = await prisma.bankPaymentOrder.findMany({
    where: { status: "open", lines: { some: { masterVariantId } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  await dispatchAdminAlert(
    {
      sourceKind: "bank_payment_guarantee",
      sourceId: episodeId,
      event: "opened",
      now,
      bankPaymentGuarantee: {
        masterVariantId,
        reason:
          `${reason} Blocking ${affected.length} open bank payment order(s): ` +
          `${affected.map((o) => o.id).join(", ")}.`,
        flaggedSince,
      },
    },
    { resolveEmailPort: resolvePort }
  );
}

/**
 * Resolution is a SEPARATE PASS over the alerts rather than a branch inside
 * the per-order loop, because an order that is no longer flagged no longer
 * knows which episode flagged it — its price resolved, so there is no
 * episode id left to look up. Walking the open alerts and asking "is this
 * episode's variant still unresolvable" answers the question from the only
 * side that still has both halves of it.
 */
async function resolveClearedGuaranteeAlerts(
  now: Date,
  resolvePort: () => EmailPortResolution,
  gatherFacts: typeof gatherVariantPriceFacts
): Promise<void> {
  const opened = await prisma.adminAlertNotification.findMany({
    where: { sourceKind: "bank_payment_guarantee", event: "opened" },
    select: { sourceId: true, masterVariantId: true, createdAt: true },
  });
  if (opened.length === 0) return;

  const resolved = await prisma.adminAlertNotification.findMany({
    where: {
      sourceKind: "bank_payment_guarantee",
      event: "resolved",
      sourceId: { in: opened.map((o) => o.sourceId) },
    },
    select: { sourceId: true },
  });
  const alreadyResolved = new Set(resolved.map((r) => r.sourceId));

  for (const alert of opened) {
    if (alreadyResolved.has(alert.sourceId)) continue;
    try {
      // `quotedAt` is irrelevant here — only the published price is being
      // read — so epoch is passed rather than inventing a meaningful date.
      const facts = await gatherFacts(alert.masterVariantId, new Date(0));
      if (facts.publishedBankPaymentPriceMinorUnits === null) continue;

      await dispatchAdminAlert(
        {
          sourceKind: "bank_payment_guarantee",
          sourceId: alert.sourceId,
          event: "resolved",
          now,
          bankPaymentGuarantee: {
            masterVariantId: alert.masterVariantId,
            reason: "the variant's published price is resolvable again; affected bank orders can be evaluated normally",
            flaggedSince: alert.createdAt,
          },
        },
        { resolveEmailPort: resolvePort }
      );
    } catch (error) {
      // One stuck alert must not stop the others being closed, and must
      // never propagate into the sweep's own result.
      logger.error("bank_payment.guarantee_alert_resolve_failed", {
        sourceId: alert.sourceId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

async function sendCustomerEmail(
  resolvePort: () => EmailPortResolution,
  toEmail: string,
  content: { subject: string; text: string }
): Promise<EmailDeliveryOutcome> {
  const resolution = resolvePort();
  if (!resolution.configured) {
    logger.error("bank_payment.guarantee_cancellation_email_unconfigured", { reason: resolution.reason });
    return "skipped_unconfigured";
  }
  try {
    await resolution.port.send({ from: resolution.from, to: [toEmail], subject: content.subject, text: content.text });
    return "sent";
  } catch (error) {
    logger.error("bank_payment.guarantee_cancellation_email_failed", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return "failed";
  }
}

/**
 * A direct, best-effort admin notification with NO dedup — reserved for the
 * two events that genuinely cannot be deduped on an order id, because
 * neither one represents a persisting STATE of the order the way "flagged"
 * does (D22 review): (1) the sweep could not even EVALUATE an order
 * (criterion 102's outer catch) — a transient/anomalous failure worth
 * surfacing loudly every time it happens, not something to fold into an
 * opened/resolved lifecycle; (2) the cancellation email failed to deliver
 * (finding 4's escalation path, criterion 108) — a one-shot event fired at
 * most once per order, since the compare-and-set means an order is only
 * ever cancelled once.
 *
 * The "flag" outcome (an unresolvable price) is NOT sent through here — it
 * genuinely IS a persisting state that can last the full 48-hour suspension
 * window, so it goes through `dispatchAdminAlert` / `AdminAlertNotification`
 * instead (`openGuaranteeAlertForEpisode` / `resolveClearedGuaranteeAlerts`
 * above), which dedupes on `(source_kind, source_id, event)` — keyed on the
 * failure EPISODE, not the order — and only ever emits one `opened` and one
 * `resolved` per episode.
 */
async function sendAdminAlert(
  resolvePort: () => EmailPortResolution,
  content: { subject: string; text: string }
): Promise<void> {
  const resolution = resolvePort();
  if (!resolution.configured) {
    logger.error("bank_payment.guarantee_admin_alert_unconfigured", {
      reason: resolution.reason,
      subject: content.subject,
    });
    return;
  }
  try {
    await resolution.port.send({
      from: resolution.from,
      to: resolution.recipients,
      subject: content.subject,
      text: content.text,
    });
  } catch (error) {
    logger.error("bank_payment.guarantee_admin_alert_failed", {
      error: error instanceof Error ? error.name : "UnknownError",
      subject: content.subject,
    });
  }
}
