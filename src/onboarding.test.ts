import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { linqOnboardingAdapter } from "./onboarding.js";

const phone = "+15551112222";

function createPrompter(params: {
  ingressMode: "existing" | "tailscale" | "cloudflare" | "outbound-only";
  webhookPath?: string;
  webhookUrl?: string;
  confirm?: (message: string) => boolean;
  tokenInput?: string;
  secretInputMode?: "plaintext" | "ref";
  secretEnvVar?: string;
}) {
  const notes: Array<{ message: string; title?: string }> = [];
  const textMessages: string[] = [];
  const textPrompts: Array<{ message: string; sensitive?: boolean }> = [];
  const prompter = {
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ message, title });
    }),
    confirm: vi.fn(
      async ({ message }: { message: string }) =>
        params.confirm?.(message) ?? true,
    ),
    select: vi.fn(async ({ message }: { message: string }) => {
      if (message === "Linq sender phone number") {
        return phone;
      }
      if (message.startsWith("How do you want to provide")) {
        return params.secretInputMode ?? "plaintext";
      }
      if (message.startsWith("Where is this Linq API token stored?")) {
        return "env";
      }
      return params.ingressMode;
    }),
    text: vi.fn(async (prompt: { message: string; sensitive?: boolean }) => {
      const { message } = prompt;
      textMessages.push(message);
      textPrompts.push(prompt);
      if (message === "Enter Linq API token") {
        return params.tokenInput ?? "test-token";
      }
      if (message === "Environment variable name") {
        return params.secretEnvVar ?? "LINQ_API_TOKEN";
      }
      if (message === "Local webhook path") {
        return params.webhookPath ?? "/linq-webhook";
      }
      if (message === "Public webhook URL") {
        return params.webhookUrl ?? "https://messages.example.com/linq-webhook";
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    }),
  } as unknown as WizardPrompter;
  return { prompter, notes, textMessages, textPrompts };
}

function configuredAccount(
  overrides: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    gateway: { port: 19001 },
    channels: {
      linq: {
        enabled: true,
        apiToken: "test-token",
        fromPhone: phone,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

function stubPhoneProbeAndSubscriptionCreation() {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(
          JSON.stringify({ phone_numbers: [{ phone_number: phone }] }),
          {
            status: 200,
          },
        );
      }
      if (url.endsWith("/webhook-subscriptions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "sub_ready",
            is_active: true,
            subscribed_events: ["message.received"],
            target_url:
              "https://messages.example.com/hooks/linq?version=2026-02-03",
            phone_numbers: [phone],
            signing_secret: "signing-secret",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/webhook-subscriptions")) {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Linq onboarding wizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINQ_TOKEN_REF_TEST;
  });

  it("creates a ready, path-scoped inbound configuration", async () => {
    const fetchMock = stubPhoneProbeAndSubscriptionCreation();
    const beforePersistentEffect = vi.fn(async () => {});
    const { prompter, notes } = createPrompter({
      ingressMode: "cloudflare",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount(),
      prompter,
      runtime: {} as never,
      options: { beforePersistentEffect } as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookPath).toBe("/hooks/linq");
    expect(linq.webhookUrl).toBe(
      "https://messages.example.com/hooks/linq?version=2026-02-03",
    );
    expect(linq.webhookSecret).toBe("signing-secret");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    const createCallIndex = fetchMock.mock.calls.findIndex(
      ([, init]) => init?.method === "POST",
    );
    expect(createCallIndex).toBeGreaterThanOrEqual(0);
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[createCallIndex]!,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          subscribed_events: ["message.received"],
          target_url:
            "https://messages.example.com/hooks/linq?version=2026-02-03",
          phone_numbers: [phone],
        }),
      }),
    );
    expect(
      notes.some((note) => note.message.includes("path: ^/hooks/linq$")),
    ).toBe(true);
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes(
            "Local route: http://127.0.0.1:19001/hooks/linq",
          ) &&
          note.message.includes(
            "Inbound readiness: CONFIGURED (delivery unverified)",
          ),
      ),
    ).toBe(true);
  });

  it("masks plaintext API-token input", async () => {
    stubPhoneProbeAndSubscriptionCreation();
    const { prompter, textPrompts } = createPrompter({
      ingressMode: "existing",
      secretInputMode: "plaintext",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({ apiToken: undefined }),
      prompter,
      runtime: {} as never,
      options: { secretInputMode: "plaintext" },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(
      (result.cfg.channels?.linq as Record<string, unknown>).apiToken,
    ).toBe("test-token");
    expect(textPrompts).toContainEqual(
      expect.objectContaining({
        message: "Enter Linq API token",
        sensitive: true,
      }),
    );
  });

  it("stores an API-token SecretRef while using its resolved value for setup", async () => {
    process.env.LINQ_TOKEN_REF_TEST = "test-token";
    stubPhoneProbeAndSubscriptionCreation();
    const { prompter } = createPrompter({
      ingressMode: "existing",
      secretInputMode: "ref",
      secretEnvVar: "LINQ_TOKEN_REF_TEST",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({ apiToken: undefined }),
      prompter,
      runtime: {} as never,
      options: { secretInputMode: "ref" },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(
      (result.cfg.channels?.linq as Record<string, unknown>).apiToken,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "LINQ_TOKEN_REF_TEST",
    });
  });

  it("retains and resolves an existing SecretRef for setup rather than replacing it", async () => {
    process.env.LINQ_TOKEN_REF_TEST = "test-token";
    const fetcher = stubPhoneProbeAndSubscriptionCreation();
    const ref = {
      source: "env",
      provider: "default",
      id: "LINQ_TOKEN_REF_TEST",
    };
    const { prompter } = createPrompter({
      ingressMode: "existing",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq",
    });
    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({ apiToken: ref }),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    expect(
      (result.cfg.channels?.linq as Record<string, unknown>).apiToken,
    ).toEqual(ref);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
  });

  it("propagates a persistent-effect guard failure before subscription creation", async () => {
    const guardError = new Error("setup authority changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    const fetchMock = stubPhoneProbeAndSubscriptionCreation();
    const { prompter } = createPrompter({
      ingressMode: "existing",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
    });

    await expect(
      linqOnboardingAdapter.configure({
        cfg: configuredAccount(),
        prompter,
        runtime: {} as never,
        options: { beforePersistentEffect } as never,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      }),
    ).rejects.toBe(guardError);
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  it("makes outbound-only explicit without storing a fake webhook URL", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(
          JSON.stringify({ phone_numbers: [{ phone_number: phone }] }),
          {
            status: 200,
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes, textMessages } = createPrompter({
      ingressMode: "outbound-only",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount(),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookPath).toBe("/linq-webhook");
    expect(linq).not.toHaveProperty("webhookUrl");
    expect(linq).not.toHaveProperty("webhookSecret");
    expect(textMessages).not.toContain("Public webhook URL");
    expect(
      notes.some((note) =>
        note.message.includes("Inbound readiness: OUTBOUND ONLY"),
      ),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("guards provider deletion when switching existing inbound setup to outbound-only", async () => {
    const beforePersistentEffect = vi.fn(async () => {});
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/phone_numbers")) {
          return new Response(
            JSON.stringify({ phone_numbers: [{ phone_number: phone }] }),
            {
              status: 200,
            },
          );
        }
        if (
          url.endsWith("/webhook-subscriptions/sub_existing") &&
          init?.method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/webhook-subscriptions")) {
          return new Response(
            JSON.stringify({
              subscriptions: [
                {
                  id: "sub_existing",
                  is_active: true,
                  subscribed_events: ["message.received"],
                  target_url: "https://messages.example.com/linq-webhook",
                  phone_numbers: [phone],
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { prompter } = createPrompter({ ingressMode: "outbound-only" });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({
        webhookUrl: "https://messages.example.com/linq-webhook",
        webhookPath: "/linq-webhook",
        webhookSecret: "existing-secret",
      }),
      prompter,
      runtime: {} as never,
      options: { beforePersistentEffect } as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;
    const deleteCallIndex = fetchMock.mock.calls.findIndex(
      ([, init]) => init?.method === "DELETE",
    );

    expect(linq).not.toHaveProperty("webhookUrl");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(deleteCallIndex).toBeGreaterThanOrEqual(0);
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[deleteCallIndex]!,
    );
  });

  it("stores named-account ingress under that account", async () => {
    stubPhoneProbeAndSubscriptionCreation();
    const { prompter } = createPrompter({
      ingressMode: "existing",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
    });
    const cfg = {
      gateway: { port: 19001 },
      channels: {
        linq: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              apiToken: "test-token",
              fromPhone: phone,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await linqOnboardingAdapter.configure({
      cfg,
      prompter,
      runtime: {} as never,
      accountOverrides: { linq: "work" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, any>;

    expect(linq).not.toHaveProperty("webhookUrl");
    expect(linq.accounts.work).toMatchObject({
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq?version=2026-02-03",
      webhookSecret: "signing-secret",
    });
  });

  it("preserves existing inbound config when outbound-only cleanup is declined", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(
          JSON.stringify({ phone_numbers: [{ phone_number: phone }] }),
          {
            status: 200,
          },
        );
      }
      if (url.endsWith("/webhook-subscriptions")) {
        return new Response(
          JSON.stringify({
            subscriptions: [
              {
                id: "sub_shared",
                is_active: true,
                subscribed_events: ["message.received"],
                target_url: "https://messages.example.com/original",
                phone_numbers: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes } = createPrompter({
      ingressMode: "outbound-only",
      webhookPath: "/changed-but-not-saved",
      confirm: (message) =>
        !message.startsWith("Delete unfiltered Linq webhook subscription"),
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({
        webhookUrl: "https://messages.example.com/original",
        webhookPath: "/original",
        webhookSecret: "existing-secret",
      }),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq).toMatchObject({
      webhookUrl: "https://messages.example.com/original",
      webhookPath: "/original",
      webhookSecret: "existing-secret",
    });
    expect(
      notes.some((note) =>
        note.message.includes("shared subscription uses this URL"),
      ),
    ).toBe(true);
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes(
            "Local route: http://127.0.0.1:19001/original",
          ) &&
          note.message.includes("EXISTING CONFIGURATION PRESERVED"),
      ),
    ).toBe(true);
  });

  it("clears a stale secret when a replacement subscription returns no secret", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/phone_numbers")) {
          return new Response(
            JSON.stringify({ phone_numbers: [{ phone_number: phone }] }),
            {
              status: 200,
            },
          );
        }
        if (
          url.endsWith("/webhook-subscriptions/sub_old") &&
          init?.method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/webhook-subscriptions") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "sub_new",
              is_active: true,
              subscribed_events: ["message.received"],
              target_url:
                "https://new.example.com/linq-webhook?version=2026-02-03",
              phone_numbers: [phone],
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/webhook-subscriptions")) {
          return new Response(
            JSON.stringify({
              subscriptions: [
                {
                  id: "sub_old",
                  is_active: true,
                  subscribed_events: ["message.received"],
                  target_url: "https://old.example.com/linq-webhook",
                  phone_numbers: [phone],
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes } = createPrompter({
      ingressMode: "existing",
      webhookUrl: "https://new.example.com/linq-webhook?version=2026-02-03",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({
        webhookUrl: "https://old.example.com/linq-webhook",
        webhookPath: "/linq-webhook",
        webhookSecret: "old-secret",
      }),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookUrl).toBe(
      "https://new.example.com/linq-webhook?version=2026-02-03",
    );
    expect(linq).not.toHaveProperty("webhookSecret");
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes("Signing secret: missing") &&
          note.message.includes("Inbound readiness: INCOMPLETE"),
      ),
    ).toBe(true);
  });
});
