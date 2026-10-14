import {
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import type { LinqAccountConfig } from "./linq/types.js";
import type { ResolvedLinqAccount } from "./linq/accounts.js";
import type { LinqProbe } from "./linq/types.js";
import { resolveLinqAccount } from "./linq/accounts.js";
import { probeLinq } from "./linq/probe.js";
import { sendMessageLinq } from "./linq/send.js";
import { formatLinqTarget, parseLinqTarget } from "./linq/targets.js";
import { monitorLinqProvider } from "./linq/gateway.js";
import {
  linqMessageAdapter,
  toLinqOutboundDeliveryResult,
} from "./linq/message.js";
import { resolveLinqOutboundSessionRoute } from "./linq/session-route.js";
import { getLinqRuntime } from "./runtime.js";
import { createLinqPluginBase } from "./channel-base.js";

export const linqPlugin: ChannelPlugin<ResolvedLinqAccount, LinqProbe> = {
  ...createLinqPluginBase(),
  pairing: {
    idLabel: "phoneNumber",
    notifyApproval: async ({ id, accountId, cfg }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      await sendMessageLinq(
        `linq:${id}`,
        "Pairing approved. You can now message this agent.",
        {
          account,
          accountId: account.accountId,
        },
      );
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      if (!raw) {
        return "";
      }
      try {
        return formatLinqTarget(parseLinqTarget(raw));
      } catch {
        return raw;
      }
    },
    resolveOutboundSessionRoute: (params) =>
      resolveLinqOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: (id) => {
        try {
          return parseLinqTarget(id ?? "").kind !== "group";
        } catch {
          return false;
        }
      },
      hint: "linq:+15556667777 | linq:chat:<chat_id> | linq:<accountId>:+15556667777",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) =>
      getLinqRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const result = await sendMessageLinq(to, text, {
        accountId: accountId ?? undefined,
        config: cfg,
        replyToMessageId: replyToId ?? undefined,
      });
      return toLinqOutboundDeliveryResult(result, "text");
    },
    sendMedia: async ({
      to,
      text,
      mediaUrl,
      accountId,
      cfg,
      replyToId,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    }) => {
      const result = await sendMessageLinq(to, text, {
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        accountId: accountId ?? undefined,
        config: cfg,
        replyToMessageId: replyToId ?? undefined,
      });
      return toLinqOutboundDeliveryResult(result, "media");
    },
  },
  message: linqMessageAdapter,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError =
          typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "linq",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      webhookSecretSource:
        ((snapshot as Record<string, unknown>).webhookSecretSource as
          | string
          | undefined) ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeLinq(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.token?.trim() || account.tokenSource === "secretRef",
      ),
      tokenSource: account.tokenSource,
      webhookSecretSource: account.webhookSecretSource,
      fromPhone: account.fromPhone,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let phoneLabel = "";
      try {
        const probe = await probeLinq(token, 2500);
        if (probe.ok && probe.phoneNumbers?.length) {
          phoneLabel = ` (${probe.phoneNumbers.join(", ")})`;
        }
      } catch {
        // Probe failure is non-fatal for startup.
      }
      ctx.log?.info(
        `[${account.accountId}] starting Linq provider${phoneLabel}`,
      );
      return monitorLinqProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.log,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ accountId }) => {
      const rt = getLinqRuntime();
      let cleared = false;
      await rt.config.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate: (draft) => {
          const section = draft.channels?.linq as LinqAccountConfig | undefined;
          const target =
            section?.accounts?.[accountId] ??
            (accountId === DEFAULT_ACCOUNT_ID ? section : undefined);
          if (!target) return;
          for (const key of [
            "apiToken",
            "tokenFile",
            "webhookSecret",
          ] as const) {
            if (key in target) {
              delete target[key];
              cleared = true;
            }
          }
          // Revocation is account-scoped: inherited/env credentials must not reactivate it.
          target.enabled = false;
        },
      });
      return { cleared, loggedOut: true };
    },
  },
};
