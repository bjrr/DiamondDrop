import { describe, expect, it } from "vitest";

import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";

import {
  LuxuryStealMetafieldOwnerMismatchError,
  NoLuxuryStealAssignmentsToWriteError,
  setLuxuryStealMetafields,
} from "./luxuryStealMetafieldWriter.server";

/**
 * Asserts on the SERIALISED GraphQL variables, and on every HTTP-200
 * failure shape the Admin API is documented to use — same discipline as
 * `priceMetafieldWriter.test.ts`.
 */
function fakeClient(reply: unknown) {
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      return { json: async () => reply };
    },
  };
  return { client, calls };
}

function okReply(ownerIds: string[]) {
  return {
    data: {
      metafieldsSet: {
        metafields: ownerIds.map((ownerId, i) => ({
          id: `gid://shopify/Metafield/${i}`,
          namespace: "carat",
          key: "luxury_steal",
          owner: { id: ownerId },
        })),
        userErrors: [],
      },
    },
  };
}

const A_VARIANT_GID = "gid://shopify/ProductVariant/9";

describe("setLuxuryStealMetafields — sends the exact input as GraphQL variables", () => {
  it("serializes ownerId/namespace/key/type/value for an assigned variant", async () => {
    const { client, calls } = fakeClient(okReply([A_VARIANT_GID]));

    const result = await setLuxuryStealMetafields(client, [
      { shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true },
    ]);

    expect(calls[0]?.variables).toEqual({
      metafields: [
        {
          ownerId: A_VARIANT_GID,
          namespace: "carat",
          key: "luxury_steal",
          type: "boolean",
          value: "true",
        },
      ],
    });
    expect(result.writtenVariantGids).toEqual([A_VARIANT_GID]);
    expect(result.appliedAt).toBeInstanceOf(Date);
  });

  it("serializes an unassignment as an explicit 'false' value (criterion 128), not a delete", async () => {
    const { client, calls } = fakeClient(okReply([A_VARIANT_GID]));

    await setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: false }]);

    expect((calls[0]?.variables?.metafields as { value: string }[])[0]?.value).toBe("false");
  });

  it("writes several variants' assignments in one call", async () => {
    const otherGid = "gid://shopify/ProductVariant/10";
    const { client } = fakeClient(okReply([A_VARIANT_GID, otherGid]));

    const result = await setLuxuryStealMetafields(client, [
      { shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true },
      { shopifyVariantGid: otherGid, isLuxurySteal: false },
    ]);

    expect(result.writtenVariantGids).toEqual([A_VARIANT_GID, otherGid]);
  });

  it("matches confirmed writes to requested variants as a multiset, not by trusting response order", async () => {
    const otherGid = "gid://shopify/ProductVariant/10";
    // Reply lists the confirmations in the OPPOSITE order to the request.
    const { client } = fakeClient(okReply([otherGid, A_VARIANT_GID]));

    const result = await setLuxuryStealMetafields(client, [
      { shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true },
      { shopifyVariantGid: otherGid, isLuxurySteal: true },
    ]);

    expect(result.writtenVariantGids).toEqual([otherGid, A_VARIANT_GID]);
  });
});

describe("owner verification — the check this writer adds beyond the price writer", () => {
  it("throws LuxuryStealMetafieldOwnerMismatchError when a confirmed write names a variant nobody requested", async () => {
    const wrongGid = "gid://shopify/ProductVariant/999";
    const { client } = fakeClient(okReply([wrongGid]));

    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toBeInstanceOf(LuxuryStealMetafieldOwnerMismatchError);
  });

  it("throws when a confirmed write reports no owner id at all", async () => {
    const { client } = fakeClient({
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/1", namespace: "carat", key: "luxury_steal", owner: {} }],
          userErrors: [],
        },
      },
    });

    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toThrow(/did not report its owner variant id/);
  });

  it("throws when the same confirmed owner id is reported more times than requested", async () => {
    // Only ONE write of A_VARIANT_GID was requested; two confirmations for it
    // must not silently pass as "two of the requested writes landed somewhere".
    const { client } = fakeClient(okReply([A_VARIANT_GID, A_VARIANT_GID]));

    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toBeInstanceOf(AdminApiError); // fails the count check before owner-matching even runs
  });
});

describe("boundary and error conditions", () => {
  it("throws NoLuxuryStealAssignmentsToWriteError for an empty assignment list, before any call", async () => {
    const { client, calls } = fakeClient(okReply([]));
    await expect(setLuxuryStealMetafields(client, [])).rejects.toBeInstanceOf(NoLuxuryStealAssignmentsToWriteError);
    expect(calls).toHaveLength(0);
  });

  it("throws on top-level GraphQL errors", async () => {
    const { client } = fakeClient({ errors: [{ message: "invalid value for type Boolean" }] });
    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on userErrors", async () => {
    const { client } = fakeClient({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ["metafields", "0", "value"], message: "Value is invalid for metafield type" }],
        },
      },
    });
    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toThrow(/Value is invalid/);
  });

  it("throws when the response has no metafieldsSet payload at all", async () => {
    const { client } = fakeClient({ data: {} });
    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws when fewer metafields are confirmed than requested, even with no userErrors", async () => {
    // THE HAZARD THIS TEST PINS: a response reporting neither failure nor
    // full success must not be read as success (sync-failure safety,
    // CLAUDE.md rule 17 / criterion 126).
    const { client } = fakeClient(okReply([]));
    await expect(
      setLuxuryStealMetafields(client, [{ shopifyVariantGid: A_VARIANT_GID, isLuxurySteal: true }])
    ).rejects.toThrow(/requested 1 carat\.luxury_steal write\(s\) but Shopify confirmed 0/);
  });
});
