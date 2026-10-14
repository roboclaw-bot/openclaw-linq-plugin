import { describe, expect, it } from "vitest";
import { toLinqOutboundDeliveryResult } from "./message.js";

describe("Linq delivery receipts", () => {
  it("preserves provider message and conversation identity", () => {
    const result = toLinqOutboundDeliveryResult(
      {
        messageId: "msg_1",
        chatId: "chat_1",
        target: "linq:chat:chat_1",
        accountId: "default",
        fromPhone: "+15557654321",
        traceId: "trace_1",
      },
      "text",
    );

    expect(result).toMatchObject({
      channel: "linq",
      messageId: "msg_1",
      target: { kind: "chat", id: "chat_1" },
      receipt: {
        primaryPlatformMessageId: "msg_1",
        platformMessageIds: ["msg_1"],
        parts: [{ kind: "text", raw: { conversationId: "chat_1" } }],
      },
    });
  });

  it("does not record the legacy unknown sentinel as a platform message id", () => {
    const result = toLinqOutboundDeliveryResult(
      {
        messageId: "unknown",
        chatId: "chat_1",
        target: "linq:+15551234567",
      },
      "text",
    );

    expect(result.receipt).toMatchObject({
      platformMessageIds: [],
    });
    expect(result.receipt.platformMessageIds).not.toContain("unknown");
  });
});
