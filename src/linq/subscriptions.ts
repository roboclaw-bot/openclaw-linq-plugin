export const LINQ_INBOUND_WEBHOOK_EVENTS = ["message.received"] as const;

const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";
const UA = "OpenClaw-Linq/1.0";

export type LinqWebhookSubscription = {
  id: string;
  is_active: boolean;
  subscribed_events: string[];
  target_url: string;
  phone_numbers?: string[] | null;
  signing_secret?: string;
};

class LinqApiError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(params: { status: number; body: string; code?: number }) {
    super(
      `Linq API request failed (HTTP ${params.status}${params.code ? `, code ${params.code}` : ""})`,
    );
    this.name = "LinqApiError";
    this.status = params.status;
    this.code = params.code;
  }
}

async function fetchLinqJson<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchLinq(token, path, init);
  return (await response.json()) as T;
}

async function fetchLinq(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${LINQ_API_BASE}${path}`, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let code: number | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown } };
      code =
        typeof parsed.error?.code === "number" ? parsed.error.code : undefined;
    } catch {
      // Non-JSON error bodies still carry the HTTP status and truncated body.
    }
    throw new LinqApiError({ status: response.status, body: text, code });
  }
  return response;
}

function hasInboundWebhookEvents(
  subscription: LinqWebhookSubscription,
): boolean {
  return LINQ_INBOUND_WEBHOOK_EVENTS.every((event) =>
    subscription.subscribed_events.includes(event),
  );
}

function matchesWebhookSubscription(params: {
  subscription: LinqWebhookSubscription;
  targetUrl: string;
  phoneNumber?: string;
}): boolean {
  const expectedUrl = params.targetUrl.trim();
  const expectedPhone = params.phoneNumber?.trim();
  const { subscription } = params;
  if (!subscription.is_active) {
    return false;
  }
  if (!hasInboundWebhookEvents(subscription)) {
    return false;
  }
  if (subscription.target_url !== expectedUrl) {
    return false;
  }
  if (!expectedPhone) {
    return true;
  }
  const phoneNumbers = subscription.phone_numbers ?? [];
  return phoneNumbers.length === 1 && phoneNumbers[0] === expectedPhone;
}

export async function listLinqWebhookSubscriptions(
  token: string,
): Promise<LinqWebhookSubscription[]> {
  const data = await fetchLinqJson<{
    subscriptions?: LinqWebhookSubscription[];
  }>(token, "/webhook-subscriptions");
  return data.subscriptions ?? [];
}

export function findLinqWebhookSubscription(
  subscriptions: LinqWebhookSubscription[],
  targetUrl: string,
  phoneNumber?: string,
): LinqWebhookSubscription | undefined {
  return subscriptions.find((subscription) =>
    matchesWebhookSubscription({ subscription, targetUrl, phoneNumber }),
  );
}

export function findReplaceableLinqWebhookSubscriptions(
  subscriptions: LinqWebhookSubscription[],
  params: {
    targetUrl: string;
    phoneNumber?: string;
    previousTargetUrl?: string;
    previousPhoneNumber?: string;
  },
): LinqWebhookSubscription[] {
  const targetUrl = params.targetUrl.trim();
  const previousTargetUrl = params.previousTargetUrl?.trim();
  const phoneNumber = params.phoneNumber?.trim();
  const previousPhoneNumber = params.previousPhoneNumber?.trim();
  const candidateUrls = new Set(
    [targetUrl, previousTargetUrl].filter((url): url is string => Boolean(url)),
  );

  return subscriptions.filter((subscription) => {
    if (!subscription.is_active || !hasInboundWebhookEvents(subscription)) {
      return false;
    }
    if (matchesWebhookSubscription({ subscription, targetUrl, phoneNumber })) {
      return false;
    }
    if (!candidateUrls.has(subscription.target_url)) {
      return false;
    }
    const phones = subscription.phone_numbers ?? [];
    return (
      phones.length === 1 &&
      Boolean(phones[0]) &&
      (phones[0] === phoneNumber || phones[0] === previousPhoneNumber)
    );
  });
}

export async function createLinqWebhookSubscription(params: {
  token: string;
  targetUrl: string;
  phoneNumber?: string;
  subscribedEvents?: readonly string[];
}): Promise<LinqWebhookSubscription> {
  const body = {
    subscribed_events: [
      ...(params.subscribedEvents ?? LINQ_INBOUND_WEBHOOK_EVENTS),
    ],
    target_url: params.targetUrl,
    ...(params.phoneNumber?.trim()
      ? { phone_numbers: [params.phoneNumber.trim()] }
      : {}),
  };
  if (!params.phoneNumber?.trim())
    throw new Error(
      "A Linq sender phone number is required; account-wide subscriptions are not created",
    );
  return fetchLinqJson<LinqWebhookSubscription>(
    params.token,
    "/webhook-subscriptions",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function deleteLinqWebhookSubscription(params: {
  token: string;
  subscriptionId: string;
}): Promise<void> {
  await fetchLinq(
    params.token,
    `/webhook-subscriptions/${encodeURIComponent(params.subscriptionId)}`,
    { method: "DELETE" },
  );
}
