import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedLinqAccount } from "./accounts.js";
import {
  authorizeLinqSender,
  normalizeLinqSender,
  issueLinqPairingChallenge,
  type LinqChannelRuntime,
} from "./ingress.js";
import {
  markAsReadLinq,
  sendMessageLinq,
  startTypingLinq,
  stopTypingLinq,
} from "./send.js";
import type {
  LinqMediaPart,
  LinqMessageReceivedData,
  LinqTextPart,
} from "./types.js";

const CHANNEL_ID = "linq";

type LinqLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export function extractLinqText(
  parts: Array<{ type: string; value?: string }>,
): string {
  return parts
    .filter(
      (part): part is LinqTextPart =>
        part?.type === "text" && typeof part.value === "string",
    )
    .map((part) => part.value)
    .join("\n");
}

function extractLinqMedia(
  parts: Array<{ type: string; url?: string; mime_type?: string }>,
): Array<{ url: string; mimeType: string }> {
  return parts
    .filter(
      (part): part is LinqMediaPart & { url: string; mime_type: string } =>
        part?.type === "media" && Boolean(part.url) && Boolean(part.mime_type),
    )
    .map((part) => ({ url: part.url, mimeType: part.mime_type }));
}

export function normalizeLinqMessageReceivedData(
  raw: unknown,
): LinqMessageReceivedData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const legacyMessage = data.message as
    | { id?: unknown; parts?: unknown; reply_to?: unknown }
    | undefined;
  if (
    typeof data.chat_id === "string" &&
    typeof data.from === "string" &&
    legacyMessage &&
    typeof legacyMessage.id === "string" &&
    Array.isArray(legacyMessage.parts)
  ) {
    return {
      ...data,
      is_group: data.is_group !== false,
    } as LinqMessageReceivedData;
  }

  const chat = data.chat as
    | { id?: unknown; is_group?: unknown; owner_handle?: { handle?: unknown } }
    | undefined;
  const senderHandle = data.sender_handle as
    | { handle?: unknown; is_me?: unknown }
    | undefined;
  if (
    typeof chat?.id !== "string" ||
    typeof senderHandle?.handle !== "string" ||
    !Array.isArray(data.parts) ||
    typeof data.id !== "string"
  ) {
    return null;
  }

  return {
    chat_id: chat.id,
    is_group: chat.is_group !== false,
    from: senderHandle.handle,
    recipient_phone:
      typeof chat.owner_handle?.handle === "string"
        ? chat.owner_handle.handle
        : "",
    received_at:
      typeof data.sent_at === "string"
        ? data.sent_at
        : typeof data.created_at === "string"
          ? data.created_at
          : "",
    is_from_me: data.direction === "outbound" || senderHandle.is_me === true,
    service:
      data.service === "SMS" ||
      data.service === "RCS" ||
      data.service === "iMessage"
        ? data.service
        : "iMessage",
    message: {
      id: data.id,
      parts: data.parts as LinqMessageReceivedData["message"]["parts"],
      reply_to: data.reply_to as LinqMessageReceivedData["message"]["reply_to"],
    },
  };
}

function parseLinqTimestamp(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function dispatchLinqInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedLinqAccount;
  message: LinqMessageReceivedData;
  channelRuntime: LinqChannelRuntime;
  lifecycle?: ChannelIngressMonitorLifecycle;
  log?: LinqLog;
}): Promise<void> {
  const { message, account, cfg, channelRuntime: rt } = params;
  const sender = normalizeLinqSender(message.from ?? "");
  // Groups must not be reclassified as a trusted direct message.
  if (
    !/^\+[1-9]\d{6,14}$/u.test(sender) ||
    message.is_from_me ||
    message.is_group !== false ||
    !account.enabled
  )
    return;
  if (!account.fromPhone || message.recipient_phone !== account.fromPhone)
    return;
  const text = extractLinqText(message.message.parts);
  const media = extractLinqMedia(message.message.parts);
  if (!text.trim() && !media.length) return;
  const route = rt.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: sender },
  });
  const authorization = await authorizeLinqSender({
    cfg,
    account,
    channelRuntime: rt,
    sender,
    text,
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: message.message.id,
      inboundEventKind: "user_request",
    },
  });
  if (!authorization.senderAccess.allowed) {
    if (authorization.senderAccess.decision === "pairing") {
      await issueLinqPairingChallenge({
        account,
        channelRuntime: rt,
        sender,
        chatId: message.chat_id,
        log: params.log,
      });
    }
    return;
  }
  params.lifecycle?.abortSignal.throwIfAborted();
  const replyTarget = "linq:chat:" + message.chat_id;
  const bodyText = text.trim() || "<media:attachment>";
  const ctxPayload = rt.inbound.buildContext({
    channelIngress: authorization,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId: message.message.id,
    timestamp: parseLinqTimestamp(message.received_at),
    from: "linq:" + sender,
    sender: { id: sender, name: sender },
    conversation: { kind: "direct", id: sender, label: sender },
    route: {
      agentId: route.agentId,
      accountId: account.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: {
      to: replyTarget,
      originatingTo: replyTarget,
      replyToId: message.message.reply_to?.message_id,
    },
    message: {
      rawBody: bodyText,
      commandBody: bodyText,
      bodyForAgent: bodyText,
    },
    media: media.map((item) => ({ url: item.url, contentType: item.mimeType })),
    extra: { Service: message.service },
  });
  if (message.service === "iMessage") {
    void markAsReadLinq(message.chat_id, account.token);
    void startTypingLinq(message.chat_id, account.token);
  }
  try {
    await rt.inbound.dispatch({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      ctxPayload,
      ...(params.lifecycle
        ? bindIngressLifecycleToReplyOptions(params.lifecycle)
        : {}),
      delivery: {
        durable: { to: replyTarget },
        deliver: async (payload) => {
          const urls = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
          if (!payload.text && !urls.length) return { visibleReplySent: false };
          if (!urls.length)
            await sendMessageLinq(replyTarget, payload.text ?? "", {
              account,
              signal: params.lifecycle?.abortSignal,
            });
          else
            for (const [index, mediaUrl] of urls.entries()) {
              await sendMessageLinq(
                replyTarget,
                index === 0 ? (payload.text ?? "") : "",
                { account, mediaUrl, signal: params.lifecycle?.abortSignal },
              );
            }
          return { visibleReplySent: true };
        },
      },
    });
  } finally {
    if (message.service === "iMessage")
      void stopTypingLinq(message.chat_id, account.token);
  }
}
