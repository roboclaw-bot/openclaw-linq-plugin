import { isIP } from "node:net";

export const DEFAULT_LINQ_WEBHOOK_PATH = "/linq-webhook";

const webhookPathPattern = /^\/[A-Za-z0-9/_-]*$/u;

export function parseWebhookUrl(value: string | undefined): URL | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

export function validateWebhookPath(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "Required";
  }
  if (!webhookPathPattern.test(trimmed)) {
    return "Use a path like /linq-webhook with letters, numbers, _, -, or /.";
  }
  if (trimmed === "/") {
    return "Use a dedicated path instead of exposing the Gateway root.";
  }
  return undefined;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  const [first, second] = octets;
  if (octets.length !== 4 || first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    /^fe[89a-f]/u.test(normalized)
  );
}

function isClearlyLocalHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  return ipVersion === 4
    ? isPrivateIpv4(normalized)
    : ipVersion === 6
      ? isPrivateIpv6(normalized)
      : false;
}

export function validatePublicWebhookUrl(
  value: string | undefined,
  webhookPath: string,
): string | undefined {
  const url = parseWebhookUrl(value);
  if (!url) {
    return "Enter a valid public HTTPS URL.";
  }
  if (url.protocol !== "https:") {
    return "Linq webhook subscriptions require HTTPS.";
  }
  if (!url.hostname || isClearlyLocalHostname(url.hostname)) {
    return "Use a public hostname or publicly routable IP address.";
  }
  if (
    url.username ||
    url.password ||
    (url.search && url.search !== "?version=2026-02-03") ||
    url.hash
  ) {
    return "Do not include credentials, a fragment, or query parameters other than version=2026-02-03.";
  }
  if (url.pathname !== webhookPath) {
    return `The public URL path must be ${webhookPath}.`;
  }
  return undefined;
}

export function resolveConfiguredWebhookPath(params: {
  webhookPath?: string;
  webhookUrl?: string;
}): string {
  const configuredPath = params.webhookPath?.trim();
  if (configuredPath && !validateWebhookPath(configuredPath)) {
    return configuredPath;
  }
  const urlPath = parseWebhookUrl(params.webhookUrl)?.pathname;
  if (urlPath && !validateWebhookPath(urlPath)) {
    return urlPath;
  }
  return DEFAULT_LINQ_WEBHOOK_PATH;
}

export function buildLocalWebhookUrl(
  gatewayPort: number,
  webhookPath: string,
): string {
  return `http://127.0.0.1:${gatewayPort}${webhookPath}`;
}

export function buildTailscaleFunnelInstructions(params: {
  gatewayPort: number;
  webhookPath: string;
}): string {
  const target = buildLocalWebhookUrl(params.gatewayPort, params.webhookPath);
  return [
    "Run this yourself after the Gateway is listening:",
    `tailscale funnel --bg --https=443 --set-path=${params.webhookPath} ${target}`,
    "Use the HTTPS URL printed by Tailscale with the same path.",
    "Cleanup:",
    `tailscale funnel --https=443 --set-path=${params.webhookPath} off`,
  ].join("\n");
}

export function buildCloudflareTunnelInstructions(params: {
  gatewayPort: number;
  webhookPath: string;
}): string {
  return [
    "Add a path-limited ingress rule to a named Cloudflare Tunnel:",
    "tunnel: <TUNNEL-UUID>",
    "credentials-file: <CREDENTIALS-FILE>",
    "ingress:",
    "  - hostname: <PUBLIC-HOSTNAME>",
    `    path: ^${params.webhookPath}$`,
    `    service: http://127.0.0.1:${params.gatewayPort}`,
    "  - service: http_status:404",
    "Validate and run it yourself:",
    "cloudflared tunnel --config <CONFIG-PATH> ingress validate",
    "cloudflared tunnel --config <CONFIG-PATH> run <TUNNEL-NAME>",
    "Cleanup a dedicated temporary tunnel after stopping it:",
    "cloudflared tunnel delete <TUNNEL-NAME>",
  ].join("\n");
}
