import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import express from "express";
import { createRequestHandler } from "@react-router/express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PRODUCTION_APP_HOST } from "~/lib/productionActionOrigin";

/**
 * REGISTER D11 — the regression this pins.
 *
 * In production every embedded-admin form save returned 400 "Bad Request"
 * before authentication or the action ran. Fly terminates TLS, so the server
 * sees plain HTTP and builds `request.url` as http://caratforus.fly.dev/…,
 * while the browser's Origin is https://caratforus.fly.dev. React Router's CSRF
 * guard compares full origins and the production allowlist was empty.
 *
 * This reproduces Fly exactly against the REAL production build: a plain-HTTP
 * request carrying `Host: caratforus.fly.dev` and an https Origin. A plain
 * status check cannot tell the guard's 400 from any other 400, so the test
 * asks the decisive question instead — did the request get past the guard and
 * reach Shopify authentication? The Shopify library logs "Authenticating admin
 * request" as the first thing it does; the guard runs before it.
 */

type Captured = { status: number };

let server: ReturnType<typeof createServer> | null = null;
let port = 0;
let builtAllowedOrigins: unknown;

function post(path: string, origin: string): Promise<Captured> {
  const body = "intent=save-component";
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          // What Fly's proxy delivers: the public host, over plain HTTP.
          Host: PRODUCTION_APP_HOST,
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function reachedShopifyAuth(origin: string): Promise<{ status: number; reachedAuth: boolean }> {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(capture)
  );
  try {
    const { status } = await post("/app/pricing-settings.data", origin);
    return { status, reachedAuth: lines.some((l) => l.includes("Authenticating admin request")) };
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

describe("embedded admin actions behind Fly's TLS-terminating proxy (D11)", () => {
  beforeAll(async () => {
    const buildPath = resolve(process.cwd(), "build/server/index.js");
    if (!existsSync(buildPath)) {
      throw new Error(`build/server/index.js not found at ${buildPath}. Run 'npm run build' first.`);
    }
    const build = await import(buildPath);
    builtAllowedOrigins = build.allowedActionOrigins;

    const app = express();
    app.all("*", createRequestHandler({ build, mode: "production" }));
    server = createServer(app);
    await new Promise<void>((done, fail) => {
      server!.listen(0, "127.0.0.1", () => {
        port = (server!.address() as AddressInfo).port;
        done();
      });
      server!.on("error", fail);
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
  });

  it("the production build carries the app's own host in allowedActionOrigins", () => {
    expect(builtAllowedOrigins).toEqual(expect.arrayContaining([PRODUCTION_APP_HOST]));
    expect((builtAllowedOrigins as string[]).some((o) => o.includes("*"))).toBe(false);
  });

  it("admits the app's own https Origin arriving as plain HTTP — the request reaches Shopify auth", async () => {
    const result = await reachedShopifyAuth(`https://${PRODUCTION_APP_HOST}`);
    expect(result.reachedAuth).toBe(true);
  });

  it("still rejects a foreign Origin with 400 before Shopify auth", async () => {
    const result = await reachedShopifyAuth("https://evil.example.net");
    expect(result.status).toBe(400);
    expect(result.reachedAuth).toBe(false);
  });
});
