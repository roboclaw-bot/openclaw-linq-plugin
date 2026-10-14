export type LinqTarget =
  | {
      kind: "phone";
      phone: string;
      accountId?: string;
      raw: string;
    }
  | {
      kind: "chat";
      chatId: string;
      accountId?: string;
      raw: string;
    }
  | {
      kind: "group";
      chatId: string;
      accountId?: string;
      raw: string;
    };

const PHONE_RE = /^\+[1-9]\d{6,14}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function normalizePhone(raw: string): string {
  return raw.replace(/[\s().-]/gu, "");
}

export function parseLinqTarget(
  rawTarget: string,
  defaultAccountId?: string,
): LinqTarget {
  const raw = rawTarget.trim();
  const target = raw.startsWith("linq:") ? raw.slice("linq:".length) : raw;
  const parts = target.split(":");

  if (parts[0] === "chat" && parts[1]) {
    return {
      kind: "chat",
      chatId: parts.slice(1).join(":"),
      accountId: defaultAccountId,
      raw,
    };
  }

  if (parts[0] === "group" && parts[1]) {
    return {
      kind: "group",
      chatId: parts.slice(1).join(":"),
      accountId: defaultAccountId,
      raw,
    };
  }

  if (parts.length >= 2 && ACCOUNT_RE.test(parts[0] ?? "")) {
    const accountId = parts[0];
    const scoped = parts.slice(1).join(":");
    if (scoped.startsWith("chat:")) {
      const chatId = scoped.slice("chat:".length);
      if (chatId) {
        return { kind: "chat", chatId, accountId, raw };
      }
    }
    if (scoped.startsWith("group:")) {
      const chatId = scoped.slice("group:".length);
      if (chatId) {
        return { kind: "group", chatId, accountId, raw };
      }
    }
    const phone = normalizePhone(scoped);
    if (PHONE_RE.test(phone)) {
      return { kind: "phone", phone, accountId, raw };
    }
  }

  const phone = normalizePhone(target);
  if (PHONE_RE.test(phone)) {
    return { kind: "phone", phone, accountId: defaultAccountId, raw };
  }

  if (/^[A-Za-z0-9_-]+$/u.test(target)) {
    return { kind: "chat", chatId: target, accountId: defaultAccountId, raw };
  }

  throw new Error(
    "Invalid Linq target. Use linq:+15556667777, linq:chat:<chat_id>, linq:group:<chat_id>, or linq:<accountId>:+15556667777.",
  );
}

export function formatLinqTarget(target: LinqTarget): string {
  const prefix = target.accountId ? `linq:${target.accountId}:` : "linq:";
  if (target.kind === "phone") {
    return `${prefix}${target.phone}`;
  }
  if (target.kind === "group") {
    return `${prefix}group:${target.chatId}`;
  }
  return `${prefix}chat:${target.chatId}`;
}
