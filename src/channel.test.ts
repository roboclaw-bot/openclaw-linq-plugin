import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import linqSetupEntry from "../setup-entry.js";
import { linqPlugin } from "./channel.js";
import { linqSetupPlugin } from "./channel.setup.js";
import { setLinqRuntime } from "./runtime.js";
import { resolveLinqAccount } from "./linq/accounts.js";

describe("Linq channel discovery", () => {
  it("logs out nested default without disabling or clearing other accounts", async () => {
    const cfg = {
      channels: {
        linq: {
          enabled: true,
          apiToken: "inherited-fixture",
          accounts: {
            default: {
              enabled: true,
              apiToken: "default-fixture",
              webhookSecret: "default-webhook",
            },
            other: { enabled: true, apiToken: "other-fixture" },
          },
        },
      },
    };
    setLinqRuntime({
      config: {
        mutateConfigFile: async ({
          mutate,
        }: {
          mutate: (draft: unknown) => void;
        }) => mutate(cfg),
      },
    } as never);
    await linqPlugin.gateway!.logoutAccount!({ accountId: "default" } as never);
    expect(cfg.channels.linq.enabled).toBe(true);
    expect(cfg.channels.linq.accounts.default).toEqual({ enabled: false });
    expect(resolveLinqAccount({ cfg, accountId: "default" }).enabled).toBe(
      false,
    );
    expect(resolveLinqAccount({ cfg, accountId: "other" })).toMatchObject({
      enabled: true,
      token: "other-fixture",
    });
  });

  it("exposes a runtime-free channel plugin to setup-only discovery", () => {
    expect(linqSetupEntry.plugin).toBe(linqSetupPlugin);
    expect(linqSetupEntry.plugin).not.toBe(linqPlugin);
    expect(linqSetupPlugin.setupWizard).toBe(linqPlugin.setupWizard);
    expect(linqSetupPlugin.setup).toBeDefined();
    expect(linqSetupPlugin.configSchema).toBe(linqPlugin.configSchema);
    expect(linqSetupPlugin).not.toHaveProperty("gateway");
    expect(linqSetupPlugin).not.toHaveProperty("outbound");
    expect(linqSetupPlugin).not.toHaveProperty("message");
  });

  it("declares the setup entry and channel catalog metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      openclaw?: {
        setupEntry?: string;
        channel?: { id?: string; selectionLabel?: string };
      };
    };

    expect(packageJson.openclaw?.setupEntry).toBe("./dist/setup-entry.js");
    expect(packageJson.openclaw?.channel).toMatchObject({
      id: "linq",
      selectionLabel: "Linq (Messaging API)",
    });
  });
});
