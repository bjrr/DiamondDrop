// `boundary` comes straight from the library, NOT re-exported through
// ~/shopify.server. ErrorBoundary renders on the CLIENT, so importing it via
// a .server module drags server-only code into the client bundle and the
// build fails with "Server-only module referenced by client" — an error that
// names neither this import nor this file. Shopify's own template imports it
// directly for the same reason.
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { getEnv } from "~/lib/env.server";
import {
  AdminApiError,
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  renameProduct,
  type ShopifyProduct,
} from "~/shopify/admin/productClient.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * The embedded app home, served at "/" — the URL Shopify Admin opens.
 *
 * Also carries the Slice 2 Admin API probe: a read of the catalogue, and a
 * deliberately controlled write. Both are DEVELOPMENT ONLY (see isDevProbe),
 * because a button that creates and deletes products has no business existing
 * in a production admin.
 *
 * WHAT THE WRITE DELIBERATELY DOES NOT DO. It never touches an existing
 * product. It creates its own draft product, renames it, reads it back, and
 * offers a delete — so proving write access cannot alter a single thing the
 * store already had. Shopify's generated sample products are left alone even
 * though they are disposable, because "it was only the test data" is a bad
 * habit to build on a store that will one day be real.
 */

const PROBE_TITLE_PREFIX = "CaratForUs integration probe";

/** Dev-only. The probe UI and its action are absent in production. */
function isDevProbeEnabled(): boolean {
  return getEnv().APP_ENV !== "production";
}

interface LoaderData {
  apiKey: string;
  shop: string;
  devProbe: boolean;
  products: ShopifyProduct[];
  readError: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Performs the OAuth handshake on first load and resolves the session on
  // every subsequent one. Throws a redirect when the shop is not yet installed,
  // which is why this loader has no "unauthenticated" branch.
  const { session, admin } = await authenticate.admin(request);
  const devProbe = isDevProbeEnabled();

  let products: ShopifyProduct[] = [];
  let readError: string | null = null;

  if (devProbe) {
    try {
      products = await listProducts(admin, 5);
    } catch (error) {
      // A failed probe must not blank the page — the page is also how you find
      // out the probe failed. The message is surfaced, never the response body,
      // which can carry catalogue and customer data.
      readError = error instanceof AdminApiError ? error.message : "Admin API read failed.";
    }
  }

  return {
    // The PUBLIC client id, not the secret. App Bridge needs it in the browser,
    // and it already ships in shopify.app.caratforus-development.toml.
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    devProbe,
    products,
    readError,
  } satisfies LoaderData;
}

interface ActionData {
  ok: boolean;
  message: string;
  /** Present after a successful create, so the delete form can target it. */
  probeProductId?: string;
  /** What reading the product back actually returned — the verification step. */
  verified?: { id: string; title: string; status: string };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  // Checked after authenticating, so an unauthenticated caller learns nothing
  // about which routes exist.
  if (!isDevProbeEnabled()) {
    return Response.json({ ok: false, message: "Probe disabled outside development." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = form.get("intent");

  // Proves the action was REACHED. The CSRF origin guard rejects a forwarded
  // POST inside React Router's single-fetch handler, before any route code
  // runs, so its absence in the log distinguishes "our action failed" from
  // "our action never executed". Records the intent only — no form values, no
  // session, no tokens.
  logger.info("shopify.probe.action_entered", { intent: String(intent ?? "none") });

  try {
    if (intent === "write-probe") {
      // Timestamp comes from the server clock rather than the client, so the
      // title cannot be steered by a crafted request.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const created = await createProduct(admin, `${PROBE_TITLE_PREFIX} ${stamp}`);
      const renamed = await renameProduct(admin, created.id, `${PROBE_TITLE_PREFIX} ${stamp} (renamed)`);

      // THE VERIFICATION. Re-read from Shopify rather than trusting the
      // mutation's own echo: a mutation response reporting the value we sent
      // proves the request was accepted, not that it was persisted.
      const readBack = await getProduct(admin, renamed.id);
      if (!readBack) {
        return Response.json({
          ok: false,
          message: `Created ${renamed.id} but reading it back returned nothing.`,
        } satisfies ActionData);
      }

      return Response.json({
        ok: true,
        message: "Created a draft product, renamed it, and read the change back from Shopify.",
        probeProductId: readBack.id,
        verified: { id: readBack.id, title: readBack.title, status: readBack.status },
      } satisfies ActionData);
    }

    if (intent === "delete-probe") {
      const id = String(form.get("productId") ?? "");

      // Only ever deletes something this probe created. Without this check the
      // form would be a delete-any-product endpoint, which is not what proving
      // write access requires.
      const existing = await getProduct(admin, id);
      if (!existing) {
        return Response.json({ ok: false, message: "That product no longer exists." } satisfies ActionData);
      }
      if (!existing.title.startsWith(PROBE_TITLE_PREFIX)) {
        return Response.json({
          ok: false,
          message: "Refused: that product was not created by the probe.",
        } satisfies ActionData);
      }

      const deletedId = await deleteProduct(admin, id);
      const gone = await getProduct(admin, deletedId);

      return Response.json({
        ok: gone === null,
        message:
          gone === null
            ? `Deleted ${deletedId} and confirmed it is gone. The store is back to its original state.`
            : `Delete reported success but ${deletedId} is still readable.`,
      } satisfies ActionData);
    }

    return Response.json({ ok: false, message: "Unknown action." } satisfies ActionData, { status: 400 });
  } catch (error) {
    return Response.json({
      ok: false,
      message: error instanceof AdminApiError ? error.message : "Admin API write failed.",
    } satisfies ActionData);
  }
}

export default function AppHome() {
  const { apiKey, shop, devProbe, products, readError } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    // Injects App Bridge and the Polaris web components. Required for the
    // embedded frame to negotiate session tokens on later navigations — without
    // it the first render works and everything after it fails to authenticate.
    <AppProvider apiKey={apiKey}>
      {/*
        Plain semantic HTML rather than Polaris web components. Those ship
        untyped, and adding ambient JSX declarations for a developer-only page
        would be more code than the page itself.
      */}
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>CaratForUs</h1>
        <p style={{ margin: "0 0 0.75rem" }}>
          Connected to <strong>{shop}</strong>.
        </p>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Buy Now pricing runs on a daily schedule. Price changes beyond the configured
          tolerance wait for approval here; nothing publishes to Shopify automatically yet.
        </p>

        {devProbe ? (
          <section style={{ borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>Admin API probe</h2>
            <p style={{ margin: "0 0 1rem", color: "#777", fontSize: "0.875rem" }}>
              Development only. Proves read and write access against this store.
            </p>

            <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Read — first 5 products</h3>
            {readError ? (
              <p style={{ color: "#b00", margin: "0 0 1rem" }}>{readError}</p>
            ) : products.length === 0 ? (
              <p style={{ margin: "0 0 1rem", color: "#777" }}>
                No products in this store. The read succeeded — the catalogue is simply empty.
              </p>
            ) : (
              <ul style={{ margin: "0 0 1rem", paddingLeft: "1.25rem" }}>
                {products.map((p) => (
                  <li key={p.id} style={{ fontSize: "0.875rem" }}>
                    <code>{p.id}</code> — {p.title}{" "}
                    <span style={{ color: "#777" }}>({p.status})</span>
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Write — controlled probe</h3>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#555" }}>
              Creates its own <strong>draft</strong> product, renames it, then reads the change back.
              No existing product is touched, and the delete button reverses it completely.
            </p>

            <Form method="post" style={{ display: "inline-block", marginRight: "0.5rem" }}>
              <input type="hidden" name="intent" value="write-probe" />
              <button type="submit" disabled={busy}>
                {busy ? "Working…" : "Run write probe"}
              </button>
            </Form>

            {actionData?.probeProductId ? (
              <Form method="post" style={{ display: "inline-block" }}>
                <input type="hidden" name="intent" value="delete-probe" />
                <input type="hidden" name="productId" value={actionData.probeProductId} />
                <button type="submit" disabled={busy}>
                  Delete probe product
                </button>
              </Form>
            ) : null}

            {actionData ? (
              <div style={{ marginTop: "1rem", fontSize: "0.875rem" }}>
                <p style={{ margin: "0 0 0.25rem", color: actionData.ok ? "#060" : "#b00" }}>
                  {actionData.ok ? "OK" : "Failed"} — {actionData.message}
                </p>
                {actionData.verified ? (
                  <p style={{ margin: 0, color: "#555" }}>
                    Read back from Shopify: <code>{actionData.verified.id}</code> —{" "}
                    {actionData.verified.title} ({actionData.verified.status})
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </AppProvider>
  );
}

/**
 * Re-emits Shopify's document headers on data and error responses. Without
 * this, a single-fetch action response loses frame-ancestors and the embedded
 * frame breaks — the same failure mode as the blank page, arriving later and
 * looking unrelated.
 */
export const headers: HeadersFunction = (args) => boundary.headers(args);

/**
 * The library drives re-authentication by THROWING redirect Responses. A plain
 * error boundary would catch those and render an error page, turning a routine
 * session refresh into a dead end; boundary.error re-throws them and renders
 * only genuine errors.
 */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
