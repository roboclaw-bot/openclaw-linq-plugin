import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { formatLinqTarget, parseLinqTarget } from "./targets.js";

export function resolveLinqOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
) {
  try {
    const parsed = parseLinqTarget(
      params.resolvedTarget?.to ?? params.target,
      params.accountId ?? undefined,
    );
    if (parsed.kind === "group") {
      return null;
    }
    const target = formatLinqTarget(parsed);
    const peerId = parsed.kind === "phone" ? parsed.phone : parsed.chatId;
    const route = buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "linq",
      accountId: parsed.accountId ?? params.accountId,
      peer: { kind: "direct", id: peerId },
      chatType: "direct",
      from: target,
      to: target,
    });
    // OpenClaw 2026.7.1+ consumes this hint; older compatible hosts ignore it.
    return parsed.kind === "phone"
      ? { ...route, recipientSessionExact: true as const }
      : route;
  } catch {
    return null;
  }
}
