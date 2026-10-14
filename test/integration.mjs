// Runs only in a disposable environment. Uses the actual released host loader/SQLite queue.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
const root = fileURLToPath(new URL("../", import.meta.url));
const stage = process.argv[2];
if (!stage) {
  const home = await mkdtemp(path.join(tmpdir(), "linq-proof-"));
  for (const phase of ["package", "setup", "admit", "recover", "policy"]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), phase],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          LINQ_PROOF_HOME: home,
        },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.status, 0, phase + " failed");
  }
  console.log(
    "PASS real host loader, durable ACK/crash/replay, sender policies and provenance",
  );
} else {
  const dist = path.join(root, "node_modules/openclaw/dist");
  const loaderName = (await readdir(dist)).find(
    (name) => name.startsWith("loader-runtime-load-") && name.endsWith(".mjs"),
  );
  assert(loaderName, "pinned host loader must be present");
  const loader = Object.values(
    await import(pathToFileURL(path.join(dist, loaderName))),
  ).find(
    (value) =>
      typeof value === "function" && value.name === "loadOpenClawPlugins",
  );
  assert(loader);
  const home = process.env.LINQ_PROOF_HOME;
  const pluginRoot = process.env.LINQ_PACKAGE_ROOT ?? root;
  const fixture = path.join(home, "fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "linq-host-fixture",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await writeFile(
    path.join(fixture, "openclaw.plugin.json"),
    await readFile(path.join(root, "openclaw.plugin.json")),
  );
  await writeFile(
    path.join(fixture, "index.js"),
    "export default {id:'linq',register(api){globalThis[Symbol.for('linq.proof.runtime')]=api.runtime}};",
  );
  const cfg = {
    plugins: {
      allow: ["linq"],
      entries: { linq: { enabled: true } },
      load: {
        paths: [["package", "setup"].includes(stage) ? pluginRoot : fixture],
      },
    },
    channels: {
      linq: {
        apiToken: "fixture-not-a-credential",
        fromPhone: "+15555550101",
        dmPolicy: "allowlist",
        allowFrom: ["+15555550102"],
        inboundEnabled: false,
      },
    },
  };
  if (stage === "setup") cfg.channels = {};
  const registry = loader({
    config: cfg,
    ...(stage === "setup"
      ? {
          channelPluginLoadIntent: "setup",
          includeSetupOnlyChannelPlugins: true,
          forceSetupOnlyChannelPlugins: true,
        }
      : {}),
    onlyPluginIds: ["linq"],
    cache: false,
  });
  assert.equal(
    registry.plugins.find((p) => p.id === "linq")?.status,
    "loaded",
    JSON.stringify(registry.diagnostics),
  );
  if (stage === "setup") {
    assert.equal(registry.channelSetups[0].plugin.id, "linq");
    assert.equal(registry.channels.length, 0);
    console.log("PASS cold setup without credentials or runtime registration");
  } else if (stage === "package") {
    assert.equal(registry.channels[0].plugin.id, "linq");
    assert.equal(registry.channels[0].plugin.capabilities.reactions, false);
    assert.equal(
      JSON.stringify(registry.channels[0].plugin.capabilities.chatTypes),
      '["direct"]',
    );
    console.log(
      "PASS built package loaded from neutral cwd: " +
        registry.plugins[0].source,
    );
  } else {
    const rt = globalThis[Symbol.for("linq.proof.runtime")];
    assert(rt);
    const { createLinqIngress, createLinqHttpHandler } = await import(
      pathToFileURL(path.join(root, "dist/src/linq/gateway.js"))
    );
    const event = {
      webhook_version: "2026-02-03",
      event_id: "durable-e1",
      event_type: "message.received",
      data: {
        chat: {
          id: "chat1",
          is_group: false,
          owner_handle: { handle: "+15555550101" },
        },
        sender_handle: { handle: "+15555550102" },
        id: "m1",
        parts: [{ type: "text", value: "fixture message" }],
        service: "SMS",
        direction: "inbound",
      },
    };
    if (stage === "admit" || stage === "recover") {
      const queue = rt.state.openChannelIngressQueue({ accountId: "default" });
      let deliveries = 0;
      const monitor = createLinqIngress({
        queue,
        deliver: async (received) => {
          assert.deepEqual(received, event);
          if (stage === "admit") await new Promise(() => {}); // Process killed after durable ACK, before completion.
          deliveries++;
        },
        onError: (error) => console.error(error),
      });
      monitor.ensureQueueAvailable();
      monitor.start();
      if (stage === "admit") {
        const key = Buffer.alloc(32, 4);
        const body = JSON.stringify(event);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const handler = createLinqHttpHandler({
          path: "/linq",
          secret: "whsec_" + key.toString("base64"),
          admit: (value) => monitor.admit(value),
        });
        const server = createServer(handler);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = "http://127.0.0.1:" + server.address().port + "/linq";
        const signature = createHmac("sha256", key)
          .update("delivery1." + timestamp + "." + body)
          .digest("base64");
        for (let i = 0; i < 2; i++) {
          const response = await fetch(url, {
            method: "POST",
            body,
            headers: {
              "webhook-id": "delivery1",
              "webhook-timestamp": timestamp,
              "webhook-signature": "v1," + signature,
            },
          });
          assert.equal(response.status, 200);
          await response.text();
        }
        assert.equal(
          (await queue.listPending()).length +
            (await queue.listClaims()).length,
          1,
          "ACK must refer to one durable event",
        );
        console.log(
          "PASS signed HTTP ACK only after durable append; duplicate coalesced",
        );
        process.exit(0); // Deliberate crash: no queue/monitor cleanup.
      } else {
        for (let i = 0; i < 100 && deliveries === 0; i++)
          await new Promise((resolve) => setTimeout(resolve, 100));
        await monitor.waitForIdle();
        assert.equal(deliveries, 1, "pending event survived process exit");
        const replay = await monitor.admit(event);
        assert.equal(replay.queueResult.duplicate, true);
        await monitor.waitForIdle();
        assert.equal(deliveries, 1, "completed replay did not dispatch");
        await monitor.stop();
        assert.equal(
          (await queue.listPending()).length +
            (await queue.listClaims()).length,
          0,
        );
        console.log(
          "PASS SQLite restart recovery and completed replay suppression",
        );
      }
    } else {
      const { authorizeLinqSender } = await import(
        pathToFileURL(path.join(root, "dist/src/linq/ingress.js"))
      );
      const { resolveLinqAccount } = await import(
        pathToFileURL(path.join(root, "dist/src/linq/accounts.js"))
      );
      for (const [policy, sender, allowed] of [
        ["allowlist", "+15555550102", true],
        ["allowlist", "+15555550999", false],
        ["disabled", "+15555550102", false],
        ["open", "+15555550999", true],
        ["pairing", "+15555550999", false],
      ]) {
        const config = {
          ...cfg,
          channels: { linq: { ...cfg.channels.linq, dmPolicy: policy } },
        };
        const binding = {
          agentId: "main",
          sessionKey: "agent:main:linq:direct:" + sender,
          messageId: "policy-" + policy,
          inboundEventKind: "user_request",
        };
        const result = await authorizeLinqSender({
          cfg: config,
          account: resolveLinqAccount({ cfg: config }),
          channelRuntime: rt.channel,
          sender,
          text: "hi",
          contextBinding: binding,
        });
        assert.equal(result.senderAccess.allowed, allowed, policy);
        if (allowed) {
          const ctx = rt.channel.inbound.buildContext({
            channelIngress: result,
            channel: "linq",
            accountId: "default",
            messageId: binding.messageId,
            from: "linq:" + sender,
            sender: { id: sender },
            conversation: { kind: "direct", id: sender },
            route: {
              agentId: "main",
              accountId: "default",
              routeSessionKey: binding.sessionKey,
              dispatchSessionKey: binding.sessionKey,
            },
            reply: { to: "linq:chat:c1" },
            message: { rawBody: "hi", commandBody: "hi" },
          });
          assert.equal(ctx.SessionKey, binding.sessionKey);
        }
      }
      console.log(
        "PASS actual host pairing/allowlist/open/disabled decisions and bound context",
      );
    }
  }
}
