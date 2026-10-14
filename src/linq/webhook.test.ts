import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLinqWebhookHandler } from "./webhook.js";
const key = Buffer.alloc(32, 7);
const secret = "whsec_" + key.toString("base64");
const body = Buffer.from(
  JSON.stringify({ event_id: "e1", event_type: "message.received", data: {} }),
);
function request(bytes = body, timestamp = "1000") {
  return {
    method: "POST",
    path: "/linq",
    body: bytes,
    headers: {
      "webhook-id": "d1",
      "webhook-timestamp": timestamp,
      "webhook-signature":
        "v1," +
        createHmac("sha256", key)
          .update("d1." + timestamp + ".")
          .update(bytes)
          .digest("base64"),
    },
  };
}
const handle = createLinqWebhookHandler({
  path: "/linq",
  secret,
  now: () => 1_000_000,
});
describe("Standard Webhooks authentication", () => {
  it("requires a secret and authenticates exact bytes", async () => {
    expect(() =>
      createLinqWebhookHandler({ path: "/linq", secret: "" }),
    ).toThrow();
    expect((await handle(request())).status).toBe(200);
    expect(
      (
        await handle({
          ...request(),
          body: Buffer.concat([body, Buffer.from(" ")]),
        })
      ).status,
    ).toBe(401);
  });
  it("rejects missing, duplicate, stale and legacy-only headers", async () => {
    expect((await handle({ ...request(), headers: {} })).status).toBe(401);
    expect((await handle(request(body, "1"))).status).toBe(401);
    expect(
      (
        await handle({
          ...request(),
          headers: { ...request().headers, "webhook-id": ["d1", "d1"] },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handle({
          ...request(),
          headers: {
            "x-webhook-signature": "legacy",
            "x-webhook-timestamp": "1000",
          },
        })
      ).status,
    ).toBe(401);
  });
  it("allows rotated signatures but never unsigned parsing", async () => {
    const req = request();
    req.headers["webhook-signature"] =
      "v1,invalid " + req.headers["webhook-signature"];
    expect((await handle(req)).status).toBe(200);
    for (const invalid of ["null", "[]", "{}", "{"])
      expect((await handle(request(Buffer.from(invalid)))).status).toBe(400);
  });
  it("bounds bodies and methods; retries retain the event for durable dedupe", async () => {
    expect((await handle({ ...request(), method: "GET" })).status).toBe(405);
    expect((await handle({ ...request(), path: "/other" })).status).toBe(404);
    const small = createLinqWebhookHandler({
      path: "/linq",
      secret,
      maxBytes: 8,
    });
    expect((await small(request())).status).toBe(413);
    expect((await handle(request())).event?.event_id).toBe("e1");
    expect((await handle(request())).event?.event_id).toBe("e1");
  });
});
