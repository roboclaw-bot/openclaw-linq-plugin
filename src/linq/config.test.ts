import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LinqChannelConfigSchema, LinqConfigSchema } from "./config.js";
import { resolveLinqAccount, resolveLinqAccountForStatus } from "./accounts.js";

describe("LinqConfigSchema", () => {
  it("accepts supported SecretRef-backed credentials and applies pairing dmPolicy by default", () => {
    const parsed = LinqConfigSchema.safeParse({
      apiToken: { source: "env", id: "LINQ_API_TOKEN" },
      webhookSecret: {
        source: "exec",
        provider: "vault",
        id: "linq/webhook-secret",
      },
      fromPhone: "+15556667777",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.dmPolicy).toBe("pairing");
  });

  it("rejects unsupported SecretRef sources and extra config knobs", () => {
    expect(
      LinqConfigSchema.safeParse({
        apiToken: { source: "literal", id: "op read token" },
      }).success,
    ).toBe(false);
    const invalid = LinqConfigSchema.safeParse({
      apiToken: "token",
      webhookMaxBytes: 2048,
    });
    expect(invalid.success).toBe(false);
  });

  it("rejects non-HTTPS webhook targets and the Gateway root path", () => {
    expect(
      LinqConfigSchema.safeParse({
        webhookUrl: "http://localhost:3100/linq-webhook",
      }).success,
    ).toBe(false);
    expect(LinqConfigSchema.safeParse({ webhookPath: "/" }).success).toBe(
      false,
    );
    expect(
      LinqConfigSchema.safeParse({
        webhookUrl: "https://messages.example.com/linq-webhook",
        webhookPath: "/linq-webhook",
      }).success,
    ).toBe(true);
  });

  it("exposes matching public JSON-schema and runtime validation", () => {
    expect(LinqChannelConfigSchema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        accounts: {
          additionalProperties: { $ref: "#" },
        },
      },
    });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        apiToken: "token",
        fromPhone: "+15556667777",
      }),
    ).toMatchObject({ success: true, data: { dmPolicy: "pairing" } });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        apiToken: "token",
        webhookMaxBytes: 2048,
      }),
    ).toMatchObject({ success: false });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        accounts: { sales: { apiToken: "token", webhookMaxBytes: 2048 } },
      }),
    ).toMatchObject({ success: false });
  });

  it("keeps manifest channel schemas strict for nested accounts", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    ) as {
      configSchema: {
        properties: {
          accounts: unknown;
          webhookPath: unknown;
          webhookUrl: unknown;
        };
      };
      channelConfigs: {
        linq: {
          schema: {
            properties: {
              accounts: unknown;
              webhookPath: unknown;
              webhookUrl: unknown;
            };
          };
        };
      };
    };

    const expectedAccounts = {
      type: "object",
      additionalProperties: { $ref: "#" },
    };
    const expectedWebhookUrl = {
      type: "string",
      format: "uri",
      pattern: "^https://",
    };
    const expectedWebhookPath = {
      type: "string",
      pattern: "^/[A-Za-z0-9/_-]+$",
      default: "/linq-webhook",
    };
    for (const schema of [manifest.channelConfigs.linq.schema]) {
      expect(schema.properties.accounts).toEqual(expectedAccounts);
      expect(schema.properties.webhookUrl).toEqual(expectedWebhookUrl);
      expect(schema.properties.webhookPath).toEqual(expectedWebhookPath);
    }
  });
});

describe("resolveLinqAccount", () => {
  afterEach(() => {
    delete process.env.LINQ_TOKEN_TEST;
    delete process.env.LINQ_WEBHOOK_SECRET_TEST;
  });

  it("requires host-prepared SecretRefs even when similarly named environment variables exist", () => {
    process.env.LINQ_TOKEN_TEST = "not-authority-to-resolve";
    expect(() =>
      resolveLinqAccount({
        cfg: {
          channels: {
            linq: {
              apiToken: {
                source: "env",
                provider: "restricted",
                id: "LINQ_TOKEN_TEST",
              },
            },
          },
        } as never,
      }),
    ).toThrow(/unresolved SecretRef/);
    expect(
      resolveLinqAccount({
        cfg: { channels: { linq: { apiToken: "host-projected-token" } } },
      }),
    ).toMatchObject({ token: "host-projected-token", tokenSource: "config" });
  });

  it("throws on unresolved exec SecretRefs instead of treating them as missing", () => {
    expect(() =>
      resolveLinqAccount({
        cfg: {
          channels: {
            linq: {
              apiToken: { source: "exec", provider: "vault", id: "linq/token" },
            },
          },
        } as never,
      }),
    ).toThrow(
      'channels.linq.apiToken: unresolved SecretRef "exec:vault:linq/token"',
    );
  });

  it("keeps status resolution readable when SecretRefs are unresolved", () => {
    const account = resolveLinqAccountForStatus({
      cfg: {
        channels: {
          linq: {
            apiToken: { source: "env", id: "LINQ_TOKEN_TEST" },
            webhookSecret: { source: "env", id: "LINQ_WEBHOOK_SECRET_TEST" },
            fromPhone: "+15556667777",
          },
        },
      } as never,
    });

    expect(account).toMatchObject({
      token: "",
      tokenSource: "secretRef",
      webhookSecret: "",
      webhookSecretSource: "secretRef",
      fromPhone: "+15556667777",
    });
  });
});
