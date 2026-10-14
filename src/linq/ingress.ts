import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import type { ResolvedLinqAccount } from "./accounts.js";
import { sendMessageLinq } from "./send.js";

const CHANNEL_ID = "linq";

export type LinqChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "pairing" | "reply" | "routing" | "session" | "text"
>;

type LinqLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export function normalizeLinqSender(value: string): string {
  const trimmed = value.trim();
  const phone = trimmed.replace(/[\s().-]/gu, "");
  // iMessage email punctuation is significant; never alias it to another identity.
  return /^\+[1-9]\d{6,14}$/u.test(phone) ? phone : trimmed.toLowerCase();
}

export async function authorizeLinqSender(params: {
  cfg: OpenClawConfig;
  account: ResolvedLinqAccount;
  channelRuntime: LinqChannelRuntime;
  sender: string;
  text?: string;
  contextBinding?: ChannelIngressContextBinding;
}) {
  const dmPolicy = params.account.config.dmPolicy ?? "pairing";
  const configuredAllowFrom = params.account.config.allowFrom ?? [];
  // Linq historically treated dmPolicy=open as unconditional access.
  const allowFrom =
    dmPolicy === "open" ? [...configuredAllowFrom, "*"] : configuredAllowFrom;
  return await params.channelRuntime.inbound.ingress.resolveStable({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    cfg: params.cfg,
    identity: {
      key: "phone",
      entryIdPrefix: "linq-entry",
      normalize: normalizeLinqSender,
    },
    readStoreAllowFrom: async () =>
      await params.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: params.sender },
    conversation: { kind: "direct", id: params.sender },
    event: { mayPair: true },
    dmPolicy,
    contextBinding: params.contextBinding,
    command: {
      requested: true,
      hasControlCommand: params.channelRuntime.text.hasControlCommand(
        params.text ?? "",
        params.cfg,
      ),
    },
    allowFrom,
  });
}

export async function issueLinqPairingChallenge(params: {
  account: ResolvedLinqAccount;
  channelRuntime: LinqChannelRuntime;
  sender: string;
  chatId: string;
  log?: LinqLog;
}): Promise<void> {
  // OpenClaw 2026.7.1+ forwards accountId to pairing hooks; older hosts ignore it.
  const pairingIssuerOptions: Parameters<
    typeof createChannelPairingChallengeIssuer
  >[0] & {
    accountId: string;
  } = {
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    upsertPairingRequest: async (input) =>
      await params.channelRuntime.pairing.upsertPairingRequest({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
        ...input,
      }),
  };
  const issueChallenge =
    createChannelPairingChallengeIssuer(pairingIssuerOptions);

  await issueChallenge({
    senderId: params.sender,
    senderIdLine: `Your phone number: ${params.sender}`,
    meta: { sender: params.sender, chatId: params.chatId },
    sendPairingReply: async (text) => {
      await sendMessageLinq(`linq:chat:${params.chatId}`, text, {
        account: params.account,
      });
    },
    onCreated: () => {
      params.log?.info?.(`linq pairing request created for ${params.sender}`);
    },
    onReplyError: (err) => {
      params.log?.warn?.(
        `linq pairing reply failed for ${params.sender}: ${String(err)}`,
      );
    },
  });
}
