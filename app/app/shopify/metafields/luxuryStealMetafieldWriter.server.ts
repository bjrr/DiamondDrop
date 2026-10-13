import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";

import type { LuxuryStealAssignment } from "./luxuryStealMetafield";
import { buildLuxuryStealMetafield } from "./luxuryStealMetafield";

/**
 * The Admin API writer for `carat.luxury_steal` (Slice 3 task 3-2, criterion
 * 126). Mirrors `priceMetafieldWriter.server.ts`'s transport and error-
 * handling discipline FAITHFULLY rather than sharing its function directly:
 * every HTTP-200 failure shape the Admin API is known to use is checked in
 * the same order (top-level `errors`, then `userErrors`, then a response
 * that claims neither but did not actually do the work) — see that module's
 * header comment for why each check exists. It is a deliberate near-copy,
 * not a fork of behaviour: nothing here changes what counts as success or
 * failure, only WHICH mutation is sent and one extra check described below
 * that the price writer does not need.
 *
 * WHY NOT CALL `setPriceMetafields` DIRECTLY. Its `MetafieldsSetInput` shape
 * and error handling would both fit this write (same namespace, same
 * `boolean` type as the existing `bank_payment_eligible` / `sync_suspended`
 * flags). It is not reused because its mutation document does not request
 * `owner { ... on ProductVariant { id } }` on the response — it only asks
 * for `id namespace key ownerType` — so it has no way to confirm WHICH
 * variant a write landed on, only how many writes landed. This module needs
 * that stronger guarantee (see below), so it sends its own mutation.
 *
 * VERIFIES THE WRITE LANDED ON THE EXPECTED VARIANT, NOT MERELY ON *A*
 * VARIANT. `priceMetafieldWriter.server.ts`'s count check (`written.length
 * !== inputs.length`) catches a response that silently drops or under-
 * reports writes, but it says nothing about WHICH owner each confirmed
 * metafield actually landed on — a batching or id-mapping bug that returned
 * the right COUNT of confirmations for the wrong variants would slip past
 * it undetected. Because a Luxury Steal assignment gates a Final Sale
 * acknowledgment (criterion 133) rather than merely a displayed number, this
 * writer requests each metafield's `owner` back and matches every confirmed
 * write against the exact set of variant gids requested, as a multiset
 * (never assuming the response preserves input order).
 *
 * NOT WIRED INTO ANY REAL ADMIN PATH YET. This is a tested, self-contained
 * seam for task 3-2. Calling it from the Luxury Steal assignment admin path
 * (task 3-1) is that task's wiring work, not this one's.
 */

const MUTATION = `#graphql
  mutation CaratSetLuxuryStealMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        owner {
          ... on ProductVariant {
            id
          }
        }
      }
      userErrors { field message code }
    }
  }`;

interface WrittenLuxuryStealMetafield {
  id: string;
  namespace: string;
  key: string;
  owner?: { id?: string } | null;
}

interface MetafieldsSetPayload {
  metafields?: WrittenLuxuryStealMetafield[] | null;
  userErrors?: { field?: string[] | null; message: string }[];
}

interface GraphqlEnvelope {
  data?: { metafieldsSet?: MetafieldsSetPayload };
  errors?: { message: string }[];
}

export interface SetLuxuryStealMetafieldsResult {
  readonly appliedAt: Date;
  /** Shopify variant gids Shopify confirmed the write landed on, one per confirmed write. */
  readonly writtenVariantGids: readonly string[];
}

export class NoLuxuryStealAssignmentsToWriteError extends Error {
  constructor() {
    super("setLuxuryStealMetafields called with an empty assignment list.");
    this.name = "NoLuxuryStealAssignmentsToWriteError";
  }
}

/**
 * A confirmed write's `owner` did not match any variant this call requested.
 * This is the failure the module exists to catch: a response that reports
 * the right NUMBER of successes while landing on the wrong variant(s).
 */
export class LuxuryStealMetafieldOwnerMismatchError extends Error {
  constructor(readonly unexpectedOwnerId: string) {
    super(
      `Shopify confirmed a carat.luxury_steal write on variant "${unexpectedOwnerId}", ` +
        "which was not among the variants requested in this call."
    );
    this.name = "LuxuryStealMetafieldOwnerMismatchError";
  }
}

/**
 * Syncs one or more variants' Luxury Steal assignment to Shopify in a single
 * `metafieldsSet` call. Never resolves before Shopify has confirmed every
 * write landed on its intended variant (criterion 126 / CLAUDE.md rule 17
 * sync-failure safety) — any failure throws, and the caller's previously
 * published state remains authoritative until a later call succeeds.
 *
 * DOES NOT GUARANTEE ATOMICITY ACROSS ASSIGNMENTS — same caveat as
 * `setPriceMetafields`: `metafieldsSet` reports success/failure per entry,
 * so passing several assignments in one call is a batching convenience
 * (e.g. an admin "apply to all variants" action), not a transaction. Each
 * variant's own boolean value is independently correct or it is rejected;
 * there is no cross-field coherence concern here the way there is for
 * price-bearing payloads, because this flag carries no derived figure that
 * could go stale relative to a sibling field.
 */
export async function setLuxuryStealMetafields(
  client: AdminGraphqlClient,
  assignments: readonly LuxuryStealAssignment[]
): Promise<SetLuxuryStealMetafieldsResult> {
  if (assignments.length === 0) {
    throw new NoLuxuryStealAssignmentsToWriteError();
  }

  const inputs = assignments.map(buildLuxuryStealMetafield);

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

  // TOP-LEVEL GraphQL errors first — a malformed variable never reaches
  // `data` at all. Same ordering as priceMetafieldWriter.server.ts.
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
  // PARTIAL SUCCESS WITH NO userErrors — the same hazard
  // priceMetafieldWriter.server.ts guards against: fewer confirmed
  // metafields than requested with an empty `userErrors` array is not a
  // shape any known-good response takes.
  if (written.length !== inputs.length) {
    throw new AdminApiError("metafieldsSet", [
      `requested ${inputs.length} carat.luxury_steal write(s) but Shopify confirmed ${written.length}`,
    ]);
  }

  // OWNER VERIFICATION — the check this writer adds beyond the price writer.
  // Matched as a multiset against the requested ownerIds, never by assuming
  // the response preserves input order.
  const remainingByOwnerId = new Map<string, number>();
  for (const input of inputs) {
    remainingByOwnerId.set(input.ownerId, (remainingByOwnerId.get(input.ownerId) ?? 0) + 1);
  }

  const confirmedOwnerIds: string[] = [];
  for (const entry of written) {
    const ownerId = entry.owner?.id;
    if (!ownerId) {
      throw new AdminApiError("metafieldsSet", [
        "a confirmed carat.luxury_steal write did not report its owner variant id",
      ]);
    }
    const remaining = remainingByOwnerId.get(ownerId) ?? 0;
    if (remaining <= 0) {
      throw new LuxuryStealMetafieldOwnerMismatchError(ownerId);
    }
    remainingByOwnerId.set(ownerId, remaining - 1);
    confirmedOwnerIds.push(ownerId);
  }

  return {
    appliedAt: new Date(),
    writtenVariantGids: confirmedOwnerIds,
  };
}
