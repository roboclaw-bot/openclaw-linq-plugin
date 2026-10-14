import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import {
  buildOutboundMediaLoadOptions,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "openclaw/plugin-sdk/media-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  resolveLinqAccount,
  listLinqAccountIds,
  type ResolvedLinqAccount,
} from "./accounts.js";
import { parseLinqTarget } from "./targets.js";
import type { LinqSendResult } from "./types.js";

const BASE = "https://api.linqapp.com/api/partner/v3";
const UA = "OpenClaw-Linq/1.0";

export type LinqSendOpts = {
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
  accountId?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
  token?: string;
  config?: OpenClawConfig;
  account?: ResolvedLinqAccount;
  idempotencyKey?: string;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
  assertCurrent?: () => void;
};

async function apiRequest(
  path: string,
  token: string,
  body: unknown,
  signal?: AbortSignal,
  beforeAttempt?: () => Promise<void>,
) {
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    await beforeAttempt?.();
    const response = await fetch(BASE + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 2) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter);
      const wait = retryAfter
        ? Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now()
        : 500 * 2 ** attempt;
      await response.body?.cancel();
      // Never retry earlier than the provider's requested time, or keep the host lane asleep unboundedly.
      if (!Number.isFinite(wait) || wait > 10_000)
        throw new Error(
          "Linq rate limited; retry after " + (retryAfter ?? "later"),
        );
      await delay(Math.max(wait, 0), undefined, { signal });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Linq API request failed (HTTP " + response.status + ")");
    }
    return response.json() as Promise<Record<string, any>>;
  }
}

async function mediaPart(
  url: string,
  token: string,
  opts: LinqSendOpts,
): Promise<Record<string, string>> {
  if (/^https?:/i.test(url)) {
    const remote = new URL(url);
    if (remote.protocol !== "https:" || remote.username || remote.password)
      throw new Error("Linq media requires a public HTTPS URL");
    return { type: "media", url: remote.href };
  }
  const media = await loadWebMediaRaw(
    url,
    buildOutboundMediaLoadOptions({
      maxBytes: 100 * 1024 * 1024,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    }),
  );
  opts.signal?.throwIfAborted();
  const upload = await apiRequest(
    "/attachments",
    token,
    {
      filename: media.fileName ?? "attachment",
      content_type: media.contentType ?? "application/octet-stream",
      size_bytes: media.buffer.length,
    },
    opts.signal,
  );
  if (
    typeof upload.attachment_id !== "string" ||
    typeof upload.upload_url !== "string" ||
    upload.http_method !== "PUT" ||
    new URL(upload.upload_url).protocol !== "https:"
  )
    throw new Error("Invalid Linq attachment upload response");
  const { response, release } = await fetchWithSsrFGuard({
    url: upload.upload_url,
    init: {
      method: "PUT",
      headers: upload.required_headers,
      body: new Uint8Array(media.buffer),
      redirect: "error",
    },
    signal: opts.signal,
    timeoutMs: 30_000,
  });
  try {
    if (!response.ok)
      throw new Error(
        "Linq attachment upload failed (HTTP " + response.status + ")",
      );
    await response.body?.cancel();
  } finally {
    await release();
  }
  return { type: "media", attachment_id: upload.attachment_id };
}

export async function sendMessageLinq(
  to: string,
  text: string,
  opts: LinqSendOpts = {},
): Promise<LinqSendResult> {
  const target = parseLinqTarget(to, opts.accountId ?? opts.account?.accountId);
  if (target.kind === "group")
    throw new Error("Linq group sends are not enabled in this plugin version");
  if (opts.accountId && target.accountId && opts.accountId !== target.accountId)
    throw new Error("Linq target account does not match selected account");
  if (
    opts.account &&
    target.accountId &&
    opts.account.accountId !== target.accountId
  )
    throw new Error("Linq target account does not match selected account");
  if (
    opts.config &&
    target.accountId &&
    !listLinqAccountIds(opts.config).includes(target.accountId)
  ) {
    throw new Error("Unknown Linq account");
  }
  const account =
    opts.account ??
    (opts.config
      ? resolveLinqAccount({ cfg: opts.config, accountId: target.accountId })
      : undefined);
  if (account && !account.enabled) throw new Error("Linq account is disabled");
  const token = opts.token?.trim() || account?.token;
  if (!token) throw new Error("Linq API token not configured");
  if (target.kind === "phone" && !account?.fromPhone)
    throw new Error(
      "Linq phone targets require fromPhone on the selected account",
    );
  const parts: Record<string, string>[] = [];
  if (text) parts.push({ type: "text", value: text });
  if (opts.mediaUrl?.trim())
    parts.push(await mediaPart(opts.mediaUrl.trim(), token, opts));
  if (!parts.length) throw new Error("Linq send requires text or media");
  const message = {
    parts,
    idempotency_key: opts.idempotencyKey ?? randomUUID(),
    ...(opts.replyToMessageId
      ? { reply_to: { message_id: opts.replyToMessageId, part_index: 0 } }
      : {}),
  };
  const data = await apiRequest(
    target.kind === "phone"
      ? "/chats"
      : "/chats/" + encodeURIComponent(target.chatId) + "/messages",
    token,
    target.kind === "phone"
      ? { from: account!.fromPhone, to: [target.phone], message }
      : { message },
    opts.signal,
    async () => {
      await opts.beforeSend?.();
      opts.signal?.throwIfAborted();
      opts.assertCurrent?.();
    },
  );
  const messageId =
    data.message?.id ?? data.chat?.message?.id ?? data.message_id;
  const chatId =
    data.chat_id ??
    data.chat?.id ??
    (target.kind === "chat" ? target.chatId : undefined);
  if (
    typeof messageId !== "string" ||
    !messageId ||
    typeof chatId !== "string" ||
    !chatId
  ) {
    throw new Error(
      "Linq accepted the request without a usable receipt; delivery outcome is unknown",
    );
  }
  return {
    messageId,
    chatId,
    target: target.raw,
    accountId: account?.accountId ?? target.accountId,
    fromPhone: account?.fromPhone,
  };
}

async function optionalAction(
  chatId: string,
  token: string,
  action: "read" | "typing",
  method = "POST",
): Promise<boolean> {
  try {
    const response = await fetch(
      BASE + "/chats/" + encodeURIComponent(chatId) + "/" + action,
      {
        method,
        headers: { Authorization: "Bearer " + token, "User-Agent": UA },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
export const markAsReadLinq = (id: string, token: string) =>
  optionalAction(id, token, "read");
export const startTypingLinq = (id: string, token: string) =>
  optionalAction(id, token, "typing");
export const stopTypingLinq = (id: string, token: string) =>
  optionalAction(id, token, "typing", "DELETE");
