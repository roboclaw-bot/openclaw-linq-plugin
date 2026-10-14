/** Linq Blue V3 webhook event envelope. */
export type LinqWebhookEvent = {
  webhook_version?: string;
  api_version?: "v3";
  event_id: string;
  created_at?: string;
  trace_id?: string;
  partner_id?: string;
  event_type: string;
  data: unknown;
};

export type LinqMessageReceivedData = {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_group?: boolean;
  is_from_me: boolean;
  service: "iMessage" | "SMS" | "RCS";
  message: LinqIncomingMessage;
};

export type LinqIncomingMessage = {
  id: string;
  parts: LinqMessagePart[];
  effect?: { type: "screen" | "bubble"; name: string };
  reply_to?: { message_id: string; part_index?: number };
};

export type LinqTextPart = { type: "text"; value: string };
export type LinqMediaPart = {
  type: "media";
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
};
export type LinqMessagePart = LinqTextPart | LinqMediaPart;

export type LinqReactionReceivedData = {
  chat_id: string;
  from: string;
  message_id: string;
  reaction: {
    type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
    operation: "add" | "remove";
  };
  received_at: string;
  is_from_me: boolean;
};

export type LinqDeliveryStatusData = {
  chat_id: string;
  message_id: string;
  status: "delivered" | "read" | "failed";
  updated_at: string;
};

export type LinqSendResult = {
  messageId: string;
  chatId: string;
  target: string;
  accountId?: string;
  fromPhone?: string;
  traceId?: string;
};

export type LinqProbe = {
  ok: boolean;
  error?: string | null;
  phoneNumbers?: string[];
};

export type LinqSecretRef = {
  source: "env" | "file" | "exec";
  provider?: string;
  id: string;
};

/** Per-account config for the Linq channel (mirrors the Zod schema shape). */
export type LinqAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Linq API bearer token or SecretRef-backed token. */
  apiToken?: string | LinqSecretRef;
  /** Read token from file instead of config (mutual exclusive with apiToken). */
  tokenFile?: string;
  /** Phone number this account sends from (E.164). */
  fromPhone?: string;
  /** DM security policy. */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowed sender IDs (phone numbers or "*"). */
  allowFrom?: Array<string | number>;
  /** Webhook URL for inbound messages from Linq. */
  inboundEnabled?: boolean;
  webhookUrl?: string;
  /** Webhook HMAC signing secret or SecretRef-backed secret. */
  webhookSecret?: string | LinqSecretRef;
  /** Local HTTP path prefix for the webhook listener (default: /linq-webhook). */
  webhookPath?: string;
  /** Deprecated: OpenClaw owns plugin route binding. */
  webhookHost?: string;
  /** Per-account sub-accounts. */
  accounts?: Record<string, LinqAccountConfig>;
  /** Preferred default account id. */
  defaultAccount?: string;
};
