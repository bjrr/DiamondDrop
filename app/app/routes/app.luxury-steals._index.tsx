import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  bulkAssignLuxuryStealForProduct,
  listLuxuryStealProductAssignments,
  setLuxuryStealAssignment,
  type LuxuryStealAdminVariantRow,
} from "~/db/repositories/luxuryStealRepository.server";
import { listOpenLuxuryStealSyncFailures } from "~/db/repositories/luxuryStealSyncFailureRepository.server";
import { EmptyLuxuryStealBulkAssignmentError } from "~/domain/luxurysteals/assignment";
import {
  ShopifyLuxuryStealMetafieldSyncPort,
  type LuxuryStealMetafieldSyncPort,
} from "~/jobs/luxurysteals/ports";
import {
  syncLuxuryStealAssignment,
  syncLuxuryStealAssignments,
  type SyncLuxuryStealAssignmentOutcome,
} from "~/jobs/luxurysteals/syncAssignment.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/luxury-steals — the Luxury Steal assignment admin surface
 * (Slice 3 task 3-2b, docs/specs/SLICE-3-LUXURY-STEALS.md D27, criteria 125,
 * 128, 146-152).
 *
 * ASSIGNS AND UNASSIGNS PER VARIANT (D27 — the authoritative grain), plus a
 * product-level "apply to all variants" convenience (§5) that writes N
 * variant rows through the exact same controlled path, never a second
 * storage location. Every mutation here is a Postgres write FIRST — the
 * system of record — followed by a best-effort metafield sync; the sync's
 * outcome is reported back to the admin but never blocks or reverts the
 * assignment itself (criterion 152).
 *
 * SHOWS CURRENT SYNC STATE PER VARIANT, INCLUDING FAILURES, with a manual
 * "Retry sync" action — the assigning message's explicit requirement. A
 * failed sync never marks the variant unavailable and is never conflated
 * with the storefront's own purchasability, which this page has no control
 * over at all.
 *
 * A DEFAULT EXPORT WITH AN ACTION — see
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES` for the
 * reasoned exemption added there, identical argument to
 * `app.bank-payments._id.tsx`: Shopify Admin iframes this route at the
 * app's own host, so every POST it makes is same-origin by construction.
 *
 * NEVER EXPOSES supplier cost, margin or internal pricing data (CLAUDE.md
 * rule 10) — this page shows only identification (metal/purity/band),
 * assignment state and sync health.
 */

export interface VariantView {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  readonly isLuxurySteal: boolean;
  readonly metal: string;
  readonly purity: string;
  readonly bandLabel: string | null;
  readonly syncFailure: {
    readonly attemptCount: number;
    readonly lastError: string;
    readonly firstFailedAt: string;
  } | null;
}

export interface ProductView {
  readonly masterProductId: string;
  readonly name: string;
  readonly variants: readonly VariantView[];
}

interface LoaderData {
  apiKey: string;
  shop: string;
  query: string;
  products: ProductView[];
  loadError: string | null;
}

function toVariantView(
  variant: LuxuryStealAdminVariantRow,
  failureByVariantId: Map<string, { attemptCount: number; lastError: string; firstFailedAt: Date }>
): VariantView {
  const failure = failureByVariantId.get(variant.masterVariantId);
  return {
    masterVariantId: variant.masterVariantId,
    shopifyVariantGid: variant.shopifyVariantGid,
    isLuxurySteal: variant.isLuxurySteal,
    metal: variant.metal,
    purity: variant.purity,
    bandLabel: variant.bandLabel,
    syncFailure: failure
      ? {
          attemptCount: failure.attemptCount,
          lastError: failure.lastError,
          firstFailedAt: failure.firstFailedAt.toISOString(),
        }
      : null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";

  let products: ProductView[] = [];
  let loadError: string | null = null;
  try {
    const listing = await listLuxuryStealProductAssignments(query || undefined);
    const openFailures = await listOpenLuxuryStealSyncFailures();
    const failureByVariantId = new Map(openFailures.map((f) => [f.masterVariantId, f]));

    products = listing.map((product) => ({
      masterProductId: product.masterProductId,
      name: product.name,
      variants: product.variants.map((variant) => toVariantView(variant, failureByVariantId)),
    }));
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Luxury Steal assignments.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    query,
    products,
    loadError,
  } satisfies LoaderData;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
  outcome: SyncLuxuryStealAssignmentOutcome | SyncLuxuryStealAssignmentOutcome[] | null;
}

function requireField(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Response(`Missing required field: ${field}`, { status: 400 });
  }
  return value;
}

/** Resolves the AUTHENTICATED Shopify staff identity from the online session — same discipline as app.bank-payments.$id.tsx's D23. Every sync this route triggers is attributed to whoever performed the admin action, never a typed name. */
function resolveStaffTrigger(
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"]
): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false, formError: "Method not allowed.", outcome: null } satisfies ActionData, {
      status: 405,
    });
  }

  const trigger = resolveStaffTrigger(session);
  if (!trigger) {
    logger.error("luxurysteals.admin_no_online_user", {});
    return Response.json(
      {
        ok: false,
        formError:
          "This request could not be attributed to a signed-in Shopify staff member (no online session). " +
          "Reload the page and try again.",
        outcome: null,
      } satisfies ActionData,
      { status: 401 }
    );
  }

  const port: LuxuryStealMetafieldSyncPort =
    luxuryStealSyncPortOverrideForTests ?? new ShopifyLuxuryStealMetafieldSyncPort(admin);

  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    switch (intent) {
      case "assign":
      case "unassign": {
        const masterVariantId = requireField(formData, "masterVariantId");
        await setLuxuryStealAssignment(masterVariantId, intent === "assign");
        const outcome = await syncLuxuryStealAssignment(masterVariantId, { port, trigger });
        return Response.json({ ok: true, formError: null, outcome } satisfies ActionData);
      }
      case "apply-to-product": {
        const masterProductId = requireField(formData, "masterProductId");
        const isLuxurySteal = formData.get("isLuxurySteal") === "true";
        const bulkResult = await bulkAssignLuxuryStealForProduct(masterProductId, isLuxurySteal);
        const outcome = await syncLuxuryStealAssignments(bulkResult.updatedMasterVariantIds, { port, trigger });
        return Response.json({ ok: true, formError: null, outcome } satisfies ActionData);
      }
      case "retry-sync": {
        const masterVariantId = requireField(formData, "masterVariantId");
        const outcome = await syncLuxuryStealAssignment(masterVariantId, { port, trigger });
        return Response.json({ ok: true, formError: null, outcome } satisfies ActionData);
      }
      default:
        return Response.json(
          { ok: false, formError: `Unknown action "${String(intent)}".`, outcome: null } satisfies ActionData,
          { status: 400 }
        );
    }
  } catch (error) {
    if (error instanceof EmptyLuxuryStealBulkAssignmentError) {
      return Response.json(
        { ok: false, formError: error.message, outcome: null } satisfies ActionData,
        { status: 400 }
      );
    }
    logger.error("luxurysteals.admin_action_failed", {
      intent: String(intent),
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      {
        ok: false,
        formError: error instanceof Error ? error.message : "The request failed unexpectedly.",
        outcome: null,
      } satisfies ActionData,
      { status: 500 }
    );
  }
}

/**
 * TEST-ONLY OVERRIDE HOOK, identical pattern to
 * `app.bank-payments.$id.tsx`'s `__setDraftOrderPortForTests`.
 */
let luxuryStealSyncPortOverrideForTests: LuxuryStealMetafieldSyncPort | null = null;
export function __setLuxuryStealSyncPortForTests(port: LuxuryStealMetafieldSyncPort | null): void {
  luxuryStealSyncPortOverrideForTests = port;
}

function formatTimestamp(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function variantLabel(variant: VariantView): string {
  const parts = [variant.metal, variant.purity];
  if (variant.bandLabel) parts.push(`band ${variant.bandLabel}`);
  return parts.join(" / ");
}

function SyncFailureNotice({ syncFailure }: { syncFailure: VariantView["syncFailure"] }) {
  if (!syncFailure) return null;
  return (
    <p role="alert" style={{ margin: "0.35rem 0 0", color: "#b06a00", fontSize: "0.8rem" }}>
      Sync failing since <time dateTime={syncFailure.firstFailedAt}>{formatTimestamp(syncFailure.firstFailedAt)}</time>{" "}
      ({syncFailure.attemptCount} attempt{syncFailure.attemptCount === 1 ? "" : "s"}): {syncFailure.lastError}. The
      variant is still purchasable — only the storefront badge/disclosure may be stale.
    </p>
  );
}

function VariantRow({ variant, busy }: { variant: VariantView; busy: boolean }) {
  return (
    <li style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "0.6rem 0.8rem", marginBottom: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
        <div>
          <p style={{ margin: 0, fontWeight: 600 }}>{variantLabel(variant)}</p>
          <p style={{ margin: "0.1rem 0 0", fontSize: "0.8rem", color: "#555" }}>
            {variant.shopifyVariantGid ? (
              <code>{variant.shopifyVariantGid}</code>
            ) : (
              "Not yet linked to a Shopify variant"
            )}
            {" — "}
            {variant.isLuxurySteal ? "Assigned (Luxury Steal, Final Sale)" : "Not assigned"}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Form method="post">
            <input type="hidden" name="masterVariantId" value={variant.masterVariantId} />
            <input type="hidden" name="intent" value={variant.isLuxurySteal ? "unassign" : "assign"} />
            <button type="submit" disabled={busy}>
              {variant.isLuxurySteal ? "Unassign" : "Assign"}
            </button>
          </Form>
          {variant.syncFailure ? (
            <Form method="post">
              <input type="hidden" name="masterVariantId" value={variant.masterVariantId} />
              <input type="hidden" name="intent" value="retry-sync" />
              <button type="submit" disabled={busy}>
                Retry sync
              </button>
            </Form>
          ) : null}
        </div>
      </div>
      <SyncFailureNotice syncFailure={variant.syncFailure} />
    </li>
  );
}

function ProductSection({ product, busy }: { product: ProductView; busy: boolean }) {
  return (
    <section style={{ marginBottom: "1.5rem", border: "1px solid #ccc", borderRadius: "4px", padding: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h2 style={{ fontSize: "1rem", margin: 0 }}>{product.name}</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Form method="post">
            <input type="hidden" name="masterProductId" value={product.masterProductId} />
            <input type="hidden" name="intent" value="apply-to-product" />
            <input type="hidden" name="isLuxurySteal" value="true" />
            <button type="submit" disabled={busy}>
              Assign all variants
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="masterProductId" value={product.masterProductId} />
            <input type="hidden" name="intent" value="apply-to-product" />
            <input type="hidden" name="isLuxurySteal" value="false" />
            <button type="submit" disabled={busy}>
              Unassign all variants
            </button>
          </Form>
        </div>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {product.variants.map((variant) => (
          <VariantRow key={variant.masterVariantId} variant={variant} busy={busy} />
        ))}
      </ul>
    </section>
  );
}

export default function LuxuryStealsAssignmentPage() {
  const { apiKey, shop, query, products, loadError } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/luxury-steals/held-orders">View held orders (unmatched Luxury Steal checks) &rarr;</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Luxury Steal assignment</h1>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>. Assignment is per variant (D27) and is the system of record —
          the <code>carat.luxury_steal</code> metafield is a synced presentation cache only.
        </p>

        <Form method="get" role="search" style={{ margin: "0 0 1.5rem", display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <div>
            <label htmlFor="q" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.25rem" }}>
              Search by product name
            </label>
            <input
              id="q"
              name="q"
              type="text"
              defaultValue={query}
              style={{ padding: "0.4rem 0.6rem", minWidth: "22rem" }}
              placeholder="e.g. Solitaire Ring"
            />
          </div>
          <button type="submit">Search</button>
          {query ? (
            <Link to="/app/luxury-steals" style={{ marginLeft: "0.5rem" }}>
              Clear — show every product
            </Link>
          ) : null}
        </Form>

        {actionData && !actionData.ok && actionData.formError ? (
          <p role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
            {actionData.formError}
          </p>
        ) : null}

        {loadError ? (
          <p role="alert" style={{ color: "#b00" }}>
            Could not load Luxury Steal assignments: {loadError}
          </p>
        ) : products.length === 0 ? (
          <p style={{ color: "#555" }}>
            {query ? `No product matched "${query}".` : "No products found."}
          </p>
        ) : (
          products.map((product) => <ProductSection key={product.masterProductId} product={product} busy={busy} />)
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
