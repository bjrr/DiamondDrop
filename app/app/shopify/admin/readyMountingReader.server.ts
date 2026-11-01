/**
 * Read a ready-mounting Shopify product, for the Ready Mountings dashboard.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5; owner direction
 * 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, ON PURPOSE
 * ---------------------------------------------------------------------------
 * A ready mounting IS a normal Shopify product. Title, description, images,
 * videos, featured media, media order, alt text, price, SKU, status, metal and
 * ring-size options and inventory are all authored in Shopify Product Admin,
 * which does that job natively and better than we would.
 *
 * This module therefore reads and never writes. An earlier draft of this file
 * carried staged uploads, media attach/reorder/delete and product/variant
 * mutations; that was a duplicate product editor and was removed rather than
 * left to rot. If a write ever reappears here, the single-source-of-truth rule
 * has been broken and staff have two places to edit the same thing.
 *
 * Media bytes never touch our server at all now — we do not even issue upload
 * targets. Private Custom Jewelry inspiration files remain entirely separate,
 * in our own R2 bucket behind a customer account.
 */
import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

export interface ProductMediaItem {
  readonly id: string;
  readonly alt: string | null;
  readonly mediaContentType: string;
  readonly status: string;
  /** Shopify's own preview thumbnail, so the dashboard can show that a video
   *  exists without downloading it. */
  readonly previewUrl: string | null;
  /** Non-empty when Shopify failed to process the upload. A video that will
   *  never play must be visible as a problem, not look fine. */
  readonly errors: readonly string[];
}

export interface ReadyMountingProduct {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
  readonly descriptionHtml: string;
  readonly status: string;
  readonly vendor: string | null;
  readonly productType: string | null;
  readonly media: readonly ProductMediaItem[];
  readonly options: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly variants: readonly {
    readonly id: string;
    readonly title: string;
    readonly sku: string | null;
    readonly price: string | null;
  }[];
}

const READ_PRODUCT = `#graphql
  query CaratReadyMountingProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      status
      vendor
      productType
      media(first: 50) {
        nodes { id alt mediaContentType status preview { image { url } } mediaErrors { message } }
      }
      options { name optionValues { name } }
      variants(first: 50) { nodes { id title sku price } }
    }
  }`;

/**
 * Load a product with its media, for the edit view.
 *
 * This is what makes "reopen the mounting and see everything" work without a
 * second copy of the data: the product IS the source of truth for title,
 * description, options, price and media, and we read it back every time rather
 * than caching any of it.
 */
export async function readReadyMountingProduct(
  client: AdminGraphqlClient,
  productId: string
): Promise<ReadyMountingProduct | null> {
  const data = await run<{
    product?: {
      id: string;
      title: string;
      handle: string;
      descriptionHtml: string | null;
      status: string;
      vendor: string | null;
      productType: string | null;
      media?: { nodes?: RawMedia[] };
      options?: { name: string; optionValues?: { name: string }[] }[];
      variants?: { nodes?: { id: string; title: string; sku: string | null; price: string | null }[] };
    } | null;
  }>(client, READ_PRODUCT, { id: productId }, "product(read)");

  const p = data.product;
  if (!p) return null;

  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    descriptionHtml: p.descriptionHtml ?? "",
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    media: (p.media?.nodes ?? []).map(toMediaItem),
    options: (p.options ?? []).map((o) => ({
      name: o.name,
      values: (o.optionValues ?? []).map((v) => v.name),
    })),
    variants: (p.variants?.nodes ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
    })),
  };
}

// ------------------------------------------------------------------ internals

interface RawMedia {
  id: string;
  alt?: string | null;
  mediaContentType: string;
  status: string;
  preview?: { image?: { url?: string | null } | null } | null;
  mediaErrors?: { message: string }[] | null;
}

function toMediaItem(m: RawMedia): ProductMediaItem {
  return {
    id: m.id,
    alt: m.alt ?? null,
    mediaContentType: m.mediaContentType,
    status: m.status,
    previewUrl: m.preview?.image?.url ?? null,
    errors: (m.mediaErrors ?? []).map((e) => e.message),
  };
}

/**
 * One request, with the two failure modes this API has.
 *
 * A Shopify mutation returns HTTP 200 for a rejected operation — the refusal
 * arrives as `userErrors` inside a successful envelope, and top-level `errors`
 * covers malformed documents and permission problems. Treating either as
 * success is the mistake `productClient.server.ts` already documents, so both
 * are checked here too.
 */
async function run<T>(
  client: AdminGraphqlClient,
  document: string,
  variables: Record<string, unknown>,
  operation: string
): Promise<T> {
  const response = await client.graphql(document, { variables });
  const envelope = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (envelope.errors && envelope.errors.length > 0) {
    throw new AdminApiError(operation, envelope.errors.map((e) => e.message));
  }
  if (!envelope.data) {
    throw new AdminApiError(operation, ["response contained no data"]);
  }
  return envelope.data;
}

function assertNoUserErrors(
  operation: string,
  userErrors: { field?: string[] | null; message: string }[] | undefined
): void {
  if (!userErrors || userErrors.length === 0) return;
  throw new AdminApiError(
    operation,
    userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
  );
}
