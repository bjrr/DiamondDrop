/**
 * A thin, testable wrapper over the Shopify Admin GraphQL API for products.
 *
 * WHY A WRAPPER RATHER THAN CALLING admin.graphql DIRECTLY.
 *
 * Two reasons, and the second is the important one.
 *
 * 1. The client is INJECTED as a structural interface, so every function here
 *    is unit-testable against a fake without a store, a session, or a network.
 *    Routes pass the real client from `authenticate.admin`.
 *
 * 2. THE ADMIN API REPORTS FAILURES WITH HTTP 200. A malformed mutation comes
 *    back as `errors`, and a rejected one — bad id, validation failure,
 *    insufficient permission — comes back as `userErrors` inside a perfectly
 *    successful response. Code that checks `response.ok` and moves on treats
 *    both as success. That is exactly how a price sync would report publishing
 *    a price it never published, so the checking lives HERE, once, rather than
 *    at each call site where it can be forgotten.
 *
 * SHAPES VERIFIED AGAINST API VERSION 2026-07 BY INTROSPECTION, not assumed:
 * productCreate and productUpdate take `product:`, productDelete takes
 * `input:`. Older API versions used `input:` for all three, so a mutation
 * copied from an older example fails on this version.
 */

/** The subset of the library's admin client these functions need. */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ): Promise<{ json: () => Promise<unknown> }>;
}

export interface ShopifyProduct {
  /** Global id, e.g. "gid://shopify/Product/123". */
  id: string;
  title: string;
  status: string;
}

export class AdminApiError extends Error {
  constructor(
    readonly operation: string,
    readonly problems: readonly string[]
  ) {
    super(`Shopify Admin API ${operation} failed: ${problems.join("; ")}`);
    this.name = "AdminApiError";
  }
}

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

/**
 * Runs a document and returns `data`, throwing on either failure mode.
 * Never logs the response: Admin payloads can carry customer and order data.
 */
async function execute(
  client: AdminGraphqlClient,
  operation: string,
  document: string,
  variables?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await client.graphql(document, variables ? { variables } : undefined);
  const body = (await response.json()) as GraphqlEnvelope;

  if (body.errors?.length) {
    throw new AdminApiError(operation, body.errors.map((e) => e.message));
  }
  if (!body.data) {
    throw new AdminApiError(operation, ["response contained no data"]);
  }
  return body.data;
}

/**
 * Mutations nest their own failures under `userErrors`. Unwraps the payload and
 * throws if any are present, so a caller cannot mistake a rejected mutation for
 * a completed one.
 */
function unwrapMutation(
  operation: string,
  data: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const payload = data[field] as
    | { userErrors?: { field?: string[] | null; message: string }[] }
    | undefined;

  if (!payload) throw new AdminApiError(operation, [`response had no ${field} payload`]);

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new AdminApiError(
      operation,
      userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
    );
  }
  return payload as Record<string, unknown>;
}

/** READ. Returns [] for an empty catalog — absence is not an error. */
export async function listProducts(
  client: AdminGraphqlClient,
  limit = 5
): Promise<ShopifyProduct[]> {
  const data = await execute(
    client,
    "listProducts",
    `#graphql
      query CaratListProducts($first: Int!) {
        products(first: $first) { nodes { id title status } }
      }`,
    { first: limit }
  );

  const products = data.products as { nodes?: ShopifyProduct[] } | undefined;
  return products?.nodes ?? [];
}

/** READ one. Returns null when the id does not resolve, rather than throwing. */
export async function getProduct(
  client: AdminGraphqlClient,
  id: string
): Promise<ShopifyProduct | null> {
  const data = await execute(
    client,
    "getProduct",
    `#graphql
      query CaratGetProduct($id: ID!) {
        product(id: $id) { id title status }
      }`,
    { id }
  );

  return (data.product as ShopifyProduct | null) ?? null;
}

/**
 * WRITE. Creates a DRAFT product.
 *
 * Draft, never active: a probe product must not become purchasable on the
 * storefront even for the seconds it exists.
 */
export async function createProduct(
  client: AdminGraphqlClient,
  title: string
): Promise<ShopifyProduct> {
  const data = await execute(
    client,
    "createProduct",
    `#graphql
      mutation CaratCreateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id title status }
          userErrors { field message }
        }
      }`,
    { product: { title, status: "DRAFT" } }
  );

  return unwrapMutation("createProduct", data, "productCreate").product as ShopifyProduct;
}

/** WRITE. Renames an existing product — the reversible half of the probe. */
export async function renameProduct(
  client: AdminGraphqlClient,
  id: string,
  title: string
): Promise<ShopifyProduct> {
  const data = await execute(
    client,
    "renameProduct",
    `#graphql
      mutation CaratRenameProduct($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id title status }
          userErrors { field message }
        }
      }`,
    { product: { id, title } }
  );

  return unwrapMutation("renameProduct", data, "productUpdate").product as ShopifyProduct;
}

/** WRITE. Removes a product, undoing a create. */
export async function deleteProduct(client: AdminGraphqlClient, id: string): Promise<string> {
  const data = await execute(
    client,
    "deleteProduct",
    `#graphql
      mutation CaratDeleteProduct($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }`,
    { input: { id } }
  );

  const payload = unwrapMutation("deleteProduct", data, "productDelete");
  return payload.deletedProductId as string;
}
