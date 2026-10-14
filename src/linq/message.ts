import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendMediaContext,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { sendMessageLinq } from "./send.js";
import type { LinqSendResult } from "./types.js";

const CHANNEL_ID = "linq";

export function toLinqOutboundDeliveryResult(
  result: LinqSendResult,
  kind: "text" | "media",
  replyToId?: string | null,
) {
  const receipt = createMessageReceiptFromOutboundResults({
    results: [
      {
        channel: CHANNEL_ID,
        messageId:
          result.messageId === "unknown" ? undefined : result.messageId,
        chatId: result.chatId,
        conversationId: result.chatId,
        meta: {
          target: result.target,
          ...(result.fromPhone ? { fromPhone: result.fromPhone } : {}),
          ...(result.traceId ? { traceId: result.traceId } : {}),
        },
      },
    ],
    kind,
    ...(replyToId ? { replyToId } : {}),
  });
  return {
    channel: CHANNEL_ID,
    messageId: result.messageId,
    accountId: result.accountId,
    target: { kind: "chat" as const, id: result.chatId },
    receipt,
  };
}

async function sendLinqMessage(
  params: ChannelMessageSendTextContext &
    Partial<ChannelMessageSendMediaContext>,
) {
  const result = await sendMessageLinq(params.to, params.text, {
    config: params.cfg,
    accountId: params.accountId ?? undefined,
    mediaUrl: params.mediaUrl,
    replyToMessageId: params.replyToId ?? undefined,
    signal: params.signal,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
    idempotencyKey: params.deliveryQueueId
      ? params.deliveryQueueId + ":" + (params.deliveryPartIndex ?? 0)
      : undefined,
    beforeSend: params.onPlatformSendDispatch,
    assertCurrent: params.assertDirectAdapterHandoff,
  });
  return toLinqOutboundDeliveryResult(
    result,
    params.mediaUrl ? "media" : "text",
    params.replyToId,
  );
}

export const linqMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendLinqMessage(ctx);
      return {
        messageId: result.receipt.primaryPlatformMessageId,
        receipt: result.receipt,
      };
    },
    media: async (ctx) => {
      const result = await sendLinqMessage({ ...ctx, mediaUrl: ctx.mediaUrl });
      return {
        messageId: result.receipt.primaryPlatformMessageId,
        receipt: result.receipt,
      };
    },
  },
});
