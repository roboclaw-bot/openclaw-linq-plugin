import type { LinqProbe } from "./types.js";

const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";

export async function probeLinq(
  token?: string,
  timeoutMs = 5000,
): Promise<LinqProbe> {
  const resolvedToken = token?.trim() ?? "";
  if (!resolvedToken) {
    return { ok: false, error: "Linq API token not configured" };
  }

  const url = `${LINQ_API_BASE}/phone_numbers`;
  const controller = new AbortController();
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${resolvedToken}`,
        "User-Agent": "OpenClaw-Linq/1.0",
      },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        error: `Linq API request failed (HTTP ${response.status})`,
      };
    }
    const data = (await response.json()) as {
      phone_numbers?: Array<{ phone_number?: string }>;
    };
    const phoneNumbers = (data.phone_numbers ?? [])
      .map((p) => p.phone_number)
      .filter(Boolean) as string[];
    return { ok: true, phoneNumbers };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Linq probe timed out (${timeoutMs}ms)` };
    }
    return { ok: false, error: String(err) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
