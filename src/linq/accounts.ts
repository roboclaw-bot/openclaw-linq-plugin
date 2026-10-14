import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { LinqAccountConfig } from "./types.js";

export type ResolvedLinqAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "config" | "env" | "file" | "secretRef" | "none";
  webhookSecret: string;
  webhookSecretSource: "config" | "file" | "env" | "secretRef" | "none";
  fromPhone?: string;
  config: LinqAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)
    ?.linq as LinqAccountConfig | undefined;
  if (!accounts?.accounts || typeof accounts.accounts !== "object") {
    return [];
  }
  return Object.keys(accounts.accounts).filter(Boolean);
}

export function listLinqAccountIds(cfg: OpenClawConfig): string[] {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)
    ?.linq as LinqAccountConfig | undefined;
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultLinqAccountId(cfg: OpenClawConfig): string {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)
    ?.linq as LinqAccountConfig | undefined;
  const configured = linqSection?.defaultAccount?.trim();
  if (configured) {
    const id = normalizeAccountId(configured);
    if (!listLinqAccountIds(cfg).includes(id))
      throw new Error("Linq defaultAccount must name a configured account");
    return id;
  }
  const ids = listLinqAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LinqAccountConfig | undefined {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)
    ?.linq as LinqAccountConfig | undefined;
  if (!linqSection?.accounts || typeof linqSection.accounts !== "object") {
    return undefined;
  }
  return linqSection.accounts[accountId];
}

function mergeLinqAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LinqAccountConfig {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)
    ?.linq as (LinqAccountConfig & { accounts?: unknown }) | undefined;
  const { accounts: _ignored, ...base } = linqSection ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  // Explicit account credentials select a source, not a blend with the base account.
  if (account.apiToken !== undefined || account.tokenFile !== undefined) {
    delete base.apiToken;
    delete base.tokenFile;
  }
  return { ...base, ...account };
}

function resolveToken(
  merged: LinqAccountConfig,
  accountId: string,
):
  | { token: string; source: "config" | "env" | "file" | "secretRef" }
  | { token: ""; source: "none" } {
  const apiTokenPath =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.linq.apiToken"
      : `channels.linq.accounts.${accountId}.apiToken`;
  const resolvedInput = normalizeResolvedSecretInputString({
    value: merged.apiToken,
    path: apiTokenPath,
  });
  if (resolvedInput?.trim()) {
    return { token: resolvedInput.trim(), source: "config" };
  }
  if (merged.tokenFile?.trim()) {
    try {
      const content = readFileSync(merged.tokenFile.trim(), "utf8").trim();
      if (content) {
        return { token: content, source: "file" };
      }
    } catch {
      throw new Error("Linq tokenFile could not be read");
    }
    throw new Error("Linq tokenFile is empty");
  }
  const envToken =
    accountId === DEFAULT_ACCOUNT_ID
      ? process.env.LINQ_API_TOKEN?.trim()
      : undefined;
  return envToken
    ? { token: envToken, source: "env" }
    : { token: "", source: "none" };
}

function resolveWebhookSecret(
  accountId: string,
  merged: LinqAccountConfig,
):
  | { secret: string; source: "config" | "env" | "file" | "secretRef" }
  | { secret: ""; source: "none" } {
  if (merged.inboundEnabled === false) return { secret: "", source: "none" };
  const webhookSecretPath =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.linq.webhookSecret"
      : `channels.linq.accounts.${accountId}.webhookSecret`;
  const resolvedInput = normalizeResolvedSecretInputString({
    value: merged.webhookSecret,
    path: webhookSecretPath,
  });
  if (resolvedInput?.trim()) {
    return { secret: resolvedInput.trim(), source: "config" };
  }
  return { secret: "", source: "none" };
}

export function resolveLinqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedLinqAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultLinqAccountId(params.cfg),
  );
  const linqSection = (
    params.cfg.channels as Record<string, unknown> | undefined
  )?.linq as LinqAccountConfig | undefined;
  const baseEnabled = linqSection?.enabled !== false;
  const merged = mergeLinqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const { token, source } = resolveToken(merged, accountId);
  const webhookSecret = resolveWebhookSecret(accountId, merged);
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token,
    tokenSource: source,
    webhookSecret: webhookSecret.secret,
    webhookSecretSource: webhookSecret.source,
    fromPhone: merged.fromPhone?.trim() || undefined,
    config: merged,
  };
}

function isUnresolvedSecretRefError(err: unknown): boolean {
  return err instanceof Error && /SecretRef/.test(err.message);
}

function resolveTokenForStatus(
  merged: LinqAccountConfig,
  accountId: string,
): ReturnType<typeof resolveToken> {
  try {
    return resolveToken(merged, accountId);
  } catch (err) {
    if (isUnresolvedSecretRefError(err)) {
      return { token: "", source: "secretRef" };
    }
    throw err;
  }
}

function resolveWebhookSecretForStatus(
  accountId: string,
  merged: LinqAccountConfig,
): ReturnType<typeof resolveWebhookSecret> {
  try {
    return resolveWebhookSecret(accountId, merged);
  } catch (err) {
    if (isUnresolvedSecretRefError(err)) {
      return { secret: "", source: "secretRef" };
    }
    throw err;
  }
}

export function resolveLinqAccountForStatus(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedLinqAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultLinqAccountId(params.cfg),
  );
  const linqSection = (
    params.cfg.channels as Record<string, unknown> | undefined
  )?.linq as LinqAccountConfig | undefined;
  const baseEnabled = linqSection?.enabled !== false;
  const merged = mergeLinqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const { token, source } = resolveTokenForStatus(merged, accountId);
  const webhookSecret = resolveWebhookSecretForStatus(accountId, merged);
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token,
    tokenSource: source,
    webhookSecret: webhookSecret.secret,
    webhookSecretSource: webhookSecret.source,
    fromPhone: merged.fromPhone?.trim() || undefined,
    config: merged,
  };
}
