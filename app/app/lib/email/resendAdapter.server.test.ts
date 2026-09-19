import { describe, expect, it, vi } from "vitest";

import { EmailSendError } from "./port";
import { ResendEmailPort } from "./resendAdapter.server";

function fakeFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json ?? (async () => ({})),
  })) as unknown as typeof fetch;
}

describe("ResendEmailPort.send", () => {
  it("posts the expected payload and returns the provider message id on success", async () => {
    const fetchImpl = fakeFetch({ ok: true, json: async () => ({ id: "msg_abc123" }) });
    const port = new ResendEmailPort("re_test_key", fetchImpl);

    const result = await port.send({
      from: "alerts@caratforus.example",
      to: ["staff@example.com"],
      subject: "Test subject",
      text: "Test body",
    });

    expect(result).toEqual({ providerMessageId: "msg_abc123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body)).toEqual({
      from: "alerts@caratforus.example",
      to: ["staff@example.com"],
      subject: "Test subject",
      text: "Test body",
    });
  });

  it("throws EmailSendError on a non-OK response, without leaking the response body", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 422 });
    const port = new ResendEmailPort("re_test_key", fetchImpl);

    await expect(
      port.send({ from: "a@b.com", to: ["c@d.com"], subject: "s", text: "t" })
    ).rejects.toBeInstanceOf(EmailSendError);
    await expect(
      port.send({ from: "a@b.com", to: ["c@d.com"], subject: "s", text: "t" })
    ).rejects.toMatchObject({ message: expect.stringContaining("422") });
  });

  it("throws EmailSendError when the response carries no message id", async () => {
    const fetchImpl = fakeFetch({ ok: true, json: async () => ({}) });
    const port = new ResendEmailPort("re_test_key", fetchImpl);

    await expect(
      port.send({ from: "a@b.com", to: ["c@d.com"], subject: "s", text: "t" })
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});
