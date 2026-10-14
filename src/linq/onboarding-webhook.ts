import { detectBinary, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  createLinqWebhookSubscription,
  deleteLinqWebhookSubscription,
  findLinqWebhookSubscription,
  findReplaceableLinqWebhookSubscriptions,
  listLinqWebhookSubscriptions,
  type LinqWebhookSubscription,
} from "./subscriptions.js";
import {
  buildCloudflareTunnelInstructions,
  buildLocalWebhookUrl,
  buildTailscaleFunnelInstructions,
  resolveConfiguredWebhookPath,
  validatePublicWebhookUrl,
  validateWebhookPath,
} from "./onboarding-ingress.js";

type LinqIngressMode =
  | "existing"
  | "tailscale"
  | "cloudflare"
  | "outbound-only";

type LinqSubscriptionSetupResult = {
  state: "ready" | "incomplete" | "error";
  detail: string;
  subscription?: LinqWebhookSubscription;
  signingSecret?: string;
  clearSigningSecret?: boolean;
};

class PersistentEffectGuardError extends Error {
  constructor(readonly originalError: unknown) {
    super("Linq setup persistent-effect guard failed");
    this.name = "PersistentEffectGuardError";
  }
}

async function guardPersistentEffect(
  beforePersistentEffect: (() => Promise<void>) | undefined,
): Promise<void> {
  try {
    await beforePersistentEffect?.();
  } catch (err) {
    throw new PersistentEffectGuardError(err);
  }
}

export type LinqWebhookOnboardingResult =
  | {
      mode: "inbound";
      webhookPath: string;
      webhookUrl: string;
      signingSecret?: string;
      clearSigningSecret?: boolean;
    }
  | { mode: "outbound-only"; webhookPath: string }
  | { mode: "preserved" };

async function setupLinqWebhookSubscription(params: {
  prompter: WizardPrompter;
  token: string;
  webhookUrl: string;
  previousWebhookUrl?: string;
  fromPhone: string;
  previousFromPhone?: string;
  hasWebhookSecret: boolean;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<LinqSubscriptionSetupResult> {
  const {
    prompter,
    token,
    webhookUrl,
    previousWebhookUrl,
    fromPhone,
    previousFromPhone,
    hasWebhookSecret,
  } = params;
  if (!token.trim()) {
    return { state: "error", detail: "API token is unavailable." };
  }
  let clearSigningSecret = false;
  try {
    const subscriptions = await listLinqWebhookSubscriptions(token);
    const existing = findLinqWebhookSubscription(
      subscriptions,
      webhookUrl,
      fromPhone,
    );
    if (existing) {
      await prompter.note(
        `Found Linq webhook subscription ${existing.id} for ${webhookUrl}.`,
        "Linq webhook",
      );
      if (hasWebhookSecret) {
        return {
          state: "ready",
          detail: "Reused existing subscription.",
          subscription: existing,
        };
      }
      const recreateForSecret = await prompter.confirm({
        message:
          "Recreate the existing Linq webhook subscription to store its signing secret?",
        initialValue: true,
      });
      if (!recreateForSecret) {
        await prompter.note(
          "Linq only returns the signing secret when creating a subscription. Delete/recreate the subscription or enter the secret manually if inbound signatures fail.",
          "Linq webhook secret",
        );
        return {
          state: "incomplete",
          detail:
            "Existing subscription has no locally configured signing secret.",
          subscription: existing,
        };
      }
      await guardPersistentEffect(params.beforePersistentEffect);
      await deleteLinqWebhookSubscription({
        token,
        subscriptionId: existing.id,
      });
      clearSigningSecret = true;
    }

    const replaceable = findReplaceableLinqWebhookSubscriptions(subscriptions, {
      targetUrl: webhookUrl,
      phoneNumber: fromPhone,
      previousTargetUrl: previousWebhookUrl,
      previousPhoneNumber: previousFromPhone,
    });
    if (replaceable.length > 0) {
      const replace = await prompter.confirm({
        message: `Replace ${replaceable.length} stale Linq webhook subscription${replaceable.length === 1 ? "" : "s"} before creating the current one?`,
        initialValue: true,
      });
      if (!replace) {
        return {
          state: "incomplete",
          detail:
            "A stale subscription was left in place and the current target was not created.",
        };
      }
      for (const subscription of replaceable) {
        await guardPersistentEffect(params.beforePersistentEffect);
        await deleteLinqWebhookSubscription({
          token,
          subscriptionId: subscription.id,
        });
        if (subscription.target_url === previousWebhookUrl) {
          clearSigningSecret = true;
        }
      }
    }

    const create = await prompter.confirm({
      message: "Create Linq webhook subscription for inbound messages?",
      initialValue: true,
    });
    if (!create) {
      return {
        state: "incomplete",
        detail: "Subscription creation was declined.",
        ...(clearSigningSecret ? { clearSigningSecret: true } : {}),
      };
    }
    await guardPersistentEffect(params.beforePersistentEffect);
    const subscription = await createLinqWebhookSubscription({
      token,
      targetUrl: webhookUrl,
      phoneNumber: fromPhone,
    });
    await prompter.note(
      `Created Linq webhook subscription ${subscription.id}.`,
      "Linq webhook",
    );
    const signingSecret = subscription.signing_secret?.trim();
    if (!signingSecret) {
      return {
        state: "incomplete",
        detail:
          "Subscription was created but Linq did not return a signing secret.",
        subscription,
        clearSigningSecret: true,
      };
    }
    return {
      state: "ready",
      detail: "Created subscription and captured its signing secret.",
      subscription,
      signingSecret,
    };
  } catch (err) {
    if (err instanceof PersistentEffectGuardError) {
      throw err.originalError;
    }
    await prompter.note(
      `Could not configure Linq webhook subscription: ${String(err)}`,
      "Linq webhook",
    );
    return {
      state: "error",
      detail: String(err),
      ...(clearSigningSecret ? { clearSigningSecret: true } : {}),
    };
  }
}

async function selectLinqIngressMode(params: {
  prompter: WizardPrompter;
  hasPublicWebhookUrl: boolean;
}): Promise<LinqIngressMode> {
  const [hasTailscale, hasCloudflared] = await Promise.all([
    detectBinary("tailscale"),
    detectBinary("cloudflared"),
  ]);
  return await params.prompter.select<LinqIngressMode>({
    message: "Inbound message delivery",
    initialValue: params.hasPublicWebhookUrl
      ? "existing"
      : hasTailscale
        ? "tailscale"
        : "existing",
    options: [
      {
        value: "existing",
        label: "Existing public HTTPS URL",
        hint: "Use a reverse proxy or ingress you already operate",
      },
      {
        value: "tailscale",
        label: "Tailscale Funnel",
        hint: hasTailscale ? "tailscale detected" : "tailscale not detected",
      },
      {
        value: "cloudflare",
        label: "Cloudflare Tunnel",
        hint: hasCloudflared
          ? "cloudflared detected"
          : "cloudflared not detected",
      },
      {
        value: "outbound-only",
        label: "Outbound only",
        hint: "Skip inbound messages and provider subscription",
      },
    ],
  });
}

async function promptPublicWebhookUrl(params: {
  prompter: WizardPrompter;
  mode: Exclude<LinqIngressMode, "outbound-only">;
  gatewayPort: number;
  webhookPath: string;
  existingWebhookUrl?: string;
}): Promise<string> {
  const { prompter, mode, gatewayPort, webhookPath } = params;
  if (mode === "tailscale") {
    await prompter.note(
      buildTailscaleFunnelInstructions({ gatewayPort, webhookPath }),
      "Path-scoped Tailscale Funnel",
    );
  } else if (mode === "cloudflare") {
    await prompter.note(
      buildCloudflareTunnelInstructions({ gatewayPort, webhookPath }),
      "Path-scoped Cloudflare Tunnel",
    );
  } else {
    await prompter.note(
      [
        `Route only ${webhookPath} to ${buildLocalWebhookUrl(gatewayPort, webhookPath)}.`,
        "Do not expose the Gateway root or Control UI.",
      ].join("\n"),
      "Public ingress",
    );
  }

  const existingWebhookUrl = params.existingWebhookUrl?.trim();
  return String(
    await prompter.text({
      message: "Public webhook URL",
      initialValue:
        existingWebhookUrl &&
        !validatePublicWebhookUrl(existingWebhookUrl, webhookPath)
          ? existingWebhookUrl
          : undefined,
      placeholder: `https://messages.example.com${webhookPath}`,
      validate: (value) => validatePublicWebhookUrl(value, webhookPath),
    }),
  ).trim();
}

async function disableExistingInbound(params: {
  prompter: WizardPrompter;
  token: string;
  webhookUrl?: string;
  fromPhone: string;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<{ disabled: boolean; detail: string }> {
  const webhookUrl = params.webhookUrl?.trim();
  if (!webhookUrl || !params.token.trim()) {
    return {
      disabled: true,
      detail: "No inbound subscription was configured.",
    };
  }
  try {
    const subscriptions = await listLinqWebhookSubscriptions(params.token);
    // Shared subscriptions belong to multiple lines. Preserve local setup rather than
    // silently removing its secret or deleting another account's delivery endpoint.
    if (
      subscriptions.some(
        (sub) =>
          sub.is_active &&
          sub.target_url === webhookUrl &&
          (!sub.phone_numbers?.length || sub.phone_numbers.length > 1),
      )
    ) {
      await params.prompter.note(
        "A shared subscription uses this URL. Remove this line from it in Linq before switching to outbound-only.",
        "Linq webhook cleanup",
      );
      return { disabled: false, detail: "Shared subscription unchanged" };
    }
    const existing = findLinqWebhookSubscription(
      subscriptions,
      webhookUrl,
      params.fromPhone,
    );
    if (!existing) {
      return {
        disabled: true,
        detail: "No matching active subscription was found.",
      };
    }
    const unfiltered = (existing.phone_numbers ?? []).length === 0;
    const shouldDelete = await params.prompter.confirm({
      message: unfiltered
        ? `Delete unfiltered Linq webhook subscription ${existing.id}? It may receive messages for other lines on this Linq account.`
        : `Delete Linq webhook subscription ${existing.id} to switch to outbound-only?`,
      initialValue: true,
    });
    if (!shouldDelete) {
      return {
        disabled: false,
        detail:
          "Existing inbound configuration was preserved because subscription deletion was declined.",
      };
    }
    await guardPersistentEffect(params.beforePersistentEffect);
    await deleteLinqWebhookSubscription({
      token: params.token,
      subscriptionId: existing.id,
    });
    return { disabled: true, detail: `Deleted subscription ${existing.id}.` };
  } catch (err) {
    if (err instanceof PersistentEffectGuardError) {
      throw err.originalError;
    }
    await params.prompter.note(
      `Could not disable the existing Linq subscription: ${String(err)}`,
      "Linq outbound-only setup",
    );
    return {
      disabled: false,
      detail:
        "Existing inbound configuration was preserved because provider cleanup failed.",
    };
  }
}

function formatPhoneFilter(
  subscription: LinqWebhookSubscription | undefined,
): string {
  if (!subscription) {
    return "not configured";
  }
  const phoneNumbers = subscription.phone_numbers ?? [];
  return phoneNumbers.length > 0
    ? phoneNumbers.join(", ")
    : "all account phone numbers";
}

async function noteLinqWebhookSummary(params: {
  prompter: WizardPrompter;
  localUrl: string;
  publicUrl?: string;
  subscriptionResult?: LinqSubscriptionSetupResult;
  hasWebhookSecret: boolean;
  outboundDetail?: string;
}): Promise<void> {
  if (!params.publicUrl) {
    await params.prompter.note(
      [
        `Local route: ${params.localUrl}`,
        "Public target: not configured",
        "Subscription: not configured",
        "Inbound readiness: OUTBOUND ONLY",
        params.outboundDetail ?? "Inbound setup was skipped.",
        "Next: rerun channel setup when you are ready to add public HTTPS ingress.",
      ].join("\n"),
      "Linq setup summary",
    );
    return;
  }

  const result = params.subscriptionResult;
  const ready = result?.state === "ready" && params.hasWebhookSecret;
  await params.prompter.note(
    [
      `Local route: ${params.localUrl}`,
      `Public target: ${params.publicUrl}`,
      `Subscription: ${result?.subscription?.id ?? "not configured"}`,
      `Phone filter: ${formatPhoneFilter(result?.subscription)}`,
      `Signing secret: ${params.hasWebhookSecret ? "configured" : "missing"}`,
      `Inbound readiness: ${ready ? "CONFIGURED (delivery unverified)" : "INCOMPLETE"}`,
      result?.detail ?? "Subscription setup did not run.",
      ready
        ? "Next: start the Gateway, then text the selected Linq number and confirm its reply."
        : "Next: rerun setup and complete the missing subscription or signing-secret step.",
    ].join("\n"),
    "Linq setup summary",
  );
}

export async function configureLinqWebhookOnboarding(params: {
  prompter: WizardPrompter;
  token: string;
  fromPhone: string;
  previousFromPhone?: string;
  existingWebhookUrl?: string;
  existingWebhookPath?: string;
  hasWebhookSecret: boolean;
  gatewayPort: number;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<LinqWebhookOnboardingResult> {
  const previousWebhookUrl = params.existingWebhookUrl?.trim();
  const existingWebhookPath = resolveConfiguredWebhookPath({
    webhookPath: params.existingWebhookPath,
    webhookUrl: previousWebhookUrl,
  });
  const webhookPath = String(
    await params.prompter.text({
      message: "Local webhook path",
      initialValue: existingWebhookPath,
      validate: validateWebhookPath,
    }),
  ).trim();
  const localWebhookUrl = buildLocalWebhookUrl(params.gatewayPort, webhookPath);
  await params.prompter.note(
    `The OpenClaw Gateway will receive Linq webhooks at ${localWebhookUrl}.`,
    "Local Linq route",
  );

  const ingressMode = await selectLinqIngressMode({
    prompter: params.prompter,
    hasPublicWebhookUrl: Boolean(
      previousWebhookUrl &&
        !validatePublicWebhookUrl(previousWebhookUrl, webhookPath),
    ),
  });
  if (ingressMode === "outbound-only") {
    const outbound = await disableExistingInbound({
      prompter: params.prompter,
      token: params.token,
      webhookUrl: previousWebhookUrl,
      fromPhone: params.fromPhone,
      beforePersistentEffect: params.beforePersistentEffect,
    });
    if (!outbound.disabled) {
      await params.prompter.note(
        [
          `Local route: ${buildLocalWebhookUrl(params.gatewayPort, existingWebhookPath)}`,
          `Public target: ${previousWebhookUrl ?? "unknown"}`,
          "Inbound readiness: EXISTING CONFIGURATION PRESERVED",
          outbound.detail,
        ].join("\n"),
        "Linq setup summary",
      );
      return { mode: "preserved" };
    }
    await noteLinqWebhookSummary({
      prompter: params.prompter,
      localUrl: localWebhookUrl,
      outboundDetail: outbound.detail,
      hasWebhookSecret: false,
    });
    return { mode: "outbound-only", webhookPath };
  }

  const publicUrl = await promptPublicWebhookUrl({
    prompter: params.prompter,
    mode: ingressMode,
    gatewayPort: params.gatewayPort,
    webhookPath,
    existingWebhookUrl: previousWebhookUrl,
  });
  const versionedUrl = new URL(publicUrl);
  versionedUrl.searchParams.set("version", "2026-02-03");
  const webhookUrl = versionedUrl.href;
  const subscriptionResult = await setupLinqWebhookSubscription({
    prompter: params.prompter,
    token: params.token,
    webhookUrl,
    previousWebhookUrl,
    fromPhone: params.fromPhone,
    previousFromPhone: params.previousFromPhone,
    hasWebhookSecret: params.hasWebhookSecret,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  await noteLinqWebhookSummary({
    prompter: params.prompter,
    localUrl: localWebhookUrl,
    publicUrl: webhookUrl,
    subscriptionResult,
    hasWebhookSecret:
      Boolean(subscriptionResult.signingSecret) ||
      (params.hasWebhookSecret && !subscriptionResult.clearSigningSecret),
  });
  return {
    mode: "inbound",
    webhookPath,
    webhookUrl,
    ...(subscriptionResult.signingSecret
      ? { signingSecret: subscriptionResult.signingSecret }
      : {}),
    ...(subscriptionResult.clearSigningSecret
      ? { clearSigningSecret: true }
      : {}),
  };
}
