import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import type { Money } from "~/domain/money/money";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";

/**
 * `ShopifyPriceSyncAdapter` — the ONLY module in this app that publishes a
 * price to Shopify (spec §4.1 criterion 1, contract C-S2).
 *
 * WHAT IT DOES NOT DECIDE. Every decision that matters — which price to
 * publish, whether this variant's calculation is still current, whether the
 * governing profile is a placeholder — is made by the caller
 * (`app/jobs/pricing/syncApprovedIntent.server.ts`) before this class is ever
 * invoked. This class's only job is: given an already-decided card price and
 * two already-resolved Shopify ids, make the one GraphQL call and interpret
 * its response correctly. Keeping those concerns apart is what makes the
 * money-critical decisions unit-testable with no network and no database.
 *
 * `productVariantsBulkUpdate`, NOT `productVariantUpdate`. The Admin API's
 * price-setting mutation for a variant takes the PARENT PRODUCT id plus an
 * array of variant inputs, even for a single variant — there is no
 * single-variant price-update mutation on this API surface. That is why the
 * port this class implements (`ShopifyPriceSyncPort`) needs both
 * `shopifyProductGid` and `shopifyVariantGid`, not the variant id alone.
 *
 * NOT INTROSPECTION-VERIFIED. `productClient.server.ts`'s mutations were
 * checked against a live store on API version 2026-07 (see its header
 * comment); this adapter's shape is written from the same documented schema
 * but has not been run against a real store in this environment. Flagged
 * explicitly in the T1 handoff for architect/QA follow-up before the first
 * production sync.
 */

const MUTATION = `#graphql
  mutation CaratUpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id }
      productVariants { id price }
      userErrors { field message }
    }
  }`;

interface ProductVariantsBulkUpdatePayload {
  product?: { id: string } | null;
  productVariants?: { id: string; price: string }[] | null;
  userErrors?: { field?: string[] | null; message: string }[];
}

interface GraphqlEnvelope {
  data?: { productVariantsBulkUpdate?: ProductVariantsBulkUpdatePayload };
  errors?: { message: string }[];
}

/**
 * Formats integer minor units as the plain decimal major-unit string the
 * Admin API's `Money` scalar expects (e.g. `123456n` at 100 minor units per
 * major unit -> `"1234.56"`).
 *
 * PURE BIGINT/STRING ARITHMETIC — no JS `Number` conversion, no decimal.js
 * fixed-point formatting call. Both of those are Tier-2-forbidden in this
 * directory by `scripts/check-money-safety.mjs` regardless of which file uses
 * them (the one allow-list entry for that decimal.js formatting call covers a
 * single file, `app/domain/money/rounding.ts`, and does not extend here), and
 * more to the point: this is the single conversion standing directly between
 * a `Money` value and the string Shopify will charge customers, so it earns
 * its own exact implementation rather than borrowing one with a wider blast
 * radius.
 */
export function minorUnitsToDecimalString(
  amountMinorUnits: bigint,
  minorUnitsPerMajorUnit: bigint = 100n
): string {
  if (amountMinorUnits < 0n) {
    throw new Error(
      `Cannot format a negative amount (${amountMinorUnits.toString()}) as a Shopify price.`
    );
  }
  if (minorUnitsPerMajorUnit <= 0n) {
    throw new Error(`minorUnitsPerMajorUnit must be positive, got ${minorUnitsPerMajorUnit.toString()}.`);
  }

  const major = amountMinorUnits / minorUnitsPerMajorUnit;
  const minor = amountMinorUnits % minorUnitsPerMajorUnit;
  // "100" -> 2 decimal places, "1000" -> 3. Computed from the divisor itself
  // rather than hard-coded, so a future non-2-decimal currency (see
  // resolveInputs.server.ts's own note on this) is not a silent truncation.
  const decimalPlaces = minorUnitsPerMajorUnit.toString().length - 1;
  const minorStr = minor.toString().padStart(decimalPlaces, "0");
  return decimalPlaces === 0 ? major.toString() : `${major.toString()}.${minorStr}`;
}

export class ShopifyPriceSyncAdapter implements ShopifyPriceSyncPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async applyVariantPrice(input: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    regularCardPrice: Money;
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }> {
    const priceDecimalString = minorUnitsToDecimalString(input.regularCardPrice.amountMinorUnits);

    const response = await this.client.graphql(MUTATION, {
      variables: {
        productId: input.shopifyProductGid,
        variants: [{ id: input.shopifyVariantGid, price: priceDecimalString }],
      },
    });
    const body = (await response.json()) as GraphqlEnvelope;

    // TOP-LEVEL GraphQL errors first — a malformed document or an
    // authorization failure at the field level, neither of which reaches
    // `data` at all.
    if (body.errors?.length) {
      throw new AdminApiError("productVariantsBulkUpdate", body.errors.map((e) => e.message));
    }

    const payload = body.data?.productVariantsBulkUpdate;
    if (!payload) {
      throw new AdminApiError("productVariantsBulkUpdate", ["response had no productVariantsBulkUpdate payload"]);
    }

    // THE HAZARD THIS WRAPPER EXISTS FOR: the Admin API reports a rejected
    // mutation — bad id, out-of-range price, insufficient permission — as a
    // 200 with `userErrors`, not as an HTTP failure or a top-level `errors`
    // entry. Treating an empty `userErrors` array as "done" is what makes
    // this the one place in the app that can tell "published" from
    // "reported success but published nothing".
    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new AdminApiError(
        "productVariantsBulkUpdate",
        userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
      );
    }

    // Belt and braces: a mutation that returned no variant at all and no
    // userErrors either is not evidence of success, whatever the HTTP status
    // said. This has not been observed from the real API — the two checks
    // above are the documented failure modes — but a silent third shape is
    // exactly the kind of surprise this file exists to refuse to guess about.
    const updated = payload.productVariants?.[0];
    if (!updated) {
      throw new AdminApiError("productVariantsBulkUpdate", [
        "response carried no userErrors but also no updated variant",
      ]);
    }

    return { appliedAt: new Date() };
  }
}
