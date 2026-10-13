import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * D13 requirement 2, enforced rather than asserted in a commit message:
 *
 *   Adopting @shopify/shopify-app-react-router must NOT replace or bypass our
 *   custom inbound webhook boundary.
 *
 * WHY A SOURCE-INSPECTION TEST. The failure mode here is not a wrong value, it
 * is a wrong ROUTE — someone swapping `receiveShopifyWebhook` for the library's
 * webhook authenticator because it is fewer lines. That would still pass every
 * behavioural test we have, because the library does verify HMACs; what it
 * would silently drop is deduplication, idempotent processing, and the durable
 * evidence record the returns/warranty/dispute requirements depend on.
 *
 * So these assertions are about what the code IS, which is the only level at
 * which that substitution is visible.
 */

const ROUTES_DIR = join(process.cwd(), "app", "routes");
const APP_DIR = join(process.cwd(), "app");

/** Matches the library's webhook authenticator, however it is spaced. */
const LIBRARY_WEBHOOK_AUTH = /authenticate\s*\.\s*webhook/;

/** Matches a CALL to the library's webhook registration helper. */
const LIBRARY_REGISTER_WEBHOOKS = /registerWebhooks\s*\(/;

/** Block and line comments removed, so prose about a rule cannot violate it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readAllSources(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...readAllSources(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push({ path: full, source: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const webhookRoutes = readdirSync(ROUTES_DIR).filter((f) => f.startsWith("webhooks."));

describe("the custom inbound webhook boundary survives the library adoption", () => {
  it("finds the webhook routes it is checking", () => {
    // Guards the guard: an empty list would make every assertion below vacuous,
    // which is exactly how this file would rot if the routes were renamed.
    expect(webhookRoutes.length).toBeGreaterThanOrEqual(3);
    expect(webhookRoutes).toContain("webhooks.shop.redact.tsx");
  });

  it("routes every webhook through OUR receiver, not the library's", () => {
    for (const file of webhookRoutes) {
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      expect(source, `${file} must call receiveShopifyWebhook`).toMatch(/receiveShopifyWebhook\(/);
    }
  });

  it("uses the library's webhook authenticator NOWHERE in the codebase", () => {
    // The single most important assertion in this file. The library's webhook
    // authentication verifies the HMAC but does not deduplicate or guarantee
    // idempotency, so adopting it would quietly weaken the boundary while
    // looking like a simplification.
    //
    // Comments are stripped first: several files DOCUMENT that we avoid this
    // call, and matching those would make the test fail for saying the right
    // thing — which teaches people to delete the explanation.
    const offenders = readAllSources(APP_DIR)
      .filter(({ source }) => LIBRARY_WEBHOOK_AUTH.test(stripComments(source)))
      .map(({ path }) => path);

    expect(
      offenders,
      "The library's webhook authenticator bypasses deduplication and idempotent " +
        "processing. Inbound webhooks must go through " +
        "app/shopify/webhooks/receive.server.ts."
    ).toEqual([]);
  });

  it("registers no webhook handlers with the library", () => {
    // A `webhooks` key in shopifyApp() would have the library subscribe and
    // dispatch, routing deliveries around our receiver entirely.
    const config = readFileSync(join(APP_DIR, "shopify.server.ts"), "utf8");
    expect(stripComments(config)).not.toMatch(/\bwebhooks\s*:/);
  });

  it("keeps the webhook routes free of the Shopify library entirely", () => {
    for (const file of webhookRoutes) {
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      expect(source, `${file} must not import the Shopify library`).not.toMatch(
        /@shopify\/shopify-app-react-router/
      );
    }
  });

  it("never calls the library's registerWebhooks", () => {
    // The library attaches registerWebhooks whether or not we configure
    // webhooks, so its existence proves nothing. Calling it would subscribe
    // topics to the library's dispatcher and route deliveries around our
    // receiver — that is the thing to forbid.
    const offenders = readAllSources(APP_DIR)
      .filter(({ source }) => LIBRARY_REGISTER_WEBHOOKS.test(stripComments(source)))
      .map(({ path }) => path);

    expect(offenders, "registerWebhooks would bypass our webhook boundary.").toEqual([]);
  });

  it("would actually catch a violation", () => {
    // Proves the detector works, rather than trusting that an empty result
    // means compliance. Without this, a broken regex reads as a clean codebase.
    const violating = `import { authenticate } from "~/shopify.server";\nawait authenticate.webhook(request);`;
    expect(LIBRARY_WEBHOOK_AUTH.test(stripComments(violating))).toBe(true);

    const documented = `// We never call authenticate.webhook here.`;
    expect(LIBRARY_WEBHOOK_AUTH.test(stripComments(documented))).toBe(false);

    // Same proof for the registration detector.
    expect(LIBRARY_REGISTER_WEBHOOKS.test("await shopify.registerWebhooks({session});")).toBe(true);
    expect(LIBRARY_REGISTER_WEBHOOKS.test("const x = registerWebhooksFactory;")).toBe(false);
  });
});

describe("the receiver still does the three things that make it ours", () => {
  const receiver = readFileSync(join(APP_DIR, "shopify", "webhooks", "receive.server.ts"), "utf8");

  it("verifies the HMAC before parsing the body", () => {
    const hmacAt = receiver.indexOf("verifyShopifyWebhookHmac");
    const parseAt = receiver.search(/JSON\s*\.\s*parse|\.json\(\)/);

    expect(hmacAt).toBeGreaterThan(-1);
    // Order is the guarantee: parsing attacker-controlled bytes before proving
    // they came from Shopify is the thing being prevented.
    if (parseAt > -1) expect(hmacAt).toBeLessThan(parseAt);
  });

  it("reads the RAW body for verification, not a parsed object", () => {
    expect(receiver).toMatch(/rawBody/);
  });

  it("still deduplicates and records deliveries", () => {
    expect(receiver).toMatch(/webhookEvent|eventId|event_id/i);
  });
});
