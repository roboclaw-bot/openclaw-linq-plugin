import { describe, expect, it, vi } from "vitest";

vi.mock("./linq/gateway.js", () => {
  throw new Error("setup discovery must not load the Linq gateway runtime");
});
vi.mock("./linq/send.js", () => {
  throw new Error("setup discovery must not load Linq outbound delivery");
});
vi.mock("./runtime.js", () => {
  throw new Error("setup discovery must not load the full plugin runtime");
});

describe("Linq setup entry import boundary", () => {
  it("loads setup/config surfaces without runtime-only modules", async () => {
    const { default: entry } = await import("../setup-entry.js");

    expect(entry.plugin.id).toBe("linq");
    expect(entry.plugin.setupWizard).toBeDefined();
    expect(entry.plugin.setup).toBeDefined();
    expect(entry.plugin).not.toHaveProperty("gateway");
    expect(entry.plugin).not.toHaveProperty("outbound");
  });
});
