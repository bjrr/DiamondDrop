/**
 * The shared CaratForUs admin navigation.
 *
 * ===========================================================================
 * A COMPONENT, NOT A LAYOUT
 * ===========================================================================
 * The 22 admin routes authenticate independently and are siblings rather than
 * children of a parent route, which is why there is no `app.tsx`. That
 * structure works, and reorganising the route tree purely to hang a nav bar
 * off it would be real risk for a cosmetic gain. So this is a plain component
 * that a page renders, and a page that does not render it is not broken.
 *
 * Detail pages are deliberately not required to use it: they already carry
 * Back links, and editing twenty files to add a nav bar is churn, not
 * navigation.
 *
 * ===========================================================================
 * PRICING ALERTS IS `/alerts`, NOT `/app/alerts`
 * ===========================================================================
 * It is the one admin surface outside the `/app/*` namespace. Written out
 * here rather than derived, because a helper that assembled `/app/` + slug
 * would get it wrong and the mistake would look like a 404 nobody owns.
 *
 * NO DESIGN PROJECT. A `<nav>`, a list of links, and an `aria-current` on the
 * one you are looking at. It exists so staff never need to know a URL.
 */
import { Link, useLocation } from "react-router";

export interface AdminNavItem {
  readonly label: string;
  readonly to: string;
}

/**
 * Every custom admin surface, in operating order rather than alphabetical:
 * the two pricing queues a person checks daily, then configuration, then the
 * programmes, then the per-order queues.
 */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { label: "Overview", to: "/" },
  { label: "Price Approvals", to: "/app/price-approvals" },
  { label: "Pricing Settings", to: "/app/pricing-settings" },
  { label: "Pricing Alerts", to: "/alerts" },
  { label: "Group Buys", to: "/app/group-buy-campaigns" },
  { label: "Luxury Steals", to: "/app/luxury-steals" },
  { label: "Custom Jewelry", to: "/app/custom-jewelry" },
  { label: "Beat Your Quote", to: "/app/beat-quote" },
  { label: "Bank Payments", to: "/app/bank-payments" },
  { label: "Returns", to: "/app/rma" },
  { label: "Warranty", to: "/app/warranty-claims" },
  { label: "Shipments", to: "/app/shipments" },
  { label: "Ready Mountings", to: "/app/ready-settings" },
];

/**
 * Which item is the current one.
 *
 * Longest matching prefix wins, so `/app/group-buy-campaigns/123` highlights
 * Group Buys rather than nothing. "/" is special cased: every path starts
 * with it, so prefix matching alone would mark Overview current everywhere.
 */
export function currentNavItem(pathname: string): AdminNavItem | undefined {
  if (pathname === "/") return ADMIN_NAV_ITEMS[0];
  return ADMIN_NAV_ITEMS.filter((item) => item.to !== "/")
    .filter((item) => pathname === item.to || pathname.startsWith(item.to + "/"))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.25rem 1rem",
  padding: "0.75rem 1rem",
  margin: "0 0 1.25rem",
  borderBottom: "1px solid #e1e3e5",
  fontSize: "0.8125rem",
  lineHeight: 1.6,
};

export function AdminNavigation() {
  const { pathname } = useLocation();
  const current = currentNavItem(pathname);

  return (
    <nav aria-label="CaratForUs admin" style={navStyle}>
      {ADMIN_NAV_ITEMS.map((item) => {
        const isCurrent = current?.to === item.to;
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={isCurrent ? "page" : undefined}
            style={{
              color: isCurrent ? "#202223" : "#5c5f62",
              fontWeight: isCurrent ? 600 : 400,
              textDecoration: isCurrent ? "none" : "underline",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
