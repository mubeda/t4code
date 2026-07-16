import * as Schema from "effect/Schema";

const ClerkPublishableKeyPrefix = Schema.Literals(["pk_test", "pk_live", "unknown"]);
const CanonicalAsciiDnsHostname =
  /^(?=.{1,253}$)(?=.*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export class ClerkPublishableKeyDecodeError extends Schema.TaggedErrorClass<ClerkPublishableKeyDecodeError>()(
  "ClerkPublishableKeyDecodeError",
  {
    keyPrefix: ClerkPublishableKeyPrefix,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Clerk publishable key (${this.keyPrefix}).`;
  }
}

export class ClerkPublishableKeyFrontendApiError extends Schema.TaggedErrorClass<ClerkPublishableKeyFrontendApiError>()(
  "ClerkPublishableKeyFrontendApiError",
  {
    keyPrefix: ClerkPublishableKeyPrefix,
    hostname: Schema.optional(Schema.String),
    reason: Schema.Literals(["empty", "contains-path", "invalid-url"]),
  },
) {
  override get message(): string {
    return `Invalid Clerk frontend API decoded from publishable key (${this.keyPrefix}; ${this.reason}).`;
  }
}

function safeClerkFrontendApiHostname(frontendApi: string): string | undefined {
  try {
    const hostname = new URL(`https://${frontendApi}`).hostname;
    return hostname === frontendApi ? undefined : hostname;
  } catch {
    return undefined;
  }
}

function parseClerkFrontendApi(publishableKey: string): {
  readonly hostname: string;
  readonly url: string;
} {
  const keyPrefix = publishableKey.startsWith("pk_test_")
    ? "pk_test"
    : publishableKey.startsWith("pk_live_")
      ? "pk_live"
      : "unknown";
  const encodedFrontendApi = publishableKey.split("_").slice(2).join("_");
  let frontendApi: string;
  try {
    frontendApi = globalThis.atob(encodedFrontendApi).replace(/\$$/u, "");
  } catch (cause) {
    throw new ClerkPublishableKeyDecodeError({ keyPrefix, cause });
  }

  if (frontendApi.length === 0) {
    throw new ClerkPublishableKeyFrontendApiError({
      keyPrefix,
      reason: "empty",
    });
  }
  if (/[/\\?#@:]/u.test(frontendApi)) {
    const hostname = safeClerkFrontendApiHostname(frontendApi);
    throw new ClerkPublishableKeyFrontendApiError({
      keyPrefix,
      reason: "contains-path",
      ...(hostname === undefined ? {} : { hostname }),
    });
  }
  if (!CanonicalAsciiDnsHostname.test(frontendApi)) {
    const hostname = safeClerkFrontendApiHostname(frontendApi);
    throw new ClerkPublishableKeyFrontendApiError({
      keyPrefix,
      reason: "invalid-url",
      ...(hostname === undefined ? {} : { hostname }),
    });
  }

  const url = `https://${frontendApi}`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ClerkPublishableKeyFrontendApiError({
      keyPrefix,
      reason: "invalid-url",
    });
  }
  if (parsedUrl.hostname !== frontendApi) {
    throw new ClerkPublishableKeyFrontendApiError({
      keyPrefix,
      hostname: parsedUrl.hostname,
      reason: "invalid-url",
    });
  }
  return { hostname: parsedUrl.hostname, url };
}

export function clerkFrontendApiUrlFromPublishableKey(publishableKey: string): string {
  return parseClerkFrontendApi(publishableKey).url;
}

export function clerkFrontendApiHostnameFromPublishableKey(publishableKey: string): string {
  return parseClerkFrontendApi(publishableKey).hostname;
}

export function isAllowedClerkFrontendApiHostname(
  hostname: string,
  configuredHostname: string | null,
): boolean {
  return (
    hostname.endsWith(".clerk.accounts.dev") ||
    hostname.endsWith(".clerk.accounts.com") ||
    hostname === configuredHostname
  );
}

export function relayClerkTokenOptions(template: string) {
  return {
    template,
    skipCache: true,
  } as const;
}
