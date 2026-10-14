# Linq channel for OpenClaw

An external [OpenClaw](https://github.com/openclaw/openclaw) channel using the [Linq messaging API](https://linqapp.com). Linq hosts the phone infrastructure: no Mac is required on the OpenClaw host. A separate Linq account, paid service, API token and provisioned number are required. This is the `linq` channel, not the local `imessage` channel or an Apple-operated API.

## Requirements and installation

Targets **OpenClaw 2026.10.3 or newer**, verified against the published 2026.10.3 package. Newer hosts must preserve that public plugin API. Use a Node version supported by your host (verification used Node 24).

The package name/version is not a claim of an npm or ClawHub release. Until a maintainer publishes a reviewed release, build and inspect the package from a reviewed checkout in an isolated development environment:

```bash
npm ci --ignore-scripts
npm run check
npm pack
# On the intended host, after reviewing the package:
openclaw plugins install ./openclaw-linq-plugin-1.0.0.tgz
```

The tarball contains compiled JavaScript, a separate setup entry, the channel manifest, README and license. An arbitrary source checkout is not equivalent to this built artifact. Include plugin id `linq` if your host uses a plugin allowlist. Do not enable two copies.

## Guided setup

Run `openclaw configure --section channels` and select **Linq (Messaging API)**. The wizard:

1. Accepts a masked token or host-managed SecretRef and probes available numbers.
2. Selects the sending phone number in E.164 format.
3. Offers existing HTTPS ingress, path-scoped Tailscale/Cloudflare instructions, or explicit outbound-only mode. It does not start tunnels or expose the Gateway UI.
4. After confirmation, creates/reuses a subscription for **only the selected phone number**, subscribes to `message.received`, pins webhook version `2026-02-03`, and saves the signing secret. A forbidden phone-filtered subscription is never silently broadened into account-wide access.

An existing subscription without its secret needs explicit recreation. Shared/multi-number subscriptions are not automatically deleted. Replacement can temporarily interrupt inbound delivery. Switching to outbound-only asks before removing an owned subscription; failed/shared cleanup preserves existing configuration.

Setup success means **configuration prepared**, not internet reachability verified. Start/reload your Gateway normally, then send a message from an intended sender and verify its response, policy and status. Restrict public reverse-proxy access to the webhook path, not the whole Gateway.

## Manual configuration

Example `openclaw.json` (provide the environment variables and configure SecretRef providers through normal OpenClaw secrets configuration):

```json
{
  "channels": {
    "linq": {
      "enabled": true,
      "apiToken": {
        "source": "env",
        "provider": "default",
        "id": "LINQ_API_TOKEN"
      },
      "fromPhone": "+15555550101",
      "dmPolicy": "pairing",
      "webhookPath": "/linq-webhook",
      "webhookUrl": "https://messages.example.com/linq-webhook?version=2026-02-03",
      "webhookSecret": {
        "source": "env",
        "provider": "default",
        "id": "LINQ_WEBHOOK_SECRET"
      }
    }
  }
}
```

Setting `webhookUrl` manually does not create a remote subscription. Create one in Linq for that exact version-pinned URL, only the selected number, and `message.received`; store its signing secret. Inbound startup requires token, `fromPhone` and secret. The route runs on the existing Gateway HTTP server, not a new port. The legacy `webhookHost` field is accepted for migration but unused.

For outbound-only set `inboundEnabled: false`; no webhook route is registered. `fromPhone` remains required for phone-number targets. Use **one** of `apiToken` or `tokenFile`. Literal tokens work, but SecretRefs are preferable. The host resolves env/file/exec SecretRefs; the plugin does not bypass provider policy. Implicit `LINQ_API_TOKEN` fallback is default-account only. An explicitly unreadable or empty token file fails closed.

### Sender policy and upgrades

- `pairing` is the default: unknown direct senders get a host-managed, account-scoped challenge instead of reaching the agent.
- `allowlist` accepts only `allowFrom` entries / approved senders.
- `open` deliberately accepts anyone, even when `allowFrom` is absent.
- `disabled` blocks inbound DMs; `enabled: false` disables the whole account.

**Upgrade notice:** an omitted policy no longer implicitly opens the bot to everyone. Explicit old `open` configurations remain open; review that choice. Groups, messages from the bot and messages addressed to another Linq line never enter the direct-message agent route. Email-only iMessage sender identities are not supported and are ignored; only E.164 phone senders are admitted. Sessions bind to the sender phone; replies use the provider chat id. Host command authorization is carried through the stable ingress result and context builder.

### Multiple accounts

Use `channels.linq.accounts.<id>` and set `defaultAccount` to an existing id. Each inbound account needs a distinct `fromPhone`, `webhookPath`, subscription and signing secret. Duplicate paths fail startup. Base settings are inherited; explicit account credentials override the base credential source. Avoid a base signing secret across different subscriptions. Named accounts do not inherit the implicit environment-token fallback. Pairing, queues and outgoing account selection are scoped.

## Sending and capabilities

Targets: `linq:+15555550102`, `linq:chat:<chat_id>`, `linq:<accountId>:+15555550102`, or `linq:<accountId>:chat:<chat_id>`.

| Feature                                  | Support                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Direct text                              | Incoming/outgoing; iMessage/RCS/SMS selection is Linq’s           |
| Incoming media                           | URLs and MIME types passed to host ingestion                      |
| Outgoing media                           | HTTPS URLs or host-authorized local files                         |
| Local media upload                       | Linq attachment negotiation and guarded upload; 100 MiB local cap |
| Quoted replies                           | Provider message-id references                                    |
| Read/typing                              | Best-effort, authorized iMessage conversations only               |
| Sender policy/routing                    | Stable host ingress and account-scoped pairing                    |
| Webhook persistence/replay/restart       | Host SQLite ingress queue                                         |
| Durable final replies                    | Host message adapter, receipts, fences and idempotency keys       |
| Groups, reactions, edit, unsend          | **Not implemented**; not advertised                               |
| Native voice notes, calls, live location | **Not implemented**; ordinary audio files may be media            |

Provider plan, recipient, file-size, format, throughput and outbound engagement limits still apply. Local files must pass host media-root/read policy. Uploads use the host SSRF guard; no Linq bearer token goes to the upload host. Remote media must be reachable by Linq. Temporary inbound attachment URLs can expire (roughly 24–48 hours per Linq documentation): a long outage may preserve an envelope but not attachment bytes.

## Delivery and security

Only Standard Webhooks `webhook-id`, `webhook-timestamp` and `webhook-signature` authentication is accepted. Signatures cover original bytes with five-minute timestamp tolerance. Bodies are capped at 1 MiB with a five-second read deadline. No unsigned/legacy-header fallback.

For valid messages, HTTP 200 is withheld until the full envelope is durably admitted. Storage failure returns a retryable error. Event ids deduplicate in-flight/completed events within host standard retention; per-chat lanes preserve queued ordering and pending work resumes after restart. Unsupported event types and authenticated groups are safely ignored. This is at-least-once processing with deduplication, **not end-to-end exactly-once** across provider/network/model failures.

Outgoing sends use provider idempotency keys and real receipts. Only explicit 429 responses get bounded immediate retries respecting Retry-After. Ambiguous failures are surfaced, not blindly retried or given invented ids. Presence failure does not fail a valid message.

Linq operates the messaging endpoint and can process content. iMessage transport encryption does not hide content from that provider; SMS has different security properties. Durable ingress stores envelopes under OpenClaw state: apply normal host storage/retention safeguards.

## Development and verification

`npm run check` typechecks, runs unit/HTTP fixtures, builds, and exercises the released host loader, registered runtime, SQLite queue and sender policies in independent processes. `test/integration.mjs` deliberately exits after durable ACK and verifies recovery/replay in a new process. It uses private temporary state and fixture credentials, not your Gateway.

Set `LINQ_PACKAGE_ROOT` to an installed/extracted tarball’s absolute root for `npm run test:integration` to test the artifact instead of this build directory. The harness locates version-specific host loader internals only for verification; production imports use public SDK subpaths.

Tests do not establish real Linq permissions, provisioning, public webhook reachability, Apple availability, carrier delivery or live media-format support. A maintainer must run an account-backed smoke test before claiming production operation.

## License

MIT. Builds on the original plugin and Dallin Romney’s setup/SDK migration work.
