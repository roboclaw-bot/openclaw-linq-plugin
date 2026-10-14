import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLinqHttpHandler } from "./gateway.js";
const key = Buffer.alloc(32, 3);
const event = {
  event_id: "e1",
  event_type: "message.received",
  data: {
    chat: {
      id: "c1",
      is_group: false,
      owner_handle: { handle: "+15555550101" },
    },
    sender_handle: { handle: "+15555550102" },
    id: "m1",
    parts: [{ type: "text", value: "hi" }],
  },
};
async function serve(
  admit: (value: unknown) => Promise<unknown>,
  test: (
    url: string,
    headers: Record<string, string>,
    body: string,
  ) => Promise<void>,
) {
  const server = createServer(
    createLinqHttpHandler({
      path: "/linq",
      secret: "whsec_" + key.toString("base64"),
      admit,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const timestamp = String(Math.floor(Date.now() / 1000)),
    body = JSON.stringify(event);
  const headers = {
    "webhook-id": "w1",
    "webhook-timestamp": timestamp,
    "webhook-signature":
      "v1," +
      createHmac("sha256", key)
        .update("w1." + timestamp + "." + body)
        .digest("base64"),
  };
  try {
    await test(
      "http://127.0.0.1:" +
        (server.address() as { port: number }).port +
        "/linq",
      headers,
      body,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
describe("durable admission HTTP boundary", () => {
  it("withholds 200 until append resolves", async () => {
    let finish!: () => void, entered!: () => void;
    const entry = new Promise<void>((r) => (entered = r)),
      append = new Promise<void>((r) => (finish = r));
    await serve(
      async () => {
        entered();
        await append;
      },
      async (url, headers, body) => {
        let acknowledged = false;
        const pending = fetch(url, { method: "POST", headers, body }).then(
          (r) => {
            acknowledged = true;
            return r;
          },
        );
        await entry;
        await new Promise((r) => setTimeout(r, 20));
        expect(acknowledged).toBe(false);
        finish();
        expect((await pending).status).toBe(200);
      },
    );
  });
  it("returns retryable 503 on append failure, never invokes admission without authentication", async () => {
    const admit = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    await serve(admit, async (url, headers, body) => {
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(
        503,
      );
      expect((await fetch(url, { method: "POST", body })).status).toBe(401);
      expect(admit).toHaveBeenCalledTimes(1);
    });
  });
});
