import { describe, expect, it } from "vitest";
import {
  buildCloudflareTunnelInstructions,
  buildLocalWebhookUrl,
  buildTailscaleFunnelInstructions,
  resolveConfiguredWebhookPath,
  validatePublicWebhookUrl,
  validateWebhookPath,
} from "./onboarding-ingress.js";

describe("Linq onboarding ingress", () => {
  it("requires a dedicated local webhook path", () => {
    expect(validateWebhookPath("/linq-webhook")).toBeUndefined();
    expect(validateWebhookPath("/hooks/linq_1")).toBeUndefined();
    expect(validateWebhookPath("/")).toContain("dedicated path");
    expect(validateWebhookPath("linq-webhook")).toContain("Use a path");
  });

  it("accepts only public HTTPS URLs on the configured path", () => {
    const path = "/linq-webhook";
    expect(
      validatePublicWebhookUrl(
        "https://messages.example.com/linq-webhook",
        path,
      ),
    ).toBeUndefined();
    expect(
      validatePublicWebhookUrl(
        "http://messages.example.com/linq-webhook",
        path,
      ),
    ).toContain("require HTTPS");
    expect(
      validatePublicWebhookUrl("https://localhost/linq-webhook", path),
    ).toContain("public hostname");
    expect(
      validatePublicWebhookUrl("https://localhost./linq-webhook", path),
    ).toContain("public hostname");
    expect(
      validatePublicWebhookUrl("https://192.168.1.2/linq-webhook", path),
    ).toContain("public hostname");
    expect(
      validatePublicWebhookUrl("https://messages.example.com/wrong", path),
    ).toContain(path);
    expect(
      validatePublicWebhookUrl(
        "https://messages.example.com/linq-webhook?token=no",
        path,
      ),
    ).toContain("query parameters");
  });

  it("uses explicit config, then the public URL path, then the safe default", () => {
    expect(
      resolveConfiguredWebhookPath({
        webhookPath: "/configured",
        webhookUrl: "https://messages.example.com/from-url",
      }),
    ).toBe("/configured");
    expect(
      resolveConfiguredWebhookPath({
        webhookUrl: "https://messages.example.com/from-url",
      }),
    ).toBe("/from-url");
    expect(resolveConfiguredWebhookPath({})).toBe("/linq-webhook");
  });

  it("builds path-scoped tunnel and cleanup instructions", () => {
    expect(buildLocalWebhookUrl(19001, "/linq-webhook")).toBe(
      "http://127.0.0.1:19001/linq-webhook",
    );
    expect(
      buildTailscaleFunnelInstructions({
        gatewayPort: 19001,
        webhookPath: "/linq-webhook",
      }),
    ).toContain(
      "tailscale funnel --bg --https=443 --set-path=/linq-webhook http://127.0.0.1:19001/linq-webhook",
    );
    expect(
      buildTailscaleFunnelInstructions({
        gatewayPort: 19001,
        webhookPath: "/linq-webhook",
      }),
    ).toContain("tailscale funnel --https=443 --set-path=/linq-webhook off");

    const cloudflare = buildCloudflareTunnelInstructions({
      gatewayPort: 19001,
      webhookPath: "/linq-webhook",
    });
    expect(cloudflare).toContain("path: ^/linq-webhook$");
    expect(cloudflare).toContain("service: http://127.0.0.1:19001");
    expect(cloudflare).toContain("service: http_status:404");
    expect(cloudflare).toContain("cloudflared tunnel delete <TUNNEL-NAME>");
  });
});
