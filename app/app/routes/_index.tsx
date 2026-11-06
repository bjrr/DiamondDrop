// `boundary` comes straight from the library, NOT re-exported through
// ~/shopify.server. ErrorBoundary renders on the CLIENT, so importing it via
// a .server module drags server-only code into the client bundle and the
// build fails with "Server-only module referenced by client" — an error that
// names neither this import nor this file. Shopify's own template imports it
// directly for the same reason.
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { AdminNavigation } from "~/components/AdminNavigation";
import { getAdminDashboardCounts, type AdminDashboardCounts } from "~/db/repositories/adminDashboardRepository.server";
import { getEnv } from "~/lib/env.server";
import {
  FIRST_ACCESS_CUSTOMER_TAG,
  shopifyAdminCustomersUrl,
  shopifyAdminProductsUrl,
} from "~/lib/shopifyAdminLinks";
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
  /** Operational queue depths. Counts only: no money, no cost, no margin. */
  counts: AdminDashboardCounts;
  /** Null when the shop domain is not a recognised myshopify host. */
  customersUrl: string | null;
  productsUrl: string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Performs the OAuth handshake on first load and resolves the session on
  // every subsequent one. Throws a redirect when the shop is not yet installed,
  // which is why this loader has no "unauthenticated" branch.
  const { session, admin } = await authenticate.admin(request);
  const devProbe = isDevProbeEnabled();

  // The operational counts, always. Cheap indexed counts; see the repository.
  const counts = await getAdminDashboardCounts();

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
    counts,
    // Built from the authenticated shop domain, never guessed. Null rather
    // than a broken link when the host shape is not recognised.
    customersUrl: shopifyAdminCustomersUrl(session.shop),
    productsUrl: shopifyAdminProductsUrl(session.shop),
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
  const { apiKey, shop, devProbe, products, readError, counts, customersUrl, productsUrl } =
    useLoaderData<typeof loader>();
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
      <AdminNavigation />
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "0 1.5rem 2rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.25rem" }}>CaratForUs Admin</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#5c5f62", fontSize: "0.875rem" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        <NeedsAttention counts={counts} />

        <Group title="Sales and special programs">
          <Card
            title="Group Buys"
            to="/app/group-buy-campaigns"
            note={counts.groupBuyDraft + " draft, " + counts.groupBuyOpen + " open"}
          />
          <Card
            title="Group Buy demand"
            to="/app/group-buy-demand"
            note={pluralise(counts.groupBuyDemandOutstanding, "request", "awaiting notification")}
          />
          <Card
            title="Luxury Steals"
            to="/app/luxury-steals"
            note={pluralise(
              counts.luxuryStealSyncFailures + counts.luxuryStealUnmatchedOrderChecks,
              "item",
              "needing attention"
            )}
          />
          <Card
            title="Let Us Beat Your Quote"
            to="/app/beat-quote"
            note={pluralise(counts.beatQuotePendingReview, "submission", "awaiting review")}
          />
        </Group>

        <Group title="Customer and order operations">
          <Card
            title="Bank Payments"
            to="/app/bank-payments"
            note={pluralise(counts.bankPaymentsOpen, "order", "open")}
          />
          <Card
            title="Custom Jewelry"
            to="/app/custom-jewelry"
            note={pluralise(counts.customJewelryActionable, "project", "needing action")}
          />
          <Card
            title="Returns and RMAs"
            to="/app/rma"
            note={pluralise(counts.rmaOpen, "request", "open")}
          />
          <Card
            title="Warranty Claims"
            to="/app/warranty-claims"
            note={pluralise(counts.warrantyOpen, "claim", "open")}
          />
          {/* Shipment has no status column, so there is no honest open count. */}
          <Card title="Shipments" to="/app/shipments" note={null} />
        </Group>

        <Group title="First Access">
          <ExternalCard
            title="First Access signups"
            href={customersUrl}
            body="View and manage First Access signups in Shopify Customers."
            hint={"Filter by tag: " + FIRST_ACCESS_CUSTOMER_TAG}
          />
        </Group>

        <Group title="Catalog and configuration">
          <ExternalCard
            title="Products"
            href={productsUrl}
            body="Products, variants, media, pricing and inventory are managed in Shopify Product Admin."
            hint={null}
          />
          <Card
            title="Ready Mountings"
            to="/app/ready-settings"
            note="Validation and audit only. Fix products in Shopify."
          />
          <Card
            title="Pricing Settings"
            to="/app/pricing-settings"
            note="Profiles, metals, labor, stones"
          />
          <Card
            title="Price Approvals"
            to="/app/price-approvals"
            note="A price was calculated and needs a decision"
          />
          <Card title="Pricing Alerts" to="/alerts" note="A calculation or Shopify sync failed" />
        </Group>

        {devProbe ? (
          <section style={{ borderTop: "1px solid #ddd", paddingTop: "1rem", marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>Development Tools</h2>
            <h3 style={{ fontSize: "0.9rem", margin: "0.5rem 0 0.25rem" }}>Admin API probe</h3>
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

/* ---------------------------------------------------------------------------
   Dashboard presentation.

   Deliberately tiny and local. These are four helpers and a stylesheet-free
   layout, not a component library: the admin home is a worklist and a set of
   links, and the moment it grows a design system it starts competing with
   Shopify Admin instead of pointing at it.
   ------------------------------------------------------------------------ */

/** "3 orders open", or null when there is nothing to say. Zero is not news. */
function pluralise(n: number, noun: string, suffix: string): string | null {
  if (n <= 0) return null;
  return n + " " + noun + (n === 1 ? "" : "s") + " " + suffix;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: "0 0 1.75rem" }}>
      <h2
        style={{
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6d7175",
          margin: "0 0 0.6rem",
        }}
      >
        {title}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>{children}</div>
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  display: "block",
  minWidth: "15rem",
  flex: "1 1 15rem",
  maxWidth: "22rem",
  padding: "0.85rem 1rem",
  border: "1px solid #e1e3e5",
  borderRadius: "0.5rem",
  textDecoration: "none",
  color: "inherit",
  background: "#fff",
};

function Card({ title, to, note }: { title: string; to: string; note: string | null }) {
  return (
    <Link to={to} style={cardStyle}>
      <strong style={{ display: "block", fontSize: "0.9375rem" }}>{title}</strong>
      {note ? (
        <span style={{ fontSize: "0.8125rem", color: "#5c5f62" }}>{note}</span>
      ) : null}
    </Link>
  );
}

/**
 * A link out to Shopify Admin.
 *
 * Renders as plain text when the URL could not be derived, rather than as a
 * dead link: the instruction is still useful, and a link that goes nowhere is
 * worse than none.
 */
function ExternalCard({
  title,
  href,
  body,
  hint,
}: {
  title: string;
  href: string | null;
  body: string;
  hint: string | null;
}) {
  const inner = (
    <>
      <strong style={{ display: "block", fontSize: "0.9375rem" }}>{title}</strong>
      <span style={{ display: "block", fontSize: "0.8125rem", color: "#5c5f62" }}>{body}</span>
      {hint ? (
        <span style={{ display: "block", fontSize: "0.8125rem", color: "#6d7175", marginTop: "0.25rem" }}>
          <strong>{hint}</strong>
        </span>
      ) : null}
    </>
  );
  if (!href) return <div style={cardStyle}>{inner}</div>;
  return (
    <a href={href} target="_blank" rel="noreferrer" style={cardStyle}>
      {inner}
    </a>
  );
}

/**
 * The only section that is allowed to be empty, and says so when it is.
 *
 * Everything listed here is work somebody owes. Nothing is listed to fill
 * space: a queue at zero is omitted entirely, and if every queue is at zero
 * the section says so in one sentence rather than showing a wall of noughts.
 */
function NeedsAttention({ counts }: { counts: AdminDashboardCounts }) {
  const items: { label: string; to: string }[] = [];
  const add = (n: number, label: string, to: string) => {
    if (n > 0) items.push({ label: n + " " + label, to });
  };

  add(counts.openAlerts, "open pricing alert(s)", "/alerts");
  add(counts.beatQuotePendingReview, "quote review(s) waiting", "/app/beat-quote");
  add(counts.bankPaymentsOpen, "bank payment order(s) open", "/app/bank-payments");
  add(counts.groupBuyBankPaymentsOpen, "Group Buy bank payment(s) active", "/app/group-buy-campaigns");
  add(counts.customJewelryActionable, "custom jewelry project(s) needing action", "/app/custom-jewelry");
  add(counts.rmaOpen, "open RMA(s)", "/app/rma");
  add(counts.warrantyOpen, "open warranty claim(s)", "/app/warranty-claims");
  add(counts.luxuryStealSyncFailures, "Luxury Steal sync failure(s)", "/app/luxury-steals");
  add(counts.luxuryStealUnmatchedOrderChecks, "unmatched Luxury Steal order check(s)", "/app/luxury-steals");
  add(counts.groupBuyDemandOutstanding, "demand signal(s) awaiting notification", "/app/group-buy-demand");

  return (
    <section
      style={{
        margin: "0 0 1.75rem",
        padding: "0.85rem 1rem",
        border: "1px solid #e1e3e5",
        borderRadius: "0.5rem",
        background: "#fafbfb",
      }}
    >
      <h2
        style={{
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6d7175",
          margin: "0 0 0.6rem",
        }}
      >
        Needs attention
      </h2>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.875rem" }}>
          Everything requiring staff attention is clear.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.875rem", lineHeight: 1.8 }}>
          {items.map((item) => (
            <li key={item.label}>
              <Link to={item.to}>{item.label}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
