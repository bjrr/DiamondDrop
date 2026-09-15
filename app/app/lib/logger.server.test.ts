import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "./logger.server";

/**
 * The logger writes structured JSON lines to console.* — we capture the
 * actual stdout/stderr output rather than reaching into module internals,
 * so these tests prove what a real log consumer would see.
 */
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedEntry(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const [line] = spy.mock.calls[0] as [string];
  return JSON.parse(line);
}

describe("logger redaction", () => {
  it("redacts a top-level sensitive key", () => {
    logger.info("test.event", { apiKey: "super-secret", userId: "u_1" });
    const entry = loggedEntry(consoleLogSpy);
    expect(entry.apiKey).toBe("[redacted]");
    expect(entry.userId).toBe("u_1");
  });

  it("redacts a sensitive key nested inside a plain object", () => {
    logger.warn("test.event", { context: { password: "hunter2", note: "ok" } });
    const entry = loggedEntry(consoleWarnSpy);
    expect(entry.context).toEqual({ password: "[redacted]", note: "ok" });
  });

  it("redacts a sensitive key inside an array of objects", () => {
    logger.error("test.event", { items: [{ apiKey: "secret-1" }, { apiKey: "secret-2", sku: "abc" }] });
    const entry = loggedEntry(consoleErrorSpy);
    expect(entry.items).toEqual([{ apiKey: "[redacted]" }, { apiKey: "[redacted]", sku: "abc" }]);
  });

  it("redacts sensitive keys inside an array of arrays", () => {
    logger.info("test.event", { rows: [[{ token: "t1" }], [{ token: "t2", label: "x" }]] });
    const entry = loggedEntry(consoleLogSpy);
    expect(entry.rows).toEqual([[{ token: "[redacted]" }], [{ token: "[redacted]", label: "x" }]]);
  });

  it("redacts a sensitive key on an object nested inside an array nested inside an object", () => {
    logger.info("test.event", {
      order: {
        lineItems: [{ cardNumber: "4111111111111111", quantity: 2 }],
      },
    });
    const entry = loggedEntry(consoleLogSpy);
    expect(entry.order).toEqual({
      lineItems: [{ cardNumber: "[redacted]", quantity: 2 }],
    });
  });

  it("passes non-object values through untouched", () => {
    logger.info("test.event", {
      count: 3,
      active: true,
      label: "plain string",
      missing: null,
      tags: ["a", "b"],
    });
    const entry = loggedEntry(consoleLogSpy);
    expect(entry.count).toBe(3);
    expect(entry.active).toBe(true);
    expect(entry.label).toBe("plain string");
    expect(entry.missing).toBeNull();
    expect(entry.tags).toEqual(["a", "b"]);
  });

  it("includes standard envelope fields alongside redacted fields", () => {
    logger.info("test.event", { password: "secret" });
    const entry = loggedEntry(consoleLogSpy);
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("test.event");
    expect(typeof entry.timestamp).toBe("string");
  });
});
