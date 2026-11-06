import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";

import { AdminNavigation } from "~/components/AdminNavigation";
import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /app/ready-settings — the Ready Mountings audit dashboard.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5; owner direction
 * 2026-11-01.
 *
 * ============================================================================
 * READ-ONLY. THERE IS NO ACTION, AND THAT IS THE DESIGN.
 * ============================================================================
 * Shopify Product Admin is the authoring surface for everything a storefront
 * needs — title, description, media, featured image, price, SKU, status,
 * options, inventory — and for the Set Your Own Stone metafields and Center
 * Stone Size Profiles too, which are pinned so they appear there natively.
 *
 * This page validates and audits. It answers "what is wrong with my
 * mountings" and then sends staff to Shopify to fix it. An earlier version of
 * this route was a product-and-media editor; it worked, and it was a second
 * editable source of truth, so it was removed. If an `action` export ever
 * reappears here, that mistake has been repeated.
 *
 * The rows it reads are a DERIVED PROJECTION, written only by the sync
 * service from Shopify events and reconciliation. Nothing on this screen can
 * change them, and `syncProblems` is what the projection recorded rather than
 * anything computed here — so the dashboard cannot disagree with the matcher.
 */

/** One problem worth a staff member's attention, in the order they should care. */
type Severity = "blocking" | "attention" | "info";

interface Finding {
  readonly severity: Severity;
  readonly label: string;
}

interface Row {
  readonly id: string;
  readonly productGid: string;
  readonly variantGid: string;
  readonly centerSizeProfileId: string | null;
  readonly shape: string;
  readonly nominalLengthUm: number;
  readonly nominalWidthUm: number;
  readonly hasVendorRange: boolean;
  readonly vendorRangeSource: string | null;
  readonly eligible: boolean;
  readonly prongTolerance: boolean;
  readonly isActive: boolean;
  readonly syncedAt: string | null;
  readonly problems: readonly string[];
  readonly findings: readonly Finding[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const rows = await prisma.readySettingCompatibility.findMany({
    orderBy: [{ shopifyProductGid: "asc" }, { nominalLengthUm: "asc" }, { nominalWidthUm: "asc" }],
  });

  const projected: Row[] = rows.map((r) => {
    const problems = Array.isArray(r.syncProblems) ? (r.syncProblems as string[]) : [];
    const findings: Finding[] = [];

    // Every problem the projection recorded, verbatim. Not re-derived here:
    // re-deriving would let the dashboard disagree with the matcher, which is
    // the one thing an audit surface must never do.
    for (const problem of problems) findings.push({ severity: "blocking", label: problem });

    if (r.centerSizeProfileId === null) {
      findings.push({
        severity: "blocking",
        label: "No Center Stone Size Profile is linked, so shape and dimensions are unknown.",
      });
    }
    if (r.minLengthUm !== null && r.vendorRangeSource === null) {
      findings.push({
        severity: "attention",
        label: "A vendor range is set with no source recorded.",
      });
    }
    if (!r.isActive) {
      findings.push({ severity: "info", label: "Withdrawn — compatibility is inactive." });
    }
    if (r.syncedFromShopifyAt === null) {
      findings.push({
        severity: "attention",
        label: "Never synchronized from Shopify. Run reconciliation or edit the product to trigger an event.",
      });
    }

    return {
      id: r.id,
      productGid: r.shopifyProductGid,
      variantGid: r.shopifyVariantGid,
      centerSizeProfileId: r.centerSizeProfileId,
      shape: r.shape,
      nominalLengthUm: r.nominalLengthUm,
      nominalWidthUm: r.nominalWidthUm,
      hasVendorRange: r.minLengthUm !== null,
      vendorRangeSource: r.vendorRangeSource,
      eligible: r.eligibleForSetYourOwnStone,
      prongTolerance: r.prongSetToleranceEligible,
      isActive: r.isActive,
      syncedAt: r.syncedFromShopifyAt ? r.syncedFromShopifyAt.toISOString() : null,
      problems,
      findings,
    };
  });

  const lastSync = projected
    .map((r) => r.syncedAt)
    .filter((x): x is string => x !== null)
    .sort()
    .at(-1) ?? null;

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shopDomain: getEnv().SHOPIFY_SHOP_DOMAIN ?? "",
    rows: projected,
    summary: {
      total: projected.length,
      offered: projected.filter((r) => r.eligible && r.isActive).length,
      needingAttention: projected.filter((r) => r.findings.some((f) => f.severity !== "info")).length,
      lastSync,
    },
  };
}

// ======================================================================= view

const page: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "1.5rem",
  lineHeight: 1.5,
  maxWidth: "72rem",
};
const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "1rem 1.25rem",
  margin: "0 0 1.25rem",
};
const cell: React.CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "0.55rem 0.6rem",
  textAlign: "left",
  verticalAlign: "top",
};
const numeric: React.CSSProperties = { ...cell, fontVariantNumeric: "tabular-nums" };
const muted: React.CSSProperties = { fontSize: "0.82rem", color: "#555" };

const SEVERITY_COLOR: Record<Severity, string> = {
  blocking: "#b00",
  attention: "#7a5a20",
  info: "#555",
};

/** Micrometres to the millimetre figure staff recognise. */
function mm(um: number): string {
  return (um / 1000).toFixed(3).replace(/\.?0+$/, "");
}

function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export default function ReadyMountingsDashboard() {
  const { apiKey, shopDomain, rows, summary } = useLoaderData<typeof loader>();
  const host = shopDomain.replace(/^https?:\/\//, "");

  // Grouped by product, because that is the unit staff open in Shopify to fix
  // anything. A flat variant list makes someone open the same product
  // repeatedly.
  const byProduct = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byProduct.get(row.productGid) ?? [];
    list.push(row);
    byProduct.set(row.productGid, list);
  }

  return (
    <AppProvider apiKey={apiKey}>
      <AdminNavigation />
      <main style={page}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.35rem" }}>Ready mountings — compatibility audit</h1>
        <p style={muted}>
          Set Your Own Stone compatibility is authored in Shopify: product and variant metafields, and the Center
          Stone Size Profiles they link to. This page validates that data and links you to the product to fix it.
          Nothing here is editable.
        </p>

        <section style={card}>
          <div style={{ display: "flex", gap: "2.5rem", flexWrap: "wrap" }}>
            <Stat label="Configurations" value={String(summary.total)} />
            <Stat label="Offered to customers" value={String(summary.offered)} />
            <Stat
              label="Needing attention"
              value={String(summary.needingAttention)}
              emphasis={summary.needingAttention > 0}
            />
            <Stat label="Last synchronized" value={summary.lastSync ?? "never"} />
          </div>
        </section>

        {rows.length === 0 ? (
          <section style={card}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>No mountings yet</h2>
            <p style={{ ...muted, margin: 0 }}>
              Nothing is recorded, so every customer who describes a stone is routed to Custom Jewelry. That is correct
              behaviour, but it is not the feature working. To add a mounting, create the product in Shopify, give it a
              Center Stone Size option linked to size profiles, and fill in the Set Your Own Stone metafields — the
              configurations will appear here automatically.
            </p>
          </section>
        ) : (
          [...byProduct.entries()].map(([productGid, configs]) => {
            const productUrl = host ? `https://${host}/admin/products/${numericId(productGid)}` : null;
            const worst = configs.some((c) => c.findings.some((f) => f.severity === "blocking"));

            return (
              <section key={productGid} style={{ ...card, borderColor: worst ? "#b00" : "#ddd" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>
                  Product {numericId(productGid)}
                  {worst ? <span style={{ color: "#b00" }}> · needs attention</span> : null}
                </h2>
                <p style={{ ...muted, margin: "0 0 0.75rem" }}>
                  {productUrl ? (
                    <a href={productUrl} target="_blank" rel="noreferrer">
                      Edit this product in Shopify
                    </a>
                  ) : (
                    "Set SHOPIFY_SHOP_DOMAIN to link through to Shopify."
                  )}
                </p>

                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.88rem" }}>
                    <thead>
                      <tr>
                        <th style={cell}>Variant</th>
                        <th style={cell}>Shape</th>
                        <th style={cell}>Nominal (mm)</th>
                        <th style={cell}>Vendor range</th>
                        <th style={cell}>±0.3 mm</th>
                        <th style={cell}>Offered</th>
                        <th style={cell}>Synced</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configs.map((c) => (
                        <tr key={c.id} style={c.isActive ? undefined : { color: "#888" }}>
                          <td style={cell}>
                            <code style={{ fontSize: "0.8rem" }}>{numericId(c.variantGid)}</code>
                            {c.centerSizeProfileId ? null : (
                              <div style={{ color: "#b00", fontSize: "0.78rem" }}>no profile</div>
                            )}
                          </td>
                          <td style={cell}>{c.shape}</td>
                          <td style={numeric}>
                            {mm(c.nominalLengthUm)} × {mm(c.nominalWidthUm)}
                          </td>
                          <td style={cell}>
                            {c.hasVendorRange ? (c.vendorRangeSource ? "yes" : "yes — no source") : "—"}
                          </td>
                          {/* A vendor range overrides the allowance entirely, so
                              reporting "yes" beside one would misdescribe what
                              the matcher actually does. */}
                          <td style={cell}>
                            {c.hasVendorRange ? "n/a — vendor range" : c.prongTolerance ? "yes" : "no"}
                          </td>
                          <td style={cell}>{c.eligible && c.isActive ? "yes" : "no"}</td>
                          <td style={cell}>
                            {c.syncedAt ? c.syncedAt.slice(0, 16).replace("T", " ") : <span style={{ color: "#b00" }}>never</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {configs.some((c) => c.findings.length > 0) ? (
                  <ul style={{ margin: "0.9rem 0 0", paddingLeft: "1.1rem", fontSize: "0.85rem" }}>
                    {configs.flatMap((c) =>
                      c.findings.map((f, i) => (
                        <li key={`${c.id}-${i}`} style={{ color: SEVERITY_COLOR[f.severity] }}>
                          <code style={{ fontSize: "0.78rem" }}>{numericId(c.variantGid)}</code> — {f.label}
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </section>
            );
          })
        )}

        <p style={muted}>
          Matching: exact nominal, inside a vendor range, or within ±0.3 mm for a prong-adjustable mounting → shown as
          matching. Over 0.3 mm and up to 1.0 mm → review required. Beyond that → the customer is directed to a custom
          setting. A configuration with any blocking problem is never offered. Owner decisions 2026-10-31 and
          2026-11-01; see <code>docs/SET-YOUR-OWN-STONE.md</code> §6.2.1.
        </p>
      </main>
    </AppProvider>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: "0.78rem", color: "#555", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.3rem",
          fontVariantNumeric: "tabular-nums",
          color: emphasis ? "#b00" : "inherit",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
