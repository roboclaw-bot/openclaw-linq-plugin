import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchLinqInboundEvent,
  normalizeLinqMessageReceivedData,
} from "./inbound.js";
import { resolveLinqAccount } from "./accounts.js";
const send = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./send.js", () => ({
  sendMessageLinq: send,
  markAsReadLinq: send,
  startTypingLinq: send,
  stopTypingLinq: send,
}));
const data = {
  chat: { id: "c1", is_group: false, owner_handle: { handle: "+15555550101" } },
  id: "m1",
  sender_handle: { handle: "+15555550102" },
  direction: "inbound",
  parts: [{ type: "text", value: "hi" }],
  service: "SMS",
};
const cfg = {
  channels: {
    linq: {
      apiToken: "fixture",
      fromPhone: "+15555550101",
      dmPolicy: "allowlist",
      allowFrom: ["+15555550102"],
    },
  },
};
function fixture(allowed = true) {
  const authorization = {
    senderAccess: { allowed, decision: allowed ? "allow" : "deny" },
  };
  const context = { SessionKey: "agent:main:linq:direct:+15555550102" };
  const rt = {
    text: { hasControlCommand: vi.fn(() => false) },
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "main",
        sessionKey: context.SessionKey,
      })),
    },
    inbound: {
      ingress: { resolveStable: vi.fn(async () => authorization) },
      buildContext: vi.fn(() => context),
      dispatch: vi.fn(async () => {}),
    },
  };
  return { rt, authorization, context };
}
beforeEach(() => vi.clearAllMocks());
describe("inbound binding", () => {
  it("normalizes current envelopes and marks unknown group status unsafe", () => {
    expect(normalizeLinqMessageReceivedData(data)).toMatchObject({
      is_group: false,
      chat_id: "c1",
      recipient_phone: "+15555550101",
      from: "+15555550102",
    });
    expect(
      normalizeLinqMessageReceivedData({
        ...data,
        chat: { ...data.chat, is_group: undefined },
      })?.is_group,
    ).toBe(true);
    for (const value of [null, {}, [], { parts: null }])
      expect(normalizeLinqMessageReceivedData(value)).toBeNull();
  });
  it("binds host authorization to the exact routed context and durable destination", async () => {
    const { rt, authorization, context } = fixture();
    await dispatchLinqInboundEvent({
      cfg,
      account: resolveLinqAccount({ cfg }),
      message: normalizeLinqMessageReceivedData(data)!,
      channelRuntime: rt as never,
    });
    expect(rt.inbound.ingress.resolveStable).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        dmPolicy: "allowlist",
        contextBinding: {
          agentId: "main",
          sessionKey: context.SessionKey,
          messageId: "m1",
          inboundEventKind: "user_request",
        },
      }),
    );
    expect(rt.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channelIngress: authorization,
        reply: expect.objectContaining({ to: "linq:chat:c1" }),
      }),
    );
    expect(rt.inbound.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxPayload: context,
        delivery: expect.objectContaining({ durable: { to: "linq:chat:c1" } }),
      }),
    );
  });
  it("rejects email-only handles before authorization even for an open account", async () => {
    const { rt } = fixture(true);
    await dispatchLinqInboundEvent({
      cfg,
      account: resolveLinqAccount({ cfg }),
      message: {
        ...normalizeLinqMessageReceivedData(data)!,
        from: "first.last@outlook.com",
      },
      channelRuntime: rt as never,
    });
    expect(rt.inbound.ingress.resolveStable).not.toHaveBeenCalled();
    expect(rt.inbound.dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("drops wrong lines, groups, own messages and denied senders before presence or dispatch", async () => {
    for (const patch of [
      { is_group: true },
      { from: "first.last@outlook.com" },
      { from: "firstlast@outlook.com" },
      { is_from_me: true },
      { recipient_phone: "+15555550999" },
      {},
    ]) {
      const { rt } = fixture(false);
      await dispatchLinqInboundEvent({
        cfg,
        account: resolveLinqAccount({ cfg }),
        message: { ...normalizeLinqMessageReceivedData(data)!, ...patch },
        channelRuntime: rt as never,
      });
      expect(rt.inbound.dispatch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });
});
