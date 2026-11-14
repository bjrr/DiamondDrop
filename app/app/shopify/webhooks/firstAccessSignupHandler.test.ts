import { describe, expect, it } from "vitest";

import type { IdempotencyRepository } from "~/domain/idempotency/types";
import type { SendEmailInput } from "~/lib/email/port";

import { handleFirstAccessSignupWebhook, parseFirstAccessSignupPayload } from "./firstAccessSignupHandler.server";
import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * THE DEFECT THIS FILE EXISTS FOR.
 *
 * The Launching Soon form only called the backend when the OPTIONAL mobile
 * field was filled in:
 *
 *     var phone = value('contact[phone]');
 *     if (phone === '') return null;
 *
 * So the common signup -- first name, email, no phone -- never reached the
 * backend at all. Nothing errored and the form said it had worked.
 *
 * The emails now hang off `customers/create` instead, which Shopify delivers
 * for every signup regardless of what the browser did. These tests are
 * written around the two cases the owner named: a signup WITHOUT a phone and
 * a signup WITH one, asserted to differ in exactly one respect.
 */

function event(body: unknown): ReceivedWebhookEvent {
  return {
    shopifyEventId: "evt_1",
    topic: "customers/create",
    shopDomain: "caratforus.myshopify.com",
    rawBody: JSON.stringify(body),
    payload: body,
  };
}

/** A signup exactly as Shopify delivers it on this topic. */
function signup(overrides: Record<string, unknown> = {}) {
  return {
    id: 7700000001,
    email: "brian@example.com",
    first_name: "Brian",
    last_name: "Jishi",
    phone: null,
    tags: "first-access, loose-diamonds",
    ...overrides,
  };
}

/** Records what was sent, and to whom. */
function fakeMail() {
  const sent: SendEmailInput[] = [];
  return {
    sent,
    resolve: () =>
      ({
        configured: true as const,
        from: "hello@caratforus.com",
        recipients: ["orders@caratforus.com"],
        port: {
          async send(input: SendEmailInput) {
            sent.push(input);
            return { providerMessageId: `msg_${sent.length}` };
          },
        },
      }),
  };
}

/**
 * In-memory stand-in for the real UNIQUE-constraint-backed repository.
 *
 * `findByKey` RETURNS THE STORED STATUS, which matters: the first version of
 * this fake always returned null, and a fake that forgets state cannot
 * exercise the retry-after-failure path the handler depends on.
 */
function fakeIdempotency(): IdempotencyRepository & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    async tryCreatePending(key: string) {
      if (keys.has(key)) return false;
      keys.set(key, "pending");
      return true;
    },
    async findByKey(key: string) {
      const status = keys.get(key);
      if (!status) return null;
      return {
        key,
        operationType: "first_access_signup_email",
        status: status as "pending" | "succeeded" | "failed" | "in_doubt",
        requestPayload: null,
        resultPayload: null,
        errorMessage: null,
      };
    },
    async recordSuccess(key: string) {
      keys.set(key, "succeeded");
    },
    async recordFailure(key: string) {
      keys.set(key, "failed");
    },
    async recordInDoubt(key: string) {
      keys.set(key, "in_doubt");
    },
  } as IdempotencyRepository & { keys: Map<string, string> };
}

describe("Case A — first name and email, phone left blank", () => {
  it("still reaches the backend and sends BOTH emails", async () => {
    // THE CORE ASSERTION. Under the old form-driven trigger this signup
    // produced nothing at all.
    const mail = fakeMail();
    const result = await handleFirstAccessSignupWebhook(event(signup({ phone: null })), {
      resolveEmailPort: mail.resolve,
      idempotency: fakeIdempotency(),
    });

    expect(result.skipped).toBe(false);
    expect(result.confirmationSent).toBe(true);
    expect(result.notificationSent).toBe(true);
    expect(mail.sent).toHaveLength(2);
  });

  it("sends the confirmation to the customer, personalised", async () => {
    const mail = fakeMail();
    await handleFirstAccessSignupWebhook(event(signup({ phone: null })), {
      resolveEmailPort: mail.resolve,
      idempotency: fakeIdempotency(),
    });

    const confirmation = mail.sent.find((m) => m.to.includes("brian@example.com"));
    expect(confirmation).toBeDefined();
    expect(confirmation!.subject).toBe("You’re on the CaratForUs list");
    expect(confirmation!.text.startsWith("Hi Brian,")).toBe(true);
  });

  it("notifies orders@ with no phone line invented", async () => {
    const mail = fakeMail();
    await handleFirstAccessSignupWebhook(event(signup({ phone: null })), {
      resolveEmailPort: mail.resolve,
      idempotency: fakeIdempotency(),
    });

    const notification = mail.sent.find((m) => m.to.includes("orders@caratforus.com"));
    expect(notification).toBeDefined();
    expect(notification!.text).toContain("First name: Brian");
    expect(notification!.text).toContain("Email: brian@example.com");
    expect(notification!.text).toContain("Launching Soon signup");
    expect(notification!.text).not.toContain("Phone");
  });
});

describe("Case B — first name, email and phone", () => {
  it("behaves identically, plus the phone in our notification", async () => {
    const mail = fakeMail();
    const result = await handleFirstAccessSignupWebhook(
      event(signup({ phone: "+15551234567" })),
      { resolveEmailPort: mail.resolve, idempotency: fakeIdempotency() }
    );

    expect(result.confirmationSent).toBe(true);
    expect(result.notificationSent).toBe(true);

    const notification = mail.sent.find((m) => m.to.includes("orders@caratforus.com"));
    expect(notification!.text).toContain("Phone: +15551234567");

    // The phone changes what WE are told, never what the customer reads.
    const confirmation = mail.sent.find((m) => m.to.includes("brian@example.com"));
    expect(confirmation!.text).not.toContain("+15551234567");
  });
});

describe("the fallback greeting", () => {
  it("greets 'Hi there,' when Shopify delivers no first name", async () => {
    const mail = fakeMail();
    await handleFirstAccessSignupWebhook(event(signup({ first_name: null, last_name: null })), {
      resolveEmailPort: mail.resolve,
      idempotency: fakeIdempotency(),
    });

    const confirmation = mail.sent.find((m) => m.to.includes("brian@example.com"));
    expect(confirmation!.text.startsWith("Hi there,")).toBe(true);
    // "Hi ," is the thing this prevents, and it only ever shows up in an inbox.
    expect(confirmation!.text).not.toContain("Hi ,");
  });
});

describe("which customers are acted on", () => {
  it("ignores a customer who is not a Launching Soon signup", async () => {
    // Every customer created by any route arrives on this topic. Telling an
    // admin-created or checkout-created customer they are on an early-access
    // list would be a lie sent in our name.
    const mail = fakeMail();
    const result = await handleFirstAccessSignupWebhook(
      event(signup({ tags: "wholesale" })),
      { resolveEmailPort: mail.resolve, idempotency: fakeIdempotency() }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not_first_access");
    expect(mail.sent).toHaveLength(0);
  });

  it("recognises the tag whatever the spacing or case", async () => {
    const mail = fakeMail();
    const result = await handleFirstAccessSignupWebhook(
      event(signup({ tags: "Newsletter ,  First-Access" })),
      { resolveEmailPort: mail.resolve, idempotency: fakeIdempotency() }
    );
    expect(result.skipped).toBe(false);
    expect(mail.sent).toHaveLength(2);
  });

  it("ignores a payload with no email rather than throwing", async () => {
    const mail = fakeMail();
    const result = await handleFirstAccessSignupWebhook(event(signup({ email: "" })), {
      resolveEmailPort: mail.resolve,
      idempotency: fakeIdempotency(),
    });
    expect(result.skipped).toBe(true);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("delivery is at-least-once, so sending must be at-most-once", () => {
  it("does not email the customer twice on a redelivery", async () => {
    const mail = fakeMail();
    const idempotency = fakeIdempotency();
    const delivery = event(signup());

    await handleFirstAccessSignupWebhook(delivery, { resolveEmailPort: mail.resolve, idempotency });
    const second = await handleFirstAccessSignupWebhook(delivery, {
      resolveEmailPort: mail.resolve,
      idempotency,
    });

    expect(mail.sent).toHaveLength(2);
    expect(second.confirmationSent).toBe(false);
    expect(second.notificationSent).toBe(false);
  });

  it("resends only the half that failed", async () => {
    // The reason each email has its own key. A redelivery after a partial
    // failure must finish the job without repeating the part that worked.
    const sent: SendEmailInput[] = [];
    const idempotency = fakeIdempotency();
    let failNotification = true;
    const resolve = () =>
      ({
        configured: true as const,
        from: "hello@caratforus.com",
        recipients: ["orders@caratforus.com"],
        port: {
          async send(input: SendEmailInput) {
            if (failNotification && input.to.includes("orders@caratforus.com")) {
              throw new Error("provider down");
            }
            sent.push(input);
            return { providerMessageId: "msg" };
          },
        },
      });

    const delivery = event(signup());
    await expect(
      handleFirstAccessSignupWebhook(delivery, { resolveEmailPort: resolve, idempotency })
    ).rejects.toThrow(/incomplete/);
    expect(sent.filter((m) => m.to.includes("brian@example.com"))).toHaveLength(1);

    failNotification = false;
    const retry = await handleFirstAccessSignupWebhook(delivery, {
      resolveEmailPort: resolve,
      idempotency,
    });

    // Customer emailed once in total; we finally got our notification.
    expect(sent.filter((m) => m.to.includes("brian@example.com"))).toHaveLength(1);
    expect(retry.notificationSent).toBe(true);
  });
});

describe("when email is not configured", () => {
  it("fails loudly instead of reporting a send that did not happen", async () => {
    await expect(
      handleFirstAccessSignupWebhook(event(signup()), {
        resolveEmailPort: () => ({ configured: false, reason: "missing EMAIL_API_KEY" }),
        idempotency: fakeIdempotency(),
      })
    ).rejects.toThrow(/missing EMAIL_API_KEY/);
  });
});

describe("payload parsing", () => {
  it("reads Shopify's comma-separated tag string", () => {
    const parsed = parseFirstAccessSignupPayload(JSON.stringify(signup()));
    expect(parsed!.tags).toEqual(["first-access", "loose-diamonds"]);
    expect(parsed!.customerId).toBe("7700000001");
  });

  it("returns null rather than throwing on malformed JSON", () => {
    expect(parseFirstAccessSignupPayload("{not json")).toBeNull();
  });
});
