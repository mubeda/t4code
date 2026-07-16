const MAX_TRACE_STRING_LENGTH = 4_096;
export const REDACTED_TRACE_VALUE = "[REDACTED]";
export const UN_SERIALIZABLE_TRACE_VALUE = "[Unserializable]";
const INLINE_BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const COOKIE_HEADER_LINE = /^(\s*(?:set[-_. ]?cookie|cookie)\s*:\s*).*$/gim;
const INLINE_COOKIE_SECRET =
  /\b(set[-_. ]?cookie|cookie)\b(["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}\]]+)/gi;
const INLINE_NAMED_SECRET =
  /\b(authorization|credentials?|password|passwd|secret|access[-_. ]?token|refresh[-_. ]?token|id[-_. ]?token|token|api[-_. ]?key|prompts?|messages?)\b(["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&})\]]+)/gi;
const INLINE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const SENSITIVE_COMPACT_TRACE_KEYS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "secrets",
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "prompt",
  "prompts",
  "message",
  "messages",
]);

function splitTraceKey(value: string): ReadonlyArray<string> {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

export function isSensitiveTraceKey(value: string): boolean {
  const splitParts = splitTraceKey(value);
  if (
    splitParts.length === 2 &&
    ((splitParts[0] === "token" && splitParts[1] === "count") ||
      (splitParts[0] === "tokens" && splitParts[1] === "count") ||
      (splitParts[0] === "count" && splitParts[1] === "token") ||
      (splitParts[0] === "count" && splitParts[1] === "tokens"))
  ) {
    return false;
  }
  let semanticLength = splitParts.length;
  while (
    semanticLength > 0 &&
    (splitParts[semanticLength - 1] === "header" || splitParts[semanticLength - 1] === "value")
  ) {
    semanticLength -= 1;
  }
  const parts = splitParts.slice(0, semanticLength);
  const compact = parts.join("");
  if (SENSITIVE_COMPACT_TRACE_KEYS.has(compact)) {
    return true;
  }
  const last = parts.at(-1);
  return (
    last === "authorization" ||
    last === "cookie" ||
    last === "cookies" ||
    last === "credential" ||
    last === "credentials" ||
    last === "password" ||
    last === "passwd" ||
    last === "secret" ||
    last === "secrets" ||
    last === "token" ||
    last === "tokens" ||
    last === "prompt" ||
    last === "prompts" ||
    last === "message" ||
    last === "messages" ||
    (last === "key" && parts.at(-2) === "api")
  );
}

function sanitizeUrlText(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0) {
      url.username = REDACTED_TRACE_VALUE;
    }
    if (url.password.length > 0) {
      url.password = REDACTED_TRACE_VALUE;
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveTraceKey(key)) {
        url.searchParams.set(key, REDACTED_TRACE_VALUE);
      }
    }
    return url.toString();
  } catch {
    return UN_SERIALIZABLE_TRACE_VALUE;
  }
}

export function sanitizeTraceText(value: string): string {
  if (value.length > MAX_TRACE_STRING_LENGTH) {
    return `[Oversized string: ${value.length} characters]`;
  }
  const sanitized = value
    .replace(COOKIE_HEADER_LINE, "$1[REDACTED]")
    .replace(INLINE_URL, sanitizeUrlText)
    .replace(INLINE_BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(INLINE_COOKIE_SECRET, "$1$2$3[REDACTED]")
    .replace(INLINE_NAMED_SECRET, "$1$2$3[REDACTED]");
  return sanitized.length > MAX_TRACE_STRING_LENGTH
    ? `[Oversized string: ${sanitized.length} characters]`
    : sanitized;
}
