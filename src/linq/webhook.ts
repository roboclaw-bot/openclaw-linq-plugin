import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinqWebhookEvent } from "./types.js";

export type LinqWebhookRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | string;
};
export type LinqWebhookHandlerOptions = {
  path: string;
  secret: string;
  maxBytes?: number;
  replayWindowSeconds?: number;
  now?: () => number;
};
export type LinqWebhookHandlerResult = {
  status: number;
  body: string;
  event?: LinqWebhookEvent;
};

function headerValue(
  headers: LinqWebhookRequest["headers"],
  name: string,
): string {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key ? headers[key] : undefined;
  // Duplicate security headers are ambiguous, not a list to select from.
  return typeof value === "string" ? value : "";
}

/** Standard Webhooks, pinned to Linq's 2026-02-03 contract. No unsigned/legacy downgrade. */
export function verifyWebhookSignature(params: {
  secret: string;
  payload: Buffer | string;
  id: string;
  timestamp: string;
  signature: string;
}): boolean {
  const encoded = params.secret.replace(/^whsec_/, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const key = Buffer.from(encoded, "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key)
    .update(params.id + "." + params.timestamp + ".")
    .update(params.payload)
    .digest();
  return params.signature.split(/\s+/).some((signature) => {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      return false;
    const received = Buffer.from(value, "base64");
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
}

export function createLinqWebhookHandler(options: LinqWebhookHandlerOptions) {
  if (!options.secret.trim())
    throw new Error("Linq inbound requires webhookSecret");
  const now = options.now ?? Date.now;
  return async (
    request: LinqWebhookRequest,
  ): Promise<LinqWebhookHandlerResult> => {
    if (request.path !== options.path)
      return { status: 404, body: "not found" };
    if (request.method.toUpperCase() !== "POST")
      return { status: 405, body: "method not allowed" };
    const raw = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body);
    if (raw.length > (options.maxBytes ?? 1024 * 1024)) {
      return { status: 413, body: "payload too large" };
    }
    const id = headerValue(request.headers, "webhook-id");
    const timestamp = headerValue(request.headers, "webhook-timestamp");
    const signature = headerValue(request.headers, "webhook-signature");
    if (!id || !/^[0-9]+$/.test(timestamp) || !signature) {
      return { status: 401, body: "missing or invalid signature headers" };
    }
    const age = Math.abs(now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > (options.replayWindowSeconds ?? 300)) {
      return { status: 401, body: "stale timestamp" };
    }
    if (
      !verifyWebhookSignature({
        secret: options.secret,
        payload: raw,
        id,
        timestamp,
        signature,
      })
    ) {
      return { status: 401, body: "invalid signature" };
    }
    let event: unknown;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return { status: 400, body: "malformed json" };
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { status: 400, body: "invalid envelope" };
    }
    const record = event as Record<string, unknown>;
    if (
      typeof record.event_id !== "string" ||
      !record.event_id.trim() ||
      typeof record.event_type !== "string" ||
      !("data" in record)
    ) {
      return { status: 400, body: "invalid envelope" };
    }
    // Deduplication belongs to the durable queue, after successful append, never here.
    return {
      status: 200,
      body: JSON.stringify({ received: true }),
      event: record as LinqWebhookEvent,
    };
  };
}
