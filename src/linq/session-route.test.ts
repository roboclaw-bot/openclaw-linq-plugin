import { describe, expect, it } from "vitest";
import { resolveLinqOutboundSessionRoute } from "./session-route.js";

describe("Linq outbound session routing", () => {
  it("maps explicit phone sends to the canonical inbound phone session", () => {
    const route = resolveLinqOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "linq:+1 (555) 123-4567",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:linq:direct:+15551234567",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "+15551234567" },
      from: "linq:+15551234567",
      to: "linq:+15551234567",
    });
  });

  it("keeps explicit chat targets account-scoped", () => {
    const route = resolveLinqOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      accountId: "sales",
      target: "linq:chat:chat_1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:linq:direct:chat_1",
      peer: { kind: "direct", id: "chat_1" },
      from: "linq:sales:chat:chat_1",
      to: "linq:sales:chat:chat_1",
    });
    expect(route).not.toHaveProperty("recipientSessionExact");
  });

  it("rejects unsupported group targets", () => {
    expect(
      resolveLinqOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "linq:group:group_1",
      }),
    ).toBeNull();
  });
});
