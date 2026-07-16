const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_SERIALIZED_VALUE_CHARS = 16 * 1024;
const MAX_SERIALIZATION_DEPTH = 4;
const MAX_OBJECT_KEYS = 32;

type FrontendLogListener = (event: unknown) => void;

export interface FrontendLogEventTarget {
  addEventListener(type: string, listener: FrontendLogListener): void;
}

export interface FrontendLogConsole {
  warn(...values: Array<unknown>): void;
  error(...values: Array<unknown>): void;
}

interface FrontendLogCaptureOptions {
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

interface FrontendLogInstallTarget {
  readonly console: FrontendLogConsole;
  readonly eventTarget: FrontendLogEventTarget;
}

export interface FrontendLogCapture {
  install(target: FrontendLogInstallTarget): void;
  snapshot(): string;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(value: string): boolean {
  return [
    "authorization",
    "proxyauthorization",
    "token",
    "accesstoken",
    "refreshtoken",
    "githubtoken",
    "apikey",
    "password",
    "secret",
    "clientsecret",
    "credential",
    "cookie",
    "setcookie",
  ].includes(normalizedKey(value));
}

export function sanitizeFrontendLogText(input: string): string {
  return input
    .replace(
      /("(?:authorization|proxy[-_]?authorization|token|access[-_]?token|refresh[-_]?token|github[-_]?token|api[-_]?key|password|secret|client[-_]?secret|credential|cookie|set[-_]?cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b(authorization|proxy-authorization|access_token|refresh_token|github_token|api_key|apikey|password|secret|credential|cookie|set-cookie)(\s*[:=]\s*)[^\s,;]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function safeObjectValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_SERIALIZATION_DEPTH) return "[Max depth]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_OBJECT_KEYS)
        .map((entry) => safeObjectValue(entry, seen, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
      if (isSensitiveKey(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      try {
        output[key] = safeObjectValue((value as Record<string, unknown>)[key], seen, depth + 1);
      } catch {
        output[key] = "[Unserializable]";
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function serializeValue(value: unknown): string {
  try {
    if (typeof value === "string") return value.slice(0, MAX_SERIALIZED_VALUE_CHARS);
    if (value instanceof Error) {
      const stack = value.stack?.split("\n").slice(1).join("\n");
      return `${value.name}: ${value.message}${stack ? `\n${stack}` : ""}`.slice(
        0,
        MAX_SERIALIZED_VALUE_CHARS,
      );
    }
    const serialized = JSON.stringify(safeObjectValue(value, new WeakSet(), 0));
    return (serialized ?? String(value)).slice(0, MAX_SERIALIZED_VALUE_CHARS);
  } catch {
    return "[Unserializable]";
  }
}

function truncateUtf8(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).byteLength <= maxBytes) return input;
  const marker = "[truncated]\n";
  const markerBytes = encoder.encode(marker);
  if (markerBytes.byteLength >= maxBytes) {
    return new TextDecoder().decode(markerBytes.slice(0, maxBytes));
  }
  const contentBytes = encoder.encode(input);
  const prefix = new TextDecoder().decode(contentBytes.slice(0, maxBytes - markerBytes.byteLength));
  return `${prefix}${marker}`;
}

export function createFrontendLogCapture(
  options: FrontendLogCaptureOptions = {},
): FrontendLogCapture {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const now = options.now ?? (() => new Date());
  const encoder = new TextEncoder();
  const records: Array<{ readonly text: string; readonly bytes: number }> = [];
  let totalBytes = 0;
  let installed = false;

  const record = (source: string, values: Array<unknown>): void => {
    try {
      const serialized = values.map(serializeValue).join(" ");
      const text = truncateUtf8(
        sanitizeFrontendLogText(`[${now().toISOString()}] ${source} ${serialized}\n`),
        maxBytes,
      );
      const bytes = encoder.encode(text).byteLength;
      records.push({ text, bytes });
      totalBytes += bytes;
      while (totalBytes > maxBytes && records.length > 1) {
        totalBytes -= records.shift()?.bytes ?? 0;
      }
    } catch {
      // Diagnostics capture must never affect the application path it observes.
    }
  };

  return {
    install({ console: consoleTarget, eventTarget }) {
      if (installed) return;
      installed = true;
      const nativeWarn = consoleTarget.warn.bind(consoleTarget);
      const nativeError = consoleTarget.error.bind(consoleTarget);
      consoleTarget.warn = (...values: Array<unknown>) => {
        nativeWarn(...values);
        record("console.warn", values);
      };
      consoleTarget.error = (...values: Array<unknown>) => {
        nativeError(...values);
        record("console.error", values);
      };
      eventTarget.addEventListener("error", (event) => {
        const candidate = event as { readonly error?: unknown; readonly message?: unknown };
        record("window.error", [candidate.error ?? candidate.message ?? event]);
      });
      eventTarget.addEventListener("unhandledrejection", (event) => {
        const candidate = event as { readonly reason?: unknown };
        record("window.unhandledrejection", [candidate.reason ?? event]);
      });
    },
    snapshot() {
      return records.map((entry) => entry.text).join("");
    },
  };
}

const frontendLogCapture = createFrontendLogCapture();

export function installFrontendLogCapture(): void {
  if (typeof window === "undefined") return;
  frontendLogCapture.install({ console, eventTarget: window });
}

export function readFrontendLogSnapshot(): string {
  return frontendLogCapture.snapshot();
}
