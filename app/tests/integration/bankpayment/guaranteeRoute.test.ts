import { describe, expect, it } from "vitest";

import { getEnv } from "~/lib/env.server";
import { action } from "~/routes/internal.jobs.bank-payment-guarantee";

/**
 * Authentication for the guarantee-sweep cron route (spec §13/§14, criterion
 * 100). Mirrors `tests/integration/pricing/cronRoute.test.ts` exactly — this
 * is the same shared-secret scheme, applied to a second endpoint, and the
 * attack surface (an unauthenticated caller triggering a sweep) is
 * identical in kind.
 */

const HEADER = "x-carat-cron-secret";

function request(secret?: string, method = "POST"): Request {
  const headers = new Headers();
  if (secret !== undefined) headers.set(HEADER, secret);
  return new Request("https://example.com/internal/jobs/bank-payment-guarantee", { method, headers });
}

const call = (req: Request) => action({ request: req, params: {}, context: {} } as any);

describe("guarantee sweep cron authentication", () => {
  it("rejects a request with NO secret header", async () => {
    const response = await call(request(undefined));
    expect(response.status).toBe(401);
  });

  it("rejects a WRONG secret", async () => {
    const response = await call(request("definitely-not-the-cron-secret-value"));
    expect(response.status).toBe(401);
  });

  it("rejects an EMPTY secret", async () => {
    const response = await call(request(""));
    expect(response.status).toBe(401);
  });

  it("rejects a secret that is a PREFIX of the real one", async () => {
    const { CRON_SECRET } = getEnv();
    const response = await call(request(CRON_SECRET.slice(0, -1)));
    expect(response.status).toBe(401);
  });

  it("rejects a secret LONGER than the real one", async () => {
    const { CRON_SECRET } = getEnv();
    const response = await call(request(`${CRON_SECRET}extra`));
    expect(response.status).toBe(401);
  });

  it("rejects a non-POST method even with a valid secret", async () => {
    const { CRON_SECRET } = getEnv();
    const response = await call(request(CRON_SECRET, "GET"));
    expect(response.status).toBe(405);
  });

  it("runs the sweep and returns a summary with a valid secret", async () => {
    const { CRON_SECRET } = getEnv();
    const response = await call(request(CRON_SECRET));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("ordersConsidered");
    expect(body).toHaveProperty("cancelled");
    expect(body).toHaveProperty("flagged");
    expect(body).toHaveProperty("kept");
    expect(body).toHaveProperty("errored");
    expect(body).toHaveProperty("now");
    // No price, cost or margin value ever leaves this endpoint.
    expect(JSON.stringify(body)).not.toMatch(/minorUnits|margin|cost/i);
  });
});
