import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { getEnv } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

/**
 * The embedded app home, served at "/" — the URL Shopify Admin opens.
 *
 * WHY THIS ROUTE DID NOT EXIST, AND WHY THAT PRESENTED AS A STREAM ERROR.
 * Slices 0 and 1 built only resource routes (webhooks, cron, health), so the
 * app had a root layout and nothing to put in its <Outlet/>. Opening the app
 * rendered a valid but empty document. Combined with the missing
 * Content-Security-Policy frame-ancestors header, the browser then refused to
 * frame it and aborted the request, tearing down the SSR pipe and producing
 * "The destination stream closed early" — an error describing the collapse of
 * the stream rather than the absence of a page.
 *
 * DELIBERATELY MINIMAL. This is the Slice 2 entry point, not the admin UI. It
 * proves the OAuth session resolves and something authenticated renders; the
 * price-review surfaces replace the body when they are built.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Performs the OAuth handshake on first load and resolves the session on
  // every subsequent one. Throws a redirect when the shop is not yet installed,
  // which is why this loader has no "unauthenticated" branch to handle.
  const { session } = await authenticate.admin(request);

  return {
    // The PUBLIC client id, not the secret. App Bridge needs it in the browser,
    // and it already ships in shopify.app.caratforus-development.toml.
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
  };
}

export default function AppHome() {
  const { apiKey, shop } = useLoaderData<typeof loader>();

  return (
    // Injects App Bridge and the Polaris web components. Required for the
    // embedded frame to negotiate session tokens on later navigations — without
    // it the first render works and everything after it fails to authenticate.
    <AppProvider apiKey={apiKey}>
      {/*
        Plain semantic HTML rather than Polaris web components. Those ship
        untyped, and adding ambient JSX declarations for a placeholder page
        would be more code than the page itself. AppProvider still injects App
        Bridge, which is the part that has to be right.
      */}
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>CaratForUs</h1>
        <p style={{ margin: "0 0 0.75rem" }}>
          Connected to <strong>{shop}</strong>.
        </p>
        <p style={{ margin: 0, color: "#555" }}>
          Buy Now pricing runs on a daily schedule. Price changes beyond the configured
          tolerance wait for approval here; nothing publishes to Shopify automatically yet.
        </p>
      </main>
    </AppProvider>
  );
}
