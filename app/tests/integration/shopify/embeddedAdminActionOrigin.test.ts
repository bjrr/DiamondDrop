import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import express from "express";
import { createRequestHandler } from "@react-router/express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * request carrying `Host: caratforus.fly.dev` and an https Origin.
 *
 * THE DISCRIMINATOR. It POSTs to `/alerts` — a UI route (default export) with
 * NO action. The CSRF guard runs first, for every UI-route mutation:
 *   - rejected by the guard  -> 400, the action is never looked up;
 *   - admitted by the guard  -> 405, React Router finds no action to run.
 * So the status alone says which side of the guard the request landed on,
 * with no dependence on Shopify authentication, a session, or log output.
 * (An earlier version keyed on the Shopify library's log line; that line is
 * not emitted in the test process, so it could not tell the two cases apart.)
 */

type Captured = { status: number };

let server: ReturnType<typeof createServer> | null = null;
let port = 0;
let builtAllowedOrigins: unknown;

function post(path: string, origin: string): Promise<Captured> {
  const body = "intent=regression-test";
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

/** A UI route (default export) with no action — see the discriminator above. */
const NO_ACTION_UI_ROUTE = "/alerts.data";

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

  it("admits the app's own https Origin arriving as plain HTTP — past the guard (405, not 400)", async () => {
    const { status } = await post(NO_ACTION_UI_ROUTE, `https://${PRODUCTION_APP_HOST}`);
    expect(status).toBe(405);
  });

  it("still rejects a foreign Origin at the guard (400)", async () => {
    const { status } = await post(NO_ACTION_UI_ROUTE, "https://evil.example.net");
    expect(status).toBe(400);
  });

  it("still rejects a look-alike subdomain of the app host (400)", async () => {
    const { status } = await post(NO_ACTION_UI_ROUTE, `https://evil.${PRODUCTION_APP_HOST}`);
    expect(status).toBe(400);
  });
});
