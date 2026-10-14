import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import {
  createChannelIngressMonitor,
  waitUntilAbort,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { getLinqRuntime } from "../runtime.js";
import { resolveLinqAccount } from "./accounts.js";
import {
  dispatchLinqInboundEvent,
  normalizeLinqMessageReceivedData,
} from "./inbound.js";
import type { LinqWebhookEvent } from "./types.js";
import { createLinqWebhookHandler } from "./webhook.js";

const MAX_BYTES = 1024 * 1024;
const activeWebhookPaths = new Set<string>();
export type LinqIngressPayload = { version: number; rawEvent: string };

/** Persist the original envelope, not a lossy normalized message or an in-memory debounce. */
export function createLinqIngress(params: {
  queue: ChannelIngressQueue<LinqIngressPayload>;
  deliver: (
    event: LinqWebhookEvent,
    lifecycle: ChannelIngressMonitorLifecycle,
  ) => Promise<void>;
  abortSignal?: AbortSignal;
  onError?: (error: unknown) => void;
}) {
  return createChannelIngressMonitor<
    LinqWebhookEvent,
    string,
    LinqIngressPayload
  >({
    queue: params.queue,
    inspect: (event) => {
      if (event.event_type !== "message.received") return null;
      const message = normalizeLinqMessageReceivedData(event.data);
      if (!message) return null;
      return { eventId: event.event_id, laneKey: message.chat_id };
    },
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (event) => JSON.stringify(event),
      deserialize: (raw) => JSON.parse(raw) as LinqWebhookEvent,
      createClaimError: () =>
        new Error("Invalid Linq durable ingress identity or version"),
    },
    retention: "standard",
    pollIntervalMs: 500,
    admissionMode: "while-running",
    abortSignal: params.abortSignal,
    deliver: params.deliver,
    onError: params.onError,
  });
}

export function createLinqHttpHandler(params: {
  path: string;
  secret: string;
  admit: (event: LinqWebhookEvent) => Promise<unknown>;
  onError?: () => void;
}) {
  const verify = createLinqWebhookHandler({
    path: params.path,
    secret: params.secret,
    maxBytes: MAX_BYTES,
  });
  return async (req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (req.method !== "POST") {
      respond(405, "method not allowed");
      return;
    }
    if (new URL(req.url ?? "/", "http://localhost").pathname !== params.path) {
      respond(404, "not found");
      return;
    }
    // Bound slow bodies below Linq's ten-second delivery timeout.
    const bodyTimeout = setTimeout(() => {
      if (!res.headersSent) respond(408, "request body timeout");
      req.destroy();
    }, 5000);
    bodyTimeout.unref();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BYTES) {
          respond(413, "payload too large");
          return;
        }
        chunks.push(bytes);
      }
      clearTimeout(bodyTimeout);
      const result = await verify({
        method: req.method ?? "GET",
        path: new URL(req.url ?? "/", "http://localhost").pathname,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (result.event) {
        if (
          result.event.event_type === "message.received" &&
          !normalizeLinqMessageReceivedData(result.event.data)
        ) {
          respond(400, "malformed message.received");
          return;
        }
        // 200 is transport ACK: never send it before durable append has settled.
        await params.admit(result.event);
      }
      respond(result.status, result.body);
    } catch {
      params.onError?.();
      if (!res.headersSent) respond(503, "ingress unavailable; retry");
    } finally {
      clearTimeout(bodyTimeout);
    }
  };
}

export type MonitorLinqOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: {
    info: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  abortSignal?: AbortSignal;
  channelRuntime?: PluginRuntime;
};

export async function monitorLinqProvider(
  opts: MonitorLinqOpts = {},
): Promise<void> {
  const rt = opts.channelRuntime ?? getLinqRuntime();
  const cfg = opts.config ?? (rt.config.current() as OpenClawConfig);
  const readConfig = createRuntimeConfigReader(cfg);
  const account = resolveLinqAccount({ cfg, accountId: opts.accountId });
  if (!account.enabled || !account.token)
    throw new Error("Linq account is disabled or API token is missing");
  if (account.config.inboundEnabled === false) {
    opts.runtime?.info(
      "Linq outbound-only mode; no inbound webhook registered",
    );
    await waitUntilAbort(opts.abortSignal);
    return;
  }
  if (!account.fromPhone)
    throw new Error(
      "Linq inbound requires fromPhone to bind the receiving line",
    );
  if (!account.webhookSecret)
    throw new Error(
      "Linq inbound requires webhookSecret (or explicitly set inboundEnabled=false)",
    );
  const path = account.config.webhookPath?.trim() || "/linq-webhook";
  if (activeWebhookPaths.has(path))
    throw new Error(
      "Linq webhookPath is already registered; use a distinct path for each account",
    );
  const ingress = createLinqIngress({
    queue: rt.state.openChannelIngressQueue<LinqIngressPayload>({
      accountId: account.accountId,
    }),
    abortSignal: opts.abortSignal,
    onError: () =>
      opts.runtime?.error?.(
        "Linq ingress failed; durable pending events will retry",
      ),
    deliver: async (event, lifecycle) => {
      const current = readConfig();
      const currentAccount = resolveLinqAccount({
        cfg: current,
        accountId: account.accountId,
      });
      if (
        !currentAccount.enabled ||
        currentAccount.config.inboundEnabled === false
      )
        return;
      const message = normalizeLinqMessageReceivedData(event.data);
      if (!message) return;
      await dispatchLinqInboundEvent({
        cfg: current,
        account: currentAccount,
        message,
        channelRuntime: rt.channel,
        lifecycle,
        log: opts.runtime,
      });
    },
  });
  ingress.ensureQueueAvailable();
  activeWebhookPaths.add(path);
  let unregister: (() => void) | undefined;
  try {
    ingress.start();
    unregister = registerPluginHttpRoute({
      path,
      auth: "plugin",
      pluginId: "linq",
      accountId: account.accountId,
      handler: createLinqHttpHandler({
        path,
        secret: account.webhookSecret,
        admit: (event) => ingress.admit(event),
        onError: () =>
          opts.runtime?.error?.("Linq webhook admission unavailable"),
      }),
    });
    opts.runtime?.info("Linq signed webhook registered at " + path);
    await waitUntilAbort(opts.abortSignal);
  } finally {
    unregister?.();
    activeWebhookPaths.delete(path);
    await ingress.stop();
  }
}
