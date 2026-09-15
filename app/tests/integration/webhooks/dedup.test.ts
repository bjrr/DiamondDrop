import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  claimWebhookEventForProcessing,
  getWebhookEventByShopifyEventId,
} from "~/db/repositories/webhookEventRepository.server";
import { getEnv } from "~/lib/env.server";
import {
  SHOPIFY_EVENT_ID_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_TOPIC_HEADER,
} from "~/shopify/webhooks/headers";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

import ordersCreateFixture from "../../fixtures/webhooks/orders-create.sample.json";

const FIXTURE_BODY = JSON.stringify(ordersCreateFixture);

function signedRequest(body: string, eventId: string, secret: string, topic = "orders/create"): Request {
  const hmac = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  return new Request("https://example.com/webhooks/orders/create", {
    method: "POST",
    headers: {
      [SHOPIFY_HMAC_HEADER]: hmac,
      [SHOPIFY_TOPIC_HEADER]: topic,
      [SHOPIFY_EVENT_ID_HEADER]: eventId,
    },
    body,
  });
}

function unsignedRequest(body: string, eventId: string, hmac: string, topic = "orders/create"): Request {
  return new Request("https://example.com/webhooks/orders/create", {
    method: "POST",
    headers: {
      [SHOPIFY_HMAC_HEADER]: hmac,
      [SHOPIFY_TOPIC_HEADER]: topic,
      [SHOPIFY_EVENT_ID_HEADER]: eventId,
    },
    body,
  });
}

/**
 * A handler that parks inside the callback until the test releases it.
 *
 * The concurrent-delivery cases below need the winner's claim to still be
 * in flight when the loser arrives. An instantaneous handler cannot
 * guarantee that: the winner routinely finishes and marks the event
 * processed first, and the loser then legitimately sees
 * `already_processed` (200) rather than `in_progress` (503). Both are
 * correct behaviour, so asserting one particular interleaving is a flaky
 * test, not a stronger one. Latching the handler makes the in-flight case
 * deterministic so the 503 path is genuinely covered.
 */
function gatedHandler() {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  let callCount = 0;
  return {
    entered,
    release: () => open(),
    callCount: () => callCount,
    handler: async () => {
      callCount += 1;
      enter();
      await gate;
    },
  };
}

describe("webhook receive: HMAC verification + replay dedup (recorded fixture)", () => {
  it("accepts a validly signed recorded fixture, processes it once, and records a replay as a no-op duplicate", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
    };

    const first = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(first.status).toBe(200);
    expect(callCount).toBe(1);

    const replay = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(replay.status).toBe(200);
    expect(callCount).toBe(1); // not re-processed

    const stored = await getWebhookEventByShopifyEventId(eventId);
    expect(stored).not.toBeNull();
    expect(stored?.processedAt).not.toBeNull();
    expect(stored?.rawBody).toBe(FIXTURE_BODY);
  });

  it("rejects the same fixture carrying an invalid/garbage signature with 401 and never invokes the handler", async () => {
    const eventId = randomUUID();
    let called = false;

    const response = await receiveShopifyWebhook(
      unsignedRequest(FIXTURE_BODY, eventId, "recorded-invalid-signature-fixture"),
      async () => {
        called = true;
      }
    );

    expect(response.status).toBe(401);
    expect(called).toBe(false);
    expect(await getWebhookEventByShopifyEventId(eventId)).toBeNull();
  });

  it("rejects a request with no signature header at all", async () => {
    const eventId = randomUUID();
    const request = new Request("https://example.com/webhooks/orders/create", {
      method: "POST",
      headers: {
        [SHOPIFY_TOPIC_HEADER]: "orders/create",
        [SHOPIFY_EVENT_ID_HEADER]: eventId,
      },
      body: FIXTURE_BODY,
    });

    const response = await receiveShopifyWebhook(request, async () => {
      throw new Error("handler must not run for an unsigned request");
    });
    expect(response.status).toBe(401);
  });

  it("rejects a fixture whose body was modified after signing", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();
    const hmac = createHmac("sha256", SHOPIFY_API_SECRET).update(FIXTURE_BODY, "utf8").digest("base64");
    const tamperedBody = FIXTURE_BODY.replace("199.99", "1.00");

    const response = await receiveShopifyWebhook(
      unsignedRequest(tamperedBody, eventId, hmac),
      async () => {
        throw new Error("handler must not run for a tampered body");
      }
    );
    expect(response.status).toBe(401);
  });

  it("returns 503 to a delivery arriving while another still holds the claim, and processes exactly once", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();
    const gated = gatedHandler();

    // The winner claims the row and parks inside the handler, so the claim
    // is provably still in flight when the second delivery arrives.
    const winner = receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );
    await gated.entered;

    const loser = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );

    // The loser sees an unprocessed, error-free, freshly-claimed row
    // (ambiguous: could be this very race, could be a crash) and must
    // return 503, not 200 -- a 2xx would promise Shopify the delivery
    // succeeded and permanently end redelivery (architect review,
    // 2026-09-14).
    expect(loser.status).toBe(503);
    expect(gated.callCount()).toBe(1); // the loser never entered the handler

    gated.release();
    expect((await winner).status).toBe(200);
    expect(gated.callCount()).toBe(1);

    const stored = await getWebhookEventByShopifyEventId(eventId);
    expect(stored?.processedAt).not.toBeNull();
  });

  it("never double-processes two genuinely simultaneous deliveries, whichever wins the race", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
    };

    const [a, b] = await Promise.all([
      receiveShopifyWebhook(signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET), handler),
      receiveShopifyWebhook(signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET), handler),
    ]);

    // Timing alone decides whether the loser finds the winner still in
    // flight (503) or already finished (200), so neither status may be
    // asserted on its own. What must hold regardless of interleaving: the
    // UNIQUE constraint -- not application logic -- let exactly one caller
    // process, nobody received a status outside {200, 503}, and no delivery
    // was told 200 while the event sat unprocessed.
    expect(callCount).toBe(1);
    expect([a.status, b.status]).toContain(200);
    expect([200, 503]).toContain(a.status);
    expect([200, 503]).toContain(b.status);

    const stored = await getWebhookEventByShopifyEventId(eventId);
    expect(stored?.processedAt).not.toBeNull();
  });

  // Finding 1 (architect review, 2026-09-14): a failed webhook must be
  // reprocessed on redelivery, not swallowed as a duplicate because a row
  // already exists for it.
  it("reprocesses a redelivered event whose prior attempt failed, instead of discarding it as a duplicate", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient failure on first attempt");
      }
    };

    const first = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(first.status).toBe(500);
    expect(callCount).toBe(1);

    const storedAfterFailure = await getWebhookEventByShopifyEventId(eventId);
    expect(storedAfterFailure?.processedAt).toBeNull();
    expect(storedAfterFailure?.error).toBe("transient failure on first attempt");

    // Shopify redelivers the same event id after the 500.
    const retry = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(retry.status).toBe(200);
    expect(callCount).toBe(2); // reprocessed, not swallowed as a duplicate

    const storedAfterRetry = await getWebhookEventByShopifyEventId(eventId);
    expect(storedAfterRetry?.processedAt).not.toBeNull();
    expect(storedAfterRetry?.error).toBeNull();
  });

  it("does not reprocess an event that already completed successfully", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
    };

    const first = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(first.status).toBe(200);
    expect(callCount).toBe(1);

    const replay = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      handler
    );
    expect(replay.status).toBe(200);
    expect(callCount).toBe(1); // already-processed short-circuits, no reprocessing
  });

  it("concurrent redeliveries of a previously failed event still reprocess exactly once", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    let callCount = 0;
    const firstAttempt = async () => {
      callCount += 1;
      throw new Error("first attempt fails");
    };

    const firstResponse = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      firstAttempt
    );
    expect(firstResponse.status).toBe(500);
    expect(callCount).toBe(1);

    // Two redeliveries racing to reclaim the same failed row — the reclaim
    // UPDATE's WHERE clause, not application logic, must guarantee only one
    // of them wins. The winner holds the reclaim open inside the handler;
    // the loser then finds the row already re-claimed (unprocessed,
    // error-free, freshly claimed) and must return 503, not 200, for the
    // same reason as the concurrent-first-delivery case above.
    const gated = gatedHandler();

    const winner = receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );
    await gated.entered;

    const loser = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );
    expect(loser.status).toBe(503);
    expect(gated.callCount()).toBe(1);

    gated.release();
    expect((await winner).status).toBe(200);
    expect(gated.callCount()).toBe(1); // reclaimed and reprocessed exactly once
  });

  // Architect review, 2026-09-14 (overruling the earlier 200-for-ambiguous
  // design): a 2xx response permanently ends Shopify redelivery. Returning
  // 200 for an unresolved event would make a crashed handler a silent,
  // permanent loss. 503 keeps the delivery in Shopify's retry schedule.
  it("returns 503, not 200, for a recent unprocessed claim, and does not invoke the handler for that delivery", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    // Simulate another delivery having just claimed this event: unprocessed,
    // no recorded error, claimed moments ago -- too recent to be reclaimed
    // as stale under the default 15-minute threshold.
    const claim = await claimWebhookEventForProcessing({
      shopifyEventId: eventId,
      topic: "orders/create",
      shopDomain: null,
      rawBody: FIXTURE_BODY,
    });
    expect(claim.kind).toBe("new");

    let called = false;
    const response = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      async () => {
        called = true;
      }
    );

    expect(response.status).toBe(503);
    expect(called).toBe(false);

    const stored = await getWebhookEventByShopifyEventId(eventId);
    expect(stored?.processedAt).toBeNull();
  });

  it("reclaims a claim whose age exceeds the staleness threshold and reprocesses it (claimed_stale)", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    // Simulate a crashed attempt: claimed, never processed, never recorded
    // a failure. Backdate claimedAt past the default 15-minute threshold so
    // the full receiveShopifyWebhook path (which always uses the default)
    // treats it as stale without needing to wait 15 real minutes.
    const claim = await claimWebhookEventForProcessing({
      shopifyEventId: eventId,
      topic: "orders/create",
      shopDomain: null,
      rawBody: FIXTURE_BODY,
    });
    expect(claim.kind).toBe("new");
    await prisma.webhookEvent.update({
      where: { shopifyEventId: eventId },
      data: { claimedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
    };

    const response = await receiveShopifyWebhook(signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET), handler);

    expect(response.status).toBe(200);
    expect(callCount).toBe(1);

    const stored = await getWebhookEventByShopifyEventId(eventId);
    expect(stored?.processedAt).not.toBeNull();
  });

  it("two concurrent deliveries racing to reclaim the same stale claim reprocess exactly once", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    const claim = await claimWebhookEventForProcessing({
      shopifyEventId: eventId,
      topic: "orders/create",
      shopDomain: null,
      rawBody: FIXTURE_BODY,
    });
    expect(claim.kind).toBe("new");
    await prisma.webhookEvent.update({
      where: { shopifyEventId: eventId },
      data: { claimedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    // Same atomic conditional-update guarantee as the failed-retry race:
    // the first UPDATE moves claimedAt forward, so the second's
    // `claimedAt < cutoff` predicate no longer matches.
    const gated = gatedHandler();

    const winner = receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );
    await gated.entered;

    const loser = await receiveShopifyWebhook(
      signedRequest(FIXTURE_BODY, eventId, SHOPIFY_API_SECRET),
      gated.handler
    );
    expect(loser.status).toBe(503);
    expect(gated.callCount()).toBe(1);

    gated.release();
    expect((await winner).status).toBe(200);
    expect(gated.callCount()).toBe(1);
  });

  // Exercises the injectable staleClaimMs directly against the repository
  // function (rather than via the HTTP-level receiveShopifyWebhook, which
  // always uses the 15-minute default) so this test needs no backdating
  // and no waiting.
  it("claimWebhookEventForProcessing's injectable staleClaimMs reclaims immediately once the threshold is smaller than elapsed time", async () => {
    const eventId = randomUUID();
    const input = { shopifyEventId: eventId, topic: "orders/create", shopDomain: null, rawBody: FIXTURE_BODY };

    const first = await claimWebhookEventForProcessing(input);
    expect(first.kind).toBe("new");

    await new Promise((resolve) => setTimeout(resolve, 5));

    // A 1ms threshold means anything claimed more than 1ms ago is stale;
    // at least 5ms have elapsed since the claim above.
    const reclaimed = await claimWebhookEventForProcessing(input, 1);
    expect(reclaimed.kind).toBe("claimed_stale");
  });
});
