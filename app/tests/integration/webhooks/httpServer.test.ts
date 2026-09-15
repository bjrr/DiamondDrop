import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";

import express from "express";
import { createRequestHandler } from "@react-router/express";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import {
  SHOPIFY_EVENT_ID_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_TOPIC_HEADER,
} from "~/shopify/webhooks/headers";

import fixture from "../../fixtures/webhooks/customers-data-request.sample.json";

// Create a request body with multi-byte UTF-8 characters to catch encoding regressions.
// The original fixture is pure ASCII, which silently passes through encoding bugs.
// This body includes an accented email, en-dash, and emoji to ensure
// Buffer.byteLength(body) !== body.length, proving encoding matters.
const BODY = JSON.stringify({
  ...fixture,
  customer: {
    ...fixture.customer,
    email: "élisabeth–côté@café.com", // accented chars, en-dash
    phone: "555-123–4567 🔒", // emoji and multi-byte chars
  },
});

// Verify the body is truly multi-byte UTF-8 (not pure ASCII).
// This assertion prevents future "tidying" that would silently remove encoding coverage.
if (Buffer.byteLength(BODY) === BODY.length) {
  throw new Error(
    "Test body must contain multi-byte UTF-8 characters to catch encoding regressions. " +
      `Current body is pure ASCII (${BODY.length} chars, ${Buffer.byteLength(BODY)} bytes). ` +
      "Add accented characters, emoji, or other multi-byte chars to the fixture."
  );
}

const WEBHOOK_TOPIC = "customers/data_request";
const WEBHOOK_PATH = `/webhooks/${WEBHOOK_TOPIC}`;

describe("webhook HMAC verification at HTTP server level (regression test)", () => {
  let server: ReturnType<typeof createServer> | null = null;
  let baseUrl: string;

  beforeAll(async () => {
    // Verify the build exists before attempting to start the server.
    const buildPath = resolve(process.cwd(), "build/server/index.js");
    if (!existsSync(buildPath)) {
      throw new Error(
        `build/server/index.js not found at ${buildPath}. ` +
          "Run 'npm run build' first to create the production server bundle."
      );
    }

    // Import the built server bundle dynamically.
    // The build exports a manifest with routes, assets, and other configuration.
    const serverManifest = await import(buildPath);

    if (!serverManifest.routes) {
      throw new Error(
        `build/server/index.js does not export required manifest properties (routes). ` +
          "The build may be corrupted — run 'npm run build' again."
      );
    }

    // Create an Express app and mount the React Router request handler.
    const app = express();

    // Mount the handler using @react-router/express's createRequestHandler.
    // Pass the entire manifest as the build object.
    app.all(
      "*",
      createRequestHandler({
        build: serverManifest,
        mode: "production",
      })
    );

    // Start the server on port 0 (OS picks a free port).
    server = createServer(app);

    return new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (addr && typeof addr === "object" && addr.port) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        } else {
          reject(new Error("Failed to determine server port"));
        }
      });

      server!.on("error", reject);

      // Timeout to catch hung startup.
      setTimeout(() => {
        reject(new Error("Server startup timed out after 30s"));
      }, 30_000);
    });
  });

  afterAll(async () => {
    // Deterministic server cleanup.
    if (server) {
      return new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it("accepts a validly signed webhook request and returns 200", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const webhookId = randomUUID();
    const hmac = createHmac("sha256", SHOPIFY_API_SECRET).update(BODY, "utf8").digest("base64");

    const response = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        [SHOPIFY_HMAC_HEADER]: hmac,
        [SHOPIFY_TOPIC_HEADER]: WEBHOOK_TOPIC,
        [SHOPIFY_EVENT_ID_HEADER]: webhookId,
        "Content-Type": "application/json",
      },
      body: BODY,
    });

    expect(response.status).toBe(200);

    // Verify the handler ran by checking that an audit event was created.
    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "shopify_compliance_request", entityId: webhookId },
    });
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0]!.action).toBe("compliance.customers_data_request");
  });

  it("rejects a request with a tampered/garbage signature and returns 401", async () => {
    const webhookId = randomUUID();
    const tampered = "totally-invalid-base64-signature-not-real";

    const response = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        [SHOPIFY_HMAC_HEADER]: tampered,
        [SHOPIFY_TOPIC_HEADER]: WEBHOOK_TOPIC,
        [SHOPIFY_EVENT_ID_HEADER]: webhookId,
        "Content-Type": "application/json",
      },
      body: BODY,
    });

    expect(response.status).toBe(401);

    // Verify the handler did NOT run.
    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "shopify_compliance_request", entityId: webhookId },
    });
    expect(auditEvents.length).toBe(0);
  });

  it("rejects a request where the body was modified after signing and returns 401", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const webhookId = randomUUID();

    // Sign the original body.
    const hmac = createHmac("sha256", SHOPIFY_API_SECRET).update(BODY, "utf8").digest("base64");

    // Tamper with the body by changing the email address.
    // Use the actual multi-byte email in our body, not the fixture's original.
    const tamperedBody = BODY.replace("élisabeth–côté@café.com", "attacker@example.com");

    const response = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        [SHOPIFY_HMAC_HEADER]: hmac,
        [SHOPIFY_TOPIC_HEADER]: WEBHOOK_TOPIC,
        [SHOPIFY_EVENT_ID_HEADER]: webhookId,
        "Content-Type": "application/json",
      },
      body: tamperedBody,
    });

    expect(response.status).toBe(401);

    // Verify the handler did NOT run.
    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "shopify_compliance_request", entityId: webhookId },
    });
    expect(auditEvents.length).toBe(0);
  });
});
