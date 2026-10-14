import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageLinq } from "./send.js";
const cfg = {
  channels: { linq: { apiToken: "fixture-token", fromPhone: "+15555550101" } },
};
afterEach(() => vi.unstubAllGlobals());
describe("Linq send contract", () => {
  it("uses current nested new-chat receipt and stable idempotency body", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ chat: { id: "c1", message: { id: "m1" } } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await sendMessageLinq("linq:+15555550102", "hello", {
        config: cfg,
        idempotencyKey: "q:0",
      }),
    ).toMatchObject({ messageId: "m1", chatId: "c1" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      from: "+15555550101",
      to: ["+15555550102"],
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "q:0",
      },
    });
  });
  it("encodes chat ids, passes media/reply and fences immediately before dispatch", async () => {
    const fence = vi.fn(),
      before = vi.fn(async () => {});
    const fetcher = vi.fn(async () => {
      expect(fence).toHaveBeenCalled();
      expect(before).toHaveBeenCalled();
      return Response.json({ message: { id: "m2" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await sendMessageLinq("linq:chat:c:1", "caption", {
      config: cfg,
      mediaUrl: "https://example.com/file.png",
      replyToMessageId: "m0",
      idempotencyKey: "q:1",
      beforeSend: before,
      assertCurrent: fence,
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.linqapp.com/api/partner/v3/chats/c%3A1/messages",
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body).message).toMatchObject({
      reply_to: { message_id: "m0", part_index: 0 },
      parts: [
        { type: "text" },
        { type: "media", url: "https://example.com/file.png" },
      ],
    });
  });
  it("rejects groups, cross-account selection, disabled accounts and unauthorized local files", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      sendMessageLinq("linq:group:c1", "hi", { config: cfg }),
    ).rejects.toThrow(/group/);
    await expect(
      sendMessageLinq("linq:chat:c1", "hi", {
        config: {
          channels: { linq: { ...cfg.channels.linq, enabled: false } },
        },
      }),
    ).rejects.toThrow(/disabled/);
    await expect(
      sendMessageLinq("linq:chat:c1", "", {
        config: cfg,
        mediaUrl: "/etc/passwd",
        mediaLocalRoots: [],
      }),
    ).rejects.toThrow();
    await expect(
      sendMessageLinq("linq:other:chat:c1", "hi", {
        config: cfg,
        accountId: "default",
      }),
    ).rejects.toThrow(/does not match/);
    await expect(
      sendMessageLinq("linq:missing:chat:c1", "hi", { config: cfg }),
    ).rejects.toThrow(/Unknown/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retries only throttling with the same idempotency key and rechecks fences", async () => {
    const fence = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(Response.json({ message: { id: "m1" } }));
    vi.stubGlobal("fetch", fetcher);
    await sendMessageLinq("linq:chat:c1", "hi", {
      config: cfg,
      idempotencyKey: "stable",
      assertCurrent: fence,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    fetcher
      .mockReset()
      .mockResolvedValue(
        new Response("sensitive-provider-body", { status: 503 }),
      );
    await expect(
      sendMessageLinq("linq:chat:c1", "hi", { config: cfg }),
    ).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not invent receipts or dispatch after cancellation", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      sendMessageLinq("linq:chat:c1", "hi", { config: cfg }),
    ).rejects.toThrow(/outcome is unknown/);
    fetcher.mockClear();
    await expect(
      sendMessageLinq("linq:chat:c1", "hi", {
        config: cfg,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
