import { describe, expect, it } from "vitest";

import { ADMIN_NAV_ITEMS, currentNavItem } from "./AdminNavigation";

/**
 * The shared admin navigation.
 *
 * The URLs are the whole value of this component: a wrong one is a 404 that
 * looks like a broken feature. `/alerts` is the specific trap, because it is
 * the one admin surface outside the `/app/*` namespace and the obvious guess
 * is wrong.
 */
describe("admin navigation targets", () => {
  it("points Pricing Alerts at /alerts, never /app/alerts", () => {
    const alerts = ADMIN_NAV_ITEMS.find((i) => i.label === "Pricing Alerts");
    expect(alerts?.to).toBe("/alerts");
    expect(ADMIN_NAV_ITEMS.some((i) => i.to === "/app/alerts")).toBe(false);
  });

  it("covers every destination, in order", () => {
    expect(ADMIN_NAV_ITEMS.map((i) => i.label)).toEqual([
      "Overview",
      "Price Approvals",
      "Pricing Settings",
      "Pricing Alerts",
      "Group Buys",
      "Luxury Steals",
      "Custom Jewelry",
      "Beat Your Quote",
      "Bank Payments",
      "Returns",
      "Warranty",
      "Shipments",
      "Ready Mountings",
    ]);
  });

  it("uses the real routes found in the audit", () => {
    const byLabel = Object.fromEntries(ADMIN_NAV_ITEMS.map((i) => [i.label, i.to]));
    expect(byLabel.Returns).toBe("/app/rma");
    expect(byLabel.Warranty).toBe("/app/warranty-claims");
    expect(byLabel["Beat Your Quote"]).toBe("/app/beat-quote");
    expect(byLabel["Ready Mountings"]).toBe("/app/ready-settings");
    expect(byLabel["Price Approvals"]).toBe("/app/price-approvals");
    expect(byLabel["Group Buys"]).toBe("/app/group-buy-campaigns");
  });
});

describe("current section highlighting", () => {
  it("marks Overview only on the home path", () => {
    expect(currentNavItem("/")?.label).toBe("Overview");
    // Every path starts with "/", so a naive prefix match would light up
    // Overview everywhere. That is the bug this guards.
    expect(currentNavItem("/app/rma")?.label).toBe("Returns");
  });

  it("marks the section from a detail page", () => {
    expect(currentNavItem("/app/group-buy-campaigns/abc-123")?.label).toBe("Group Buys");
    expect(currentNavItem("/app/warranty-claims/xyz")?.label).toBe("Warranty");
  });

  it("does not let one route match another that merely shares a prefix", () => {
    expect(currentNavItem("/app/group-buy-campaigns")?.label).toBe("Group Buys");
    expect(currentNavItem("/app/group-buy-demand")).toBeUndefined();
  });

  it("returns nothing for a path outside the admin", () => {
    expect(currentNavItem("/pages/first-access")).toBeUndefined();
  });
});
