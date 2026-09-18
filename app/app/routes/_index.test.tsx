import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import AppHome from "./_index";

/**
 * The embedded app home must actually RENDER SOMETHING.
 *
 * The bug this covers presented as "The destination stream closed early" from
 * entry.server.tsx, which reads like an SSR fault. It was neither: the app had
 * a root layout and no index route, so "/" produced a valid but EMPTY document,
 * and with no frame-ancestors header the browser refused to frame it and
 * aborted the request, collapsing the SSR pipe.
 *
 * NOTHING IS MOCKED HERE. An earlier version stubbed useLoaderData, then
 * useActionData and useNavigation, then hit useSubmit behind <Form> — each new
 * hook needing another stub. That escalation was the signal: the page belongs
 * inside a real data router, so it gets one. Form, useNavigation and
 * useActionData then behave genuinely, and only the loader's RESULT is
 * supplied, because running the real loader would call authenticate.admin and
 * need a live Shopify session.
 */

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  devProbe: true,
  products: [{ id: "gid://shopify/Product/1", title: "The Complete Snowboard", status: "ACTIVE" }],
  readError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [{ id: "home", path: "/", Component: AppHome, loader: () => loaderData }],
    // hydrationData starts the router idle WITH data, so static rendering
    // produces the real page rather than a loading fallback.
    { initialEntries: ["/"], hydrationData: { loaderData: { home: loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the embedded app home", () => {
  it("renders visible content, not an empty document", () => {
    // The specific failure being guarded: a route that resolves but produces
    // nothing for a person to see.
    const text = textOf(renderPage());
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/CaratForUs/);
  });

  it("shows which shop the session resolved to", () => {
    // Proves the page reflects loader data rather than being a static shell —
    // a hard-coded page renders identically for every merchant and would hide a
    // broken session.
    expect(renderPage()).toMatch(/caratforus-dev\.myshopify\.com/);
  });

  it("does not leak the API secret into the rendered page", () => {
    const html = renderPage();
    // apiKey is the PUBLIC client id and is expected in the markup via App
    // Bridge; the secret must never appear.
    expect(html).not.toMatch(/shpss_/);
    expect(html).not.toMatch(/SHOPIFY_API_SECRET/);
  });
});

describe("the Admin API probe section", () => {
  it("lists product ids and titles returned by the read", () => {
    const html = renderPage();
    expect(html).toMatch(/gid:\/\/shopify\/Product\/1/);
    expect(html).toMatch(/The Complete Snowboard/);
  });

  it("says the read SUCCEEDED when the catalogue is simply empty", () => {
    // An empty store is a normal state. Rendering nothing here would be
    // indistinguishable from a failed read, which is the trap.
    const text = textOf(renderPage({ products: [] }));
    expect(text).toMatch(/No products in this store/);
    expect(text).toMatch(/read succeeded/i);
  });

  it("surfaces a read failure instead of rendering a blank section", () => {
    const text = textOf(
      renderPage({ products: [], readError: "Shopify Admin API listProducts failed: nope" })
    );
    expect(text).toMatch(/listProducts failed/);
    // Must not claim an empty catalogue when the read actually broke.
    expect(text).not.toMatch(/No products in this store/);
  });

  it("offers the write probe but no delete button until something was created", () => {
    const html = renderPage();
    expect(html).toMatch(/Run write probe/);
    expect(html).not.toMatch(/Delete probe product/);
  });

  it("is hidden entirely when the probe is disabled", () => {
    // Production must not render a button that creates and deletes products.
    const html = renderPage({ devProbe: false });
    expect(html).not.toMatch(/Admin API probe/);
    expect(html).not.toMatch(/Run write probe/);
    // The page itself still renders.
    expect(html).toMatch(/CaratForUs/);
  });
});

describe("document responses carry the embedding headers", () => {
  it("entry.server applies Shopify's document response headers", () => {
    // Without this call Shopify Admin cannot frame the app: the body is blank
    // and the aborted request produces the misleading stream error. Asserted
    // against the source because the alternative is a synthetic EntryContext,
    // which would test the harness more than the fix.
    const source = readFileSync(join(process.cwd(), "app", "entry.server.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toMatch(/addDocumentResponseHeaders\s*\(\s*request\s*,\s*responseHeaders\s*\)/);
    // Must run before the response is constructed, or the headers are set on an
    // object nobody reads.
    expect(code.indexOf("addDocumentResponseHeaders(")).toBeLessThan(code.indexOf("isbot("));
  });
});
