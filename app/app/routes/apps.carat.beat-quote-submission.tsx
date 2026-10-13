import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import {
  createBeatQuoteSubmission,
  isBeatQuoteSubmissionIdCollision,
  toBeatQuoteSubmissionConfirmation,
} from "~/db/repositories/beatQuoteSubmissionRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  BEAT_QUOTE_AUTHENTICITY_ACTION,
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_POLICY_SLUGS,
  BEAT_QUOTE_WHAT_WE_MATCH_ACTION,
  BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
  selectPathAcknowledgment,
} from "~/domain/beatyourquote/acknowledgmentText";
import { deriveIntakeTreatment } from "~/domain/beatyourquote/eligibility";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { businessCalendarDate, resolveStoreTimezone } from "~/shopify/admin/shopTimezone.server";
import { verifyAppProxySignature } from "~/shopify/proxy";
import { unauthenticated } from "~/shopify.server";

/**
 * POST /apps/carat/beat-quote-submission — the "Let Us Beat Your Quote!"
 * intake (Slice 10).
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route, enforced by
 * `csrfResourceRouteFence.test.ts`.
 *
 * Open to signed-out visitors, like the Custom Jewelry enquiry: this is an
 * acquisition feature, and the spec asks for the account id only "if
 * available". The App Proxy signature is still required — "no account" is not
 * "no authentication of the caller".
 *
 * ============================================================================
 * THE REQUEST CANNOT ASSERT ITS OWN TREATMENT. THERE IS NO FIELD FOR IT.
 * ============================================================================
 * `treatment`, `guaranteeEligible`, `quoteAgeCalendarDays` and the
 * acknowledgment variant are ALL derived server-side and appear nowhere in
 * `bodySchema`. The schema is `.strict()`, so a request that tries to send one
 * is rejected outright rather than having it silently dropped.
 *
 * That is deliberately stronger than accepting and ignoring the field. An
 * accepted-and-ignored field is a field somebody later wires up "because it was
 * already there", and the failure mode is a customer granting themselves a
 * guaranteed match-or-beat plus a $100 benefit by editing a hidden input.
 *
 * The customer supplies FACTS — what they are submitting, and when the quote
 * was issued. The conclusion is ours. Three further layers agree:
 *   - `deriveIntakeTreatment` reads only kind + two calendar dates;
 *   - `selectPathAcknowledgment` takes the DERIVED treatment, and throws rather
 *     than defaulting for the combination the amendment forbids;
 *   - the database refuses `treatment='guarantee'` for any kind but
 *     `custom_quote` and beyond the 7-day window.
 *
 * ============================================================================
 * ELIGIBILITY IS FROZEN HERE, ONCE
 * ============================================================================
 * Three facts are stored, each answering a different question: the submission
 * INSTANT in UTC, the BUSINESS-CALENDAR date the 7-day rule was applied to, and
 * the IANA zone that date was derived in. Nothing downstream recomputes
 * eligibility from `now()` — a quote must not age out because review took four
 * days — and storing the zone means a future store-timezone change cannot
 * reinterpret a submission judged under the old one.
 *
 * ============================================================================
 * INTAKE ISSUES NO BENEFIT, EVER
 * ============================================================================
 * Deriving `treatment = 'guarantee'` means "this submission is CAPABLE of
 * carrying the guarantee", not that CaratForUs owes anything. The spec's
 * Implementation Principle forbids "an automated engine that commits CaratForUs
 * to matching or beating a competitor based solely on uploaded documents". A
 * fallback is owed only after a human verifies the submission AND concludes
 * CaratForUs cannot beat the price — so this route writes no
 * `beat_quote_fallback_benefit` row under any circumstances.
 */

/**
 * The request contract. NOTE WHAT IS ABSENT: no treatment, no eligibility, no
 * acknowledgment id or version, no quote age. `.strict()` turns an attempt to
 * send any of them into a 400 rather than a silent drop.
 */
const bodySchema = z
  .object({
    /** Client-minted, so a retry converges on one submission. */
    submissionId: z.string().uuid(),

    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().min(1).max(50).optional(),

    /** The three choices the entry flow offers. The system derives the rest. */
    kind: z.enum(["custom_quote", "online_listing", "competing_group_buy"]),

    /**
     * `YYYY-MM-DD`. A FACT the customer supplies; the age and the treatment are
     * computed from it. Required for a custom quote and rejected for the other
     * kinds, which have no age rule at all (amendment §1).
     */
    quoteIssuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    competitorSellerName: z.string().trim().min(1).max(300).optional(),
    competitorWebsite: z.string().trim().min(1).max(2000).optional(),
    /** Plain text. NOTHING SERVER-SIDE EVER FETCHES IT — that would be SSRF. */
    listingUrl: z.string().trim().min(1).max(2000).optional(),

    /** Minor units as a STRING, never a JSON number: a price is money. */
    competitorPriceMinorUnits: z.string().regex(/^\d{1,15}$/).optional(),
    competitorPriceCurrency: z.string().trim().length(3).optional(),

    specifications: z.string().trim().min(1).max(20_000).optional(),
    competitorTimeline: z.string().trim().min(1).max(2000).optional(),
    competitorReturnPolicy: z.string().trim().min(1).max(2000).optional(),
    competitorWarranty: z.string().trim().min(1).max(2000).optional(),

    /**
     * The three required affirmations. Each must be the LITERAL `true` —
     * `z.boolean()` would accept `false` and leave "did they actually agree?"
     * to a later `if`. Never pre-checked, never inferred.
     *
     * The customer affirms the PATH acknowledgment without naming it: which
     * text they were shown is determined server-side, so they cannot claim to
     * have accepted the more favourable variant.
     */
    whatWeMatchAccepted: z.literal(true),
    authenticityConfirmed: z.literal(true),
    pathAcknowledgmentAccepted: z.literal(true),
  })
  .strict();

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

/** A `YYYY-MM-DD` string as a `DATE` column value, at UTC midnight. */
function asDateColumn(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("beat_quote_submission.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // From the SIGNED parameter only, never from the body.
  const customerRef = loggedInCustomerId ? normalizeCustomerGid(loggedInCustomerId) : null;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    // Also the response to a request that tried to send `treatment` — a
    // `.strict()` schema rejects the unknown key rather than dropping it.
    return badRequest("body does not match the beat-quote submission contract");
  }
  const body = parsed.data;

  // A custom quote needs its issue date; the other kinds must not carry one,
  // because amendment §1 removes the age rule for them entirely and an age
  // stored against them would invite someone to compare it against 7.
  if (body.kind === "custom_quote" && body.quoteIssuedOn === undefined) {
    return badRequest("a custom quote submission requires quoteIssuedOn");
  }
  if (body.kind !== "custom_quote" && body.quoteIssuedOn !== undefined) {
    return badRequest("quoteIssuedOn applies only to a custom quote submission");
  }

  const hasPriceAmount = body.competitorPriceMinorUnits !== undefined;
  const hasPriceCurrency = body.competitorPriceCurrency !== undefined;
  if (hasPriceAmount !== hasPriceCurrency) {
    return badRequest("a competitor price needs both an amount and a currency");
  }

  // ---------------------------------------------------------------------------
  // DERIVE. Nothing below reads anything the request could have influenced
  // beyond the kind and the quote's own date.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // THE BUSINESS CALENDAR, RESOLVED FROM THE STORE — never hard-coded.
  //
  // Which zone decides the 7-day boundary is a business fact: it determines
  // whether a quote submitted late in the evening counts as today or tomorrow,
  // and therefore whether a customer receives a guaranteed match-or-beat plus a
  // $100 benefit or a discretionary review. An earlier version of this route
  // hard-coded America/New_York. It happened to match the store's real setting,
  // which is exactly the problem — a constant that is right by luck is
  // indistinguishable from one that is right by design.
  //
  // REFUSES RATHER THAN GUESSING. If the zone cannot be resolved there is no
  // safe default: assuming one would silently move a real eligibility boundary.
  // The resolver memoizes per process, so this is not a Shopify round trip per
  // submission.
  // ---------------------------------------------------------------------------
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain) {
    // A verified App Proxy request always carries it; its absence is a real
    // anomaly rather than something to work around.
    return badRequest("the request carried no shop parameter");
  }

  const submittedAt = new Date();
  let calendarZone: string;
  try {
    calendarZone = await resolveStoreTimezone(shopDomain, async () => {
      const { admin } = await unauthenticated.admin(shopDomain);
      return admin;
    });
  } catch (error) {
    logger.error("beat_quote_submission.timezone_unresolved", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "business_calendar_unavailable" }, { status: 503 });
  }

  const submittedOn = businessCalendarDate(submittedAt, calendarZone);
  let derived;
  try {
    derived = deriveIntakeTreatment({
      kind: body.kind,
      quoteIssuedOn: body.quoteIssuedOn,
      submittedOn,
    });
  } catch {
    // An impossible calendar date — `2026-02-30` passes the regex but is not a
    // date. See `calendarDaysBetween`: V8 rolls it forward rather than
    // rejecting it, which would silently shift the age.
    return badRequest("quoteIssuedOn is not a real calendar date");
  }

  const pathAcknowledgment = selectPathAcknowledgment(body.kind, derived.treatment);

  // Every acknowledgment must name the version it was shown under. A missing
  // policy row means the required evidence cannot be recorded, so the
  // submission is refused rather than accepted without it.
  const [whatWeMatchPolicy, authenticityPolicy, pathPolicy] = await Promise.all([
    getLatestPolicyVersion(BEAT_QUOTE_POLICY_SLUGS.whatWeMatch),
    getLatestPolicyVersion(BEAT_QUOTE_POLICY_SLUGS.authenticity),
    getLatestPolicyVersion(pathAcknowledgment.slug),
  ]);
  if (!whatWeMatchPolicy || !authenticityPolicy || !pathPolicy) {
    logger.error("beat_quote_submission.policy_unavailable", {
      pathSlug: pathAcknowledgment.slug,
      whatWeMatch: Boolean(whatWeMatchPolicy),
      authenticity: Boolean(authenticityPolicy),
      path: Boolean(pathPolicy),
    });
    return Response.json({ error: "acknowledgment_copy_unavailable" }, { status: 503 });
  }

  const acknowledgedAt = new Date();

  // ONE TRANSACTION. A submission without its acknowledgments is not a valid
  // submission, and three acknowledgment rows pointing at a submission that
  // failed to write are orphans in an append-only table.
  // CONVERGENCE LIVES OUT HERE, OUTSIDE THE TRANSACTION.
  //
  // Two requests for the same submissionId can both pass the existence read
  // inside their transactions; the primary key decides it. The loser cannot
  // recover in place — Postgres poisons an aborted transaction, so any query
  // after the failed INSERT returns 25P02 rather than the row it was looking
  // for. So the P2002 is caught here, after the transaction has ended, and the
  // winner's submission is read with a clean connection.
  //
  // The loser writes NO acknowledgments: the winner already wrote three, and a
  // second set would imply the customer agreed twice.
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
    const { submission, created } = await createBeatQuoteSubmission(
      {
        id: body.submissionId,
        customerRef,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone ?? null,
        kind: body.kind,
        // DERIVED, both of them.
        treatment: derived.treatment,
        quoteAgeCalendarDays: derived.quoteAgeInCalendarDays,
        quoteIssuedOn: body.quoteIssuedOn ? asDateColumn(body.quoteIssuedOn) : null,
        submittedOn: asDateColumn(submittedOn),
        // The instant, and WHICH calendar the date above came from. Stored so a
        // future store-timezone change cannot reinterpret this submission's
        // eligibility.
        submittedAt,
        calendarZone,
        competitorSellerName: body.competitorSellerName ?? null,
        competitorWebsite: body.competitorWebsite ?? null,
        listingUrl: body.listingUrl ?? null,
        competitorPriceMinorUnits: hasPriceAmount ? BigInt(body.competitorPriceMinorUnits!) : null,
        competitorPriceCurrency: hasPriceCurrency ? body.competitorPriceCurrency!.toUpperCase() : null,
        specifications: body.specifications ?? null,
        competitorTimeline: body.competitorTimeline ?? null,
        competitorReturnPolicy: body.competitorReturnPolicy ?? null,
        competitorWarranty: body.competitorWarranty ?? null,
      },
      tx
    );

    // A RETRY RECORDS NOTHING NEW. The acknowledgments were written with the
    // first submission; writing them again would duplicate evidence and
    // imply the customer agreed twice.
    if (!created) return { submission, created };

    const common = {
      acknowledgedAt,
      customerRef: customerRef ?? undefined,
      submissionRef: submission.id,
    };
    // The LITERAL pinned constants, never anything from the request. What the
    // customer agreed to is decided here.
    await createAcknowledgment(
      {
        ...common,
        exactText: BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
        policyVersionId: whatWeMatchPolicy.id,
        affirmativeActionLabel: BEAT_QUOTE_WHAT_WE_MATCH_ACTION,
      },
      tx
    );
    await createAcknowledgment(
      {
        ...common,
        exactText: BEAT_QUOTE_AUTHENTICITY_TEXT,
        policyVersionId: authenticityPolicy.id,
        affirmativeActionLabel: BEAT_QUOTE_AUTHENTICITY_ACTION,
      },
      tx
    );
    await createAcknowledgment(
      {
        ...common,
        exactText: pathAcknowledgment.text,
        policyVersionId: pathPolicy.id,
        affirmativeActionLabel: pathAcknowledgment.affirmativeActionLabel,
      },
      tx
    );

      return { submission, created };
    });
  } catch (error) {
    if (!isBeatQuoteSubmissionIdCollision(error)) throw error;
    // The winner's row, read on a CLEAN connection. See the comment above.
    logger.info("beat_quote_submission.concurrent_duplicate", { submissionId: body.submissionId });
    result = {
      submission: await prisma.beatQuoteSubmission.findUniqueOrThrow({ where: { id: body.submissionId } }),
      created: false,
    };
  }

  logger.info("beat_quote_submission.received", {
    submissionReference: result.submission.submissionReference,
    kind: body.kind,
    treatment: derived.treatment,
    reason: derived.reason,
    created: result.created,
  });

  return Response.json(
    {
      ...toBeatQuoteSubmissionConfirmation(result.submission),
      // Returned so the storefront can show what was agreed to. Derived, and
      // returning it is not accepting it.
      acknowledgment: {
        id: pathAcknowledgment.id,
        version: pathPolicy.version,
        text: pathAcknowledgment.text,
        affirmativeActionLabel: pathAcknowledgment.affirmativeActionLabel,
      },
    },
    {
      // 201 on first write, 200 on a converged retry — the customer sees
      // success either way, and a client can tell them apart.
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "private, no-store" },
    }
  );
}
