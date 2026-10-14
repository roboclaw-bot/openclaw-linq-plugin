import { describe, expect, it } from "vitest";
import { formatLinqTarget, parseLinqTarget } from "./targets.js";

describe("parseLinqTarget", () => {
  it("parses phone, chat, group, and account-scoped targets", () => {
    expect(parseLinqTarget("linq:+15556667777")).toMatchObject({
      kind: "phone",
      phone: "+15556667777",
    });
    expect(parseLinqTarget("linq:chat:abc123")).toMatchObject({
      kind: "chat",
      chatId: "abc123",
    });
    expect(parseLinqTarget("linq:group:g123")).toMatchObject({
      kind: "group",
      chatId: "g123",
    });
    expect(parseLinqTarget("linq:sales:+15556667777")).toMatchObject({
      kind: "phone",
      accountId: "sales",
      phone: "+15556667777",
    });
  });

  it("formats normalized targets", () => {
    expect(
      formatLinqTarget(parseLinqTarget("linq:sales:+1 (555) 666-7777")),
    ).toBe("linq:sales:+15556667777");
  });

  it("rejects invalid targets", () => {
    expect(() => parseLinqTarget("not a target")).toThrow(
      /Invalid Linq target/u,
    );
  });
});
