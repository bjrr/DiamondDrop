/**
 * Read a mounting product and resolve its Center Stone Size Profiles.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5; owner direction
 * 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES THAT A PLAIN PRODUCT READ CANNOT
 * ---------------------------------------------------------------------------
 * The compatibility data is spread across three Shopify places by design, and
 * the matcher needs all three stitched together:
 *
 *   product metafields   eligibility, setting style, prong flags, vendor
 *   variant metafields   the vendor range for THIS mounting at THIS size
 *   linked metaobject    shape and nominal dimensions, shared per centre size
 *
 * The third is reached TWO ways, and the order matters:
 *
 *   1. `variant.custom.syos_center_size_profile` -- a direct metaobject
 *      reference on the variant. AUTHORITATIVE.
 *   2. the centre-size option value's `linkedMetafieldValue`, used only when
 *      the variant carries no direct reference.
 *
 * The variant reference leads because `productOptionUpdate` silently refuses
 * to attach `linkedMetafield` to the pilot mounting's existing option --
 * HTTP 200, `userErrors: []`, and the option still unlinked on readback, with
 * our own app token on 2026-10 and a configuration verified correct down to
 * the metaobject_definition_id validation. The same call succeeds in dev.
 * Rather than keep debugging an undocumented platform edge, the pointer moved
 * to the variant, which Shopify writes without complaint.
 *
 * Route 2 is kept because it costs nothing and is the better model where it
 * works: one linked option instead of a reference per variant.
 *
 * NEITHER ROUTE READS THE LABEL. "9x7 mm" is display and manufacturing data.
 * Dimensions come from the referenced profile, and the projection layer
 * separately reports a label that disagrees with it.
 *
 * READ-ONLY. Authoring is Shopify Product Admin. A write here would mean two
 * editable sources of truth for one product.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUND TRIP, NOT ONE PER VARIANT
 * ---------------------------------------------------------------------------
 * The profiles are fetched by `nodes(ids:)` in a single follow-up call rather
 * than per variant. A mounting offered in six centre sizes with three metals
 * and twenty ring sizes has 360 variants pointing at six profiles; resolving
 * per variant would be 360 calls for six distinct answers and would exhaust
 * the rate limit on a single product.
 */
import type { SizeProfile } from "~/domain/setyourownstone/metafieldProjection";
import type { ShopifyProductCompatibilityInput } from "~/domain/setyourownstone/metafieldProjection";
import {
  SYOS_LINKING_KEY,
  SYOS_LINKING_NAMESPACE,
  SYOS_NAMESPACE,
  SYOS_PROFILE_TYPE,
} from "~/shopify/metafields/syosCompatibilityDefinitions";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Does this metaobject type name our size profile?
 *
 * SHOPIFY RESOLVES `$app:` ON READ. We declare the type as
 * `$app:syos_center_size_profile`, and every read returns
 * `app--424838725633--syos_center_size_profile` — the app id expanded. A
 * strict equality against the declared constant therefore matches NOTHING,
 * silently drops every profile, and leaves each configuration looking
 * unlinked. That is exactly what happened on the pilot: 75 rows synced with
 * "not linked to a Center Stone Size Profile" while the metafields were
 * populated correctly all along.
 *
 * Matched on the suffix because the numeric app id differs between the app's
 * installs, so hard-coding the resolved string would break on the dev store
 * and on any reinstall. Both spellings are accepted so the declared constant
 * stays meaningful.
 */
function isSizeProfileType(type: string): boolean {
  // Deliberately NOT a regex. The first version of this line used
  // `.replace(/^\$app:/, "")`, the escape was eaten in transit, and the
  // source shipped as `/^$app:/` — a pattern that matches nothing, so `bare`
  // kept its prefix, every comparison failed, and all 75 pilot rows synced as
  // "not linked to a profile" a second time. A prefix constant and a slice
  // cannot be mangled that way.
  const APP_PREFIX = "$app:";
  const bare = SYOS_PROFILE_TYPE.startsWith(APP_PREFIX)
    ? SYOS_PROFILE_TYPE.slice(APP_PREFIX.length)
    : SYOS_PROFILE_TYPE;
  return type === SYOS_PROFILE_TYPE || type.endsWith(`--${bare}`);
}

/** The option that carries centre size. Matched by the LINKED METAFIELD, not
 *  by name: a merchant may rename the option in Admin, and the link is the
 *  thing that actually defines its meaning. */
function isCenterSizeOption(option: {
  linkedMetafield?: { namespace?: string | null; key?: string | null } | null;
}): boolean {
  return (
    option.linkedMetafield?.namespace === SYOS_LINKING_NAMESPACE &&
    option.linkedMetafield?.key === SYOS_LINKING_KEY
  );
}

const READ_PRODUCT = `#graphql
  query SyosProductCompatibility($id: ID!, $namespace: String!) {
    product(id: $id) {
      id
      title
      status
      metafields(first: 25, namespace: $namespace) { nodes { key value } }
      options {
        id
        name
        linkedMetafield { namespace key }
        optionValues { id name linkedMetafieldValue }
      }
      variants(first: 250) {
        nodes {
          id
          title
          selectedOptions { name optionValue { id name } }
          metafields(first: 25, namespace: $namespace) { nodes { key value } }
          centerSizeProfile: metafield(namespace: "custom", key: "syos_center_size_profile") {
            value
          }
        }
      }
    }
  }`;

const READ_PROFILES = `#graphql
  query SyosSizeProfiles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        type
        displayName
        fields { key value }
      }
    }
  }`;

export interface SyosProductReadResult {
  readonly input: ShopifyProductCompatibilityInput;
  readonly productTitle: string;
  /** Option names other than centre size, in Shopify's order — what the
   *  customer still gets to choose (metal, ring size). */
  readonly customerFacingOptions: readonly string[];
  /** True when the product has no centre-size option at all. Not an error for
   *  a single-size mounting, but it does mean no profile can be linked. */
  readonly hasCenterSizeOption: boolean;
}

/**
 * Read one product and everything its compatibility depends on.
 *
 * Returns null when the product does not exist — a deleted product must be
 * distinguishable from a misconfigured one, because the sync handler
 * deactivates rows for the former and records problems for the latter.
 */
export async function readSyosProduct(
  client: AdminGraphqlClient,
  productGid: string
): Promise<SyosProductReadResult | null> {
  const data = await run<{
    product?: RawProduct | null;
  }>(client, READ_PRODUCT, { id: productGid, namespace: SYOS_NAMESPACE }, "product(syos)");

  const product = data.product;
  if (!product) return null;

  const options = product.options ?? [];
  const centerOption = options.find(isCenterSizeOption) ?? null;

  // Option value id -> metaobject id, from the linked option.
  const profileIdByOptionValueId = new Map<string, string>();
  for (const value of centerOption?.optionValues ?? []) {
    if (value.linkedMetafieldValue) {
      profileIdByOptionValueId.set(value.id, value.linkedMetafieldValue);
    }
  }

  // Every profile id this product could need, from either route, resolved in
  // one call rather than one per variant.
  const variantProfileIds = (product.variants?.nodes ?? [])
    .map((v) => v.centerSizeProfile?.value ?? null)
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  const profiles = await readSizeProfiles(client, [
    ...new Set([...profileIdByOptionValueId.values(), ...variantProfileIds]),
  ]);

  const variants = (product.variants?.nodes ?? []).map((variant) => {
    // Which of this variant's selected options is the centre size. Resolved
    // through the option's id rather than its name, for the same reason the
    // option itself is: names are merchant-editable.
    const selected = (variant.selectedOptions ?? []).find((s) =>
      centerOption ? centerOption.optionValues.some((v) => v.id === s.optionValue?.id) : false
    );
    const optionValueId = selected?.optionValue?.id ?? null;

    // The variant's own reference wins. The linked option value is the
    // fallback, for products where that linkage did take.
    const profileId =
      variant.centerSizeProfile?.value ??
      (optionValueId ? profileIdByOptionValueId.get(optionValueId) ?? null : null);

    return {
      variantGid: variant.id,
      title: variant.title,
      centerSizeOptionValueId: optionValueId,
      centerSizeOptionValueName: selected?.optionValue?.name ?? null,
      profile: profileId ? profiles.get(profileId) ?? null : null,
      metafields: toRecord(variant.metafields?.nodes),
    };
  });

  return {
    input: {
      productGid: product.id,
      productStatus: product.status,
      productMetafields: toRecord(product.metafields?.nodes),
      variants,
    },
    productTitle: product.title,
    customerFacingOptions: options.filter((o) => !isCenterSizeOption(o)).map((o) => o.name),
    hasCenterSizeOption: centerOption !== null,
  };
}

/**
 * Resolve metaobject ids to size profiles.
 *
 * Exported because the Metaobject event handler needs exactly this and nothing
 * else: it is handed a profile id and must re-read the profile before
 * re-projecting every mounting that uses it.
 *
 * A node of the wrong type is DROPPED rather than coerced. `nodes(ids:)` is
 * untyped and will happily return a product if someone stores a product gid in
 * a metaobject reference; treating that as a profile would invent dimensions.
 */
export async function readSizeProfiles(
  client: AdminGraphqlClient,
  metaobjectIds: readonly string[]
): Promise<Map<string, SizeProfile>> {
  const out = new Map<string, SizeProfile>();
  if (metaobjectIds.length === 0) return out;

  const data = await run<{
    nodes?: (RawMetaobject | null)[];
  }>(client, READ_PROFILES, { ids: [...metaobjectIds] }, "nodes(sizeProfiles)");

  for (const node of data.nodes ?? []) {
    if (!node || !isSizeProfileType(node.type)) continue;
    const fields = toRecord(node.fields);
    out.set(node.id, {
      metaobjectId: node.id,
      displayName: node.displayName ?? null,
      stoneShape: fields.stone_shape ?? null,
      nominalLengthMm: fields.nominal_length_mm ?? null,
      nominalWidthMm: fields.nominal_width_mm ?? null,
      nominalDepthMm: fields.nominal_depth_mm ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ internals

interface RawProduct {
  id: string;
  title: string;
  status: string;
  metafields?: { nodes?: { key: string; value: string | null }[] };
  options?: {
    id: string;
    name: string;
    linkedMetafield?: { namespace?: string | null; key?: string | null } | null;
    optionValues: { id: string; name: string; linkedMetafieldValue?: string | null }[];
  }[];
  variants?: {
    nodes?: {
      id: string;
      title: string;
      selectedOptions?: { name: string; optionValue?: { id: string; name: string } | null }[];
      metafields?: { nodes?: { key: string; value: string | null }[] };
      /** The authoritative per-variant profile reference, when present. */
      centerSizeProfile?: { value: string | null } | null;
    }[];
  };
}

interface RawMetaobject {
  id: string;
  type: string;
  displayName?: string | null;
  fields?: { key: string; value: string | null }[];
}

function toRecord(
  nodes: { key: string; value: string | null }[] | undefined
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const n of nodes ?? []) out[n.key] = n.value;
  return out;
}

/** One request, checking both of this API's failure modes. A Shopify
 *  operation can be refused inside an HTTP 200, so the transport status alone
 *  proves nothing. */
async function run<T>(
  client: AdminGraphqlClient,
  document: string,
  variables: Record<string, unknown>,
  operation: string
): Promise<T> {
  const response = await client.graphql(document, { variables });
  const envelope = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (envelope.errors && envelope.errors.length > 0) {
    throw new AdminApiError(operation, envelope.errors.map((e) => e.message));
  }
  if (!envelope.data) {
    throw new AdminApiError(operation, ["response contained no data"]);
  }
  return envelope.data;
}
