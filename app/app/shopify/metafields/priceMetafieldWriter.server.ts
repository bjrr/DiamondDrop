import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";

import type { PRICE_METAFIELD_NAMESPACE, PriceMetafieldWriteInput } from "./priceMetafieldPayload";

/**
 * The Admin API writer for `carat.*` metafields (Slice 2 stage 2B entry
 * condition C5). Mirrors `priceSyncAdapter.server.ts`'s discipline
 * deliberately: this is the only module that writes these metafields to
 * Shopify, it decides nothing about WHICH price to publish (that is the
 * caller's job, via the builders in `priceMetafieldPayload.ts`), and it
 * treats every failure mode the Admin API is known to report as HTTP 200 —
 * top-level `errors`, per-field `userErrors`, and a response that claims
 * neither but did not actually do the work.
 *
 * NOT WIRED INTO THE PUBLISH PATH. Per the team lead's Stage 2B entry-
 * condition instructions, this module exists as a tested, self-contained
 * seam. Calling it from `syncApprovedIntent.server.ts` (or anywhere else in
 * the real publish flow) is Stage 2B implementation work, not this task.
 */

const MUTATION = `#graphql
  mutation CaratSetPriceMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key ownerType }
      userErrors { field message code }
    }
  }`;

interface MetafieldsSetPayload {
  metafields?: { id: string; namespace: string; key: string; ownerType: string }[] | null;
  userErrors?: { field?: string[] | null; message: string }[];
}

interface GraphqlEnvelope {
  data?: { metafieldsSet?: MetafieldsSetPayload };
  errors?: { message: string }[];
}

export interface SetPriceMetafieldsResult {
  readonly appliedAt: Date;
  /** `namespace.key` for every metafield Shopify confirmed writing, in the order Shopify returned them. */
  readonly writtenKeys: readonly string[];
}

export class NoMetafieldsToWriteError extends Error {
  constructor() {
    super("setPriceMetafields called with an empty input list.");
    this.name = "NoMetafieldsToWriteError";
  }
}

export class NoMetafieldsToDeleteError extends Error {
  constructor() {
    super("deletePriceMetafields called with an empty identifier list.");
    this.name = "NoMetafieldsToDeleteError";
  }
}

/**
 * Writes one or more `carat.*` metafields in a single `metafieldsSet` call.
 *
 * DOES NOT GUARANTEE ATOMICITY ACROSS ENTRIES — `metafieldsSet` reports
 * success/failure per entry via `userErrors`, so passing several inputs in
 * one call is a batching convenience, not a transaction. This is exactly
 * why every PRICE-BEARING payload built by `priceMetafieldPayload.ts`
 * carries its own `priceCalculationId`: coherence must be checkable from a
 * single field's own value, never inferred from "these fields were in the
 * same call".
 */
export async function setPriceMetafields(
  client: AdminGraphqlClient,
  inputs: readonly PriceMetafieldWriteInput[]
): Promise<SetPriceMetafieldsResult> {
  if (inputs.length === 0) {
    throw new NoMetafieldsToWriteError();
  }

  const response = await client.graphql(MUTATION, {
    variables: {
      metafields: inputs.map((input) => ({
        ownerId: input.ownerId,
        namespace: input.namespace,
        key: input.key,
        type: input.type,
        value: input.value,
      })),
    },
  });
  const body = (await response.json()) as GraphqlEnvelope;

  // TOP-LEVEL GraphQL errors first — see priceSyncAdapter.server.ts's own
  // module comment for why this must be checked before userErrors: a
  // malformed variable never reaches `data` at all.
  if (body.errors?.length) {
    throw new AdminApiError("metafieldsSet", body.errors.map((e) => e.message));
  }

  const payload = body.data?.metafieldsSet;
  if (!payload) {
    throw new AdminApiError("metafieldsSet", ["response had no metafieldsSet payload"]);
  }

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new AdminApiError(
      "metafieldsSet",
      userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
    );
  }

  const written = payload.metafields ?? [];
  // PARTIAL SUCCESS WITH NO userErrors — exactly the hazard this module
  // exists to catch, and exactly the shape `priceSyncAdapter.server.ts`'s
  // own "no userErrors but also nothing returned" guard was written for.
  // `metafieldsSet` is documented to report a `userErrors` entry for every
  // input it rejects, so fewer confirmed metafields than requested with an
  // EMPTY `userErrors` array is not a shape any known-good response takes.
  if (written.length !== inputs.length) {
    throw new AdminApiError("metafieldsSet", [
      `requested ${inputs.length} metafield write(s) but Shopify confirmed ${written.length}`,
    ]);
  }

  return {
    appliedAt: new Date(),
    writtenKeys: written.map((w) => `${w.namespace}.${w.key}`),
  };
}

/**
 * Identifies a metafield to DELETE — no `value`/`type`, just the coordinate
 * (Stage 2B / R13, criterion 31).
 */
export interface PriceMetafieldIdentifier {
  readonly ownerId: string;
  readonly namespace: typeof PRICE_METAFIELD_NAMESPACE;
  readonly key: string;
}

const DELETE_MUTATION = `#graphql
  mutation CaratDeletePriceMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }`;

interface MetafieldsDeletePayload {
  deletedMetafields?: ({ key: string; namespace: string; ownerId: string } | null)[] | null;
  userErrors?: { field?: string[] | null; message: string }[];
}

interface DeleteGraphqlEnvelope {
  data?: { metafieldsDelete?: MetafieldsDeletePayload };
  errors?: { message: string }[];
}

export interface DeletePriceMetafieldsResult {
  readonly appliedAt: Date;
}

/**
 * Deletes one or more `carat.*` metafields — used to clear a stale product-
 * level "as low as" figure when NO variant remains currently purchasable
 * (criterion 31: "the card shows the product's unavailable state — never a
 * stale or fabricated 'As low as'"). Leaving the metafield in place would
 * have Liquid keep rendering the last-computed figure for a product nothing
 * can actually buy at that price any more.
 *
 * DELETING A METAFIELD THAT NEVER EXISTED IS NOT AN ERROR. Verified live
 * against caratforus-dev.myshopify.com (Admin API 2026-07), 2026-09-20:
 * `metafieldsDelete` on a coordinate with no existing metafield returns
 * `deletedMetafields: [null]` with an EMPTY `userErrors` array — success,
 * not failure. That is exactly the common case here (a product that has
 * never had a purchasable variant has no "as low as" metafield to begin
 * with), so — unlike `setPriceMetafields`'s count check above, which exists
 * to catch a genuine partial-write hazard — a `null` entry in
 * `deletedMetafields` is NOT treated as a failure here.
 */
export async function deletePriceMetafields(
  client: AdminGraphqlClient,
  identifiers: readonly PriceMetafieldIdentifier[]
): Promise<DeletePriceMetafieldsResult> {
  if (identifiers.length === 0) {
    throw new NoMetafieldsToDeleteError();
  }

  const response = await client.graphql(DELETE_MUTATION, {
    variables: {
      metafields: identifiers.map((identifier) => ({
        ownerId: identifier.ownerId,
        namespace: identifier.namespace,
        key: identifier.key,
      })),
    },
  });
  const body = (await response.json()) as DeleteGraphqlEnvelope;

  if (body.errors?.length) {
    throw new AdminApiError("metafieldsDelete", body.errors.map((e) => e.message));
  }

  const payload = body.data?.metafieldsDelete;
  if (!payload) {
    throw new AdminApiError("metafieldsDelete", ["response had no metafieldsDelete payload"]);
  }

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new AdminApiError(
      "metafieldsDelete",
      userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
    );
  }

  return { appliedAt: new Date() };
}
