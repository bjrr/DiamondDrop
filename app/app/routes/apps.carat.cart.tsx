import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getPublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import type { CartLineMerchandiseInput } from "~/domain/cart/types";
import { priceCart } from "~/domain/cart/pricing";
import { CartCurrencyMismatchError, InvalidCartLineQuantityError } from "~/domain/cart/pricing";
import { buildCartProxyResponseDto, type UnpurchasableCartLine } from "~/domain/cart/proxyResponseDto";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/cart — the single mode-aware cart pricing source
 * (Stage 2B task 2B-1, docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md L1).
 *
 * A RESOURCE ROUTE — no default export, action only. Same reasoning as every
 * other `apps.carat.*` route: `allowedActionOrigins` is unconditionally `[]`
 * in every production build, so a default export here would 400 every
 * legitimate storefront caller before validation runs (architecture §2.1,
 * finding F-23; enforced by csrfResourceRouteFence.test.ts).
 *
 * CRITERION 43 IS THE POINT OF THIS ROUTE. The request body names WHICH
 * lines and WHICH mode; it never supplies a price. Every unit price in the
 * response is re-resolved, server-side, from `getPublishedVariantPrice` —
 * the one function every customer-facing surface must use (its own doc
 * comment, criterion 52) — keyed off `master_variant.shopifyVariantGid`.
 * A tampered `quantity` or `mode` can change what is computed; nothing in
 * the request body can change what a line COSTS.
 *
 * SIGNATURE VERIFIED BEFORE ANYTHING ELSE, same as the Group Buy proxy
 * route. Shopify signs the query string on every App Proxy request
 * regardless of HTTP method, so this holds for a POST exactly as it does for
 * the Group Buy route's GET.
 *
 * WHAT THIS NEVER RETURNS. No cost, margin, landed cost, pricing profile,
 * uplift rate or tier label — see the fence in
 * `~/domain/cart/proxyResponseDto.ts` (ruling R10) and its
 * `proxyResponseDto.test.ts`. This route calls
 * `buildCartProxyResponseDto` exactly once and returns its result directly;
 * it must never add a field to the response body itself.
 */

const MAX_LINES_PER_REQUEST = 250;
const MAX_QUANTITY_PER_LINE = 9_999;

const cartLineRequestSchema = z.object({
  lineId: z.string().min(1).max(200),
  shopifyVariantId: z.string().min(1).max(200),
  quantity: z.number().int().positive().max(MAX_QUANTITY_PER_LINE),
});

const cartPriceRequestSchema = z
  .object({
    mode: z.enum(["card", "bank"]),
    lines: z.array(cartLineRequestSchema).max(MAX_LINES_PER_REQUEST),
  })
  // Duplicate lineIds would make the response's echoed shopifyVariantId
  // ambiguous (buildCartProxyResponseDto keys its lookup by lineId) — reject
  // rather than silently resolve the ambiguity in an unspecified direction.
  .refine((body) => new Set(body.lines.map((l) => l.lineId)).size === body.lines.length, {
    message: "lines[].lineId must be unique within a request",
  });

/**
 * Single-currency storefront for MVP1 (spec-wide assumption; every
 * `MoneyJSON`/`PublishedVariantPrice` currency observed in this codebase is
 * "USD"). Used ONLY when a cart has zero purchasable lines and therefore no
 * resolved price to read a currency from — never overrides a real resolved
 * currency.
 */
const FALLBACK_CURRENCY = "USD";

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("cart.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = cartPriceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("body does not match the cart pricing request contract");
  }
  const { mode, lines: requestLines } = parsed.data;

  if (requestLines.length === 0) {
    return Response.json(
      buildCartProxyResponseDto(
        priceCart({ mode, currency: FALLBACK_CURRENCY, lines: [] }),
        new Map(),
        []
      ),
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }

  // Resolve every requested Shopify variant id to a master_variant row in ONE
  // query, rather than one round trip per line — the per-variant PRICE
  // resolution below still has to go through getPublishedVariantPrice
  // individually (that function's own contract, criterion 52), but the
  // eligibility flag and existence check do not need to.
  const requestedGids = requestLines.map((line) => normalizeShopifyVariantGid(line.shopifyVariantId));
  const variants = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { in: requestedGids } },
    select: { id: true, shopifyVariantGid: true, bankPaymentDiscountEligible: true },
  });
  const variantByGid = new Map(variants.map((v) => [v.shopifyVariantGid as string, v]));

  const merchandiseLines: CartLineMerchandiseInput[] = [];
  const unpurchasable: UnpurchasableCartLine[] = [];
  const shopifyVariantIdByLineId = new Map<string, string>();
  let currency: string | null = null;

  for (const requestLine of requestLines) {
    const gid = normalizeShopifyVariantGid(requestLine.shopifyVariantId);
    const variant = variantByGid.get(gid);

    if (!variant) {
      unpurchasable.push({
        lineId: requestLine.lineId,
        shopifyVariantId: requestLine.shopifyVariantId,
        quantity: BigInt(requestLine.quantity),
        reason: "unknown_variant",
      });
      continue;
    }

    // The single source of truth for what a variant's published price is
    // (criterion 52) — never read from a client-supplied field. Sequential,
    // not batched: getPublishedVariantPrice's contract is per-variant, and
    // cart sizes are bounded by MAX_LINES_PER_REQUEST.
    const published = await getPublishedVariantPrice(variant.id);

    if (published.kind === "not_purchasable") {
      unpurchasable.push({
        lineId: requestLine.lineId,
        shopifyVariantId: requestLine.shopifyVariantId,
        quantity: BigInt(requestLine.quantity),
        reason: "unsynced",
      });
      continue;
    }

    currency = currency ?? published.price.currency;

    merchandiseLines.push({
      lineId: requestLine.lineId,
      masterVariantId: variant.id,
      quantity: BigInt(requestLine.quantity),
      currency: published.price.currency,
      bankPaymentDiscountEligible: variant.bankPaymentDiscountEligible,
      unitBankPaymentPriceMinorUnits: published.price.bankPaymentPriceMinorUnits,
      unitRegularCardPriceMinorUnits: published.price.regularCardPriceMinorUnits,
    });
    shopifyVariantIdByLineId.set(requestLine.lineId, requestLine.shopifyVariantId);
  }

  try {
    const priced = priceCart({ mode, currency: currency ?? FALLBACK_CURRENCY, lines: merchandiseLines });
    const dto = buildCartProxyResponseDto(priced, shopifyVariantIdByLineId, unpurchasable);

    return Response.json(dto, {
      headers: {
        // Private and uncached: this figure is mode-specific and re-derived
        // on every request from live published prices.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof CartCurrencyMismatchError || error instanceof InvalidCartLineQuantityError) {
      logger.error("cart.pricing_failed", { reason: error.name, message: error.message });
      return Response.json({ error: "pricing_failed" }, { status: 500 });
    }
    throw error;
  }
}
