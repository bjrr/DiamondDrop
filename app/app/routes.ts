import { flatRoutes } from "@react-router/fs-routes";

// Remix v2-style flat file-based routing (health.tsx,
// webhooks.customers.data_request.tsx, etc.) preserved unchanged during the
// React Router 7 migration — see app/routes/.
export default flatRoutes({
  // Colocated tests are NOT routes. Without this, app/routes/_index.test.tsx
  // is registered as a route module, its `import { describe } from "vitest"`
  // gets pulled into the server bundle, and `npm run build` fails on a rollup
  // error about @vitest/utils — which also takes down the integration suite,
  // because its globalSetup builds that bundle first.
  //
  // The failure names vitest internals and says nothing about routing, so it
  // is worth the two lines to prevent rather than to rediscover.
  ignoredRouteFiles: ["**/*.test.*"],
});
