import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

/**
 * The embedded app home must actually RENDER SOMETHING.
 *
 * The bug this covers presented as "The destination stream closed early" from
 * entry.server.tsx, which reads like an SSR or streaming fault. It was neither.
 * The app had a root layout and no index route, so "/" rendered a valid but
 * EMPTY document; with no frame-ancestors header the browser then refused to
 * frame it and aborted the request, collapsing the SSR pipe.
 *
 * Both halves are asserted here, because either alone reproduces a blank app.
 */

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    // Loader data is supplied directly rather than by standing up a full data
    // router. Only this hook is stubbed — everything else, including the
    // router context AppProvider needs, stays real.
    useLoaderData: () => ({ apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com" }),
  };
});

/**
 * AppProvider calls useNavigate internally, so the page needs real router
 * context. Supplied with MemoryRouter rather than by mocking the hook away:
 * stubbing useNavigate would hide a genuine failure to work inside a router,
 * which is the environment this page actually runs in.
 */
async function renderPage(): Promise<string> {
  const { default: AppHome } = await import("./_index");
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppHome />
    </MemoryRouter>
  );
}

describe("the embedded app home", () => {
  it("renders visible content, not an empty document", async () => {
    const html = await renderPage();

    // The specific failure being guarded: a route that resolves but produces
    // nothing for the user to see.
    const textOnly = html.replace(/<[^>]*>/g, "").trim();
    expect(textOnly.length).toBeGreaterThan(40);
    expect(html).toMatch(/CaratForUs/);
  });

  it("shows which shop the session resolved to", async () => {
    // Proves the page reflects loader data rather than being a static shell —
    // a hard-coded page would render identically for every merchant and hide a
    // broken session.
    expect(await renderPage()).toMatch(/caratforus-dev.myshopify.com/);
  });

  it("does not leak the API secret into the rendered page", async () => {
    const html = await renderPage();
    // apiKey is the PUBLIC client id and is expected in the markup via App
    // Bridge; the secret must never appear.
    expect(html).not.toMatch(/shpss_/);
    expect(html).not.toMatch(/SHOPIFY_API_SECRET/);
  });
});

describe("document responses carry the embedding headers", () => {
  it("entry.server applies Shopify's document response headers", () => {
    // Without this call Shopify Admin cannot frame the app: the body is blank
    // and the aborted request produces the misleading stream error. Asserted
    // against the source because the alternative is standing up a full SSR
    // request with a synthetic EntryContext, which would test the harness more
    // than the fix.
    const source = readFileSync(join(process.cwd(), "app", "entry.server.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toMatch(/addDocumentResponseHeaders\s*\(\s*request\s*,\s*responseHeaders\s*\)/);
    // Must run before the response is constructed, or the headers are set on an
    // object nobody reads.
    expect(code.indexOf("addDocumentResponseHeaders(")).toBeLessThan(code.indexOf("isbot("));
  });
});
