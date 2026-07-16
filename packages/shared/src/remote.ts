import * as Schema from "effect/Schema";

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const EXPLICIT_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const RFC_SCHEME_PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const BARE_HOST_WITH_PORT_PATTERN = /^[A-Za-z0-9.-]+:\d+$/;
const BARE_IPV6_AUTHORITY_PATTERN = /^\[[^\]]+\](?::\d+)?$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const DOT_RELATIVE_PATH_PATTERN = /^\.\.?(?:[\\/]|$)/;

const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

export class RemoteBackendUrlMissingError extends Schema.TaggedErrorClass<RemoteBackendUrlMissingError>()(
  "RemoteBackendUrlMissingError",
  {},
) {
  override get message(): string {
    return "Enter a backend URL.";
  }
}

export class RemotePairingUrlInvalidError extends Schema.TaggedErrorClass<RemotePairingUrlInvalidError>()(
  "RemotePairingUrlInvalidError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Pairing URL is invalid.";
  }
}

export class RemoteBackendUrlInvalidError extends Schema.TaggedErrorClass<RemoteBackendUrlInvalidError>()(
  "RemoteBackendUrlInvalidError",
  {
    source: Schema.Literals(["direct-host", "hosted-pairing-host"]),
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Backend URL is invalid.";
  }
}

export class RemotePairingTokenMissingError extends Schema.TaggedErrorClass<RemotePairingTokenMissingError>()(
  "RemotePairingTokenMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Pairing URL is missing its token.";
  }
}

export class RemotePairingCodeMissingError extends Schema.TaggedErrorClass<RemotePairingCodeMissingError>()(
  "RemotePairingCodeMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Enter a pairing code.";
  }
}

export const RemotePairingTargetError = Schema.Union([
  RemoteBackendUrlMissingError,
  RemotePairingUrlInvalidError,
  RemoteBackendUrlInvalidError,
  RemotePairingTokenMissingError,
  RemotePairingCodeMissingError,
]);
export type RemotePairingTargetError = typeof RemotePairingTargetError.Type;

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const isLocalPath = (value: string): boolean =>
  WINDOWS_DRIVE_PATH_PATTERN.test(value) ||
  /^\/(?!\/)/.test(value) ||
  DOT_RELATIVE_PATH_PATTERN.test(value);

const hasAuthority = (value: string, authorityStart: number): boolean => {
  const remainder = value.slice(authorityStart);
  const separatorIndex = remainder.search(/[/?#]/);
  const authority = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  return authority.length > 0;
};

const leadingAuthorityToken = (value: string): string => {
  const separatorIndex = value.search(/[/?#]/);
  return separatorIndex === -1 ? value : value.slice(0, separatorIndex);
};

const parseRemoteBaseUrl = (value: string, source: RemoteBackendUrlInvalidError["source"]): URL => {
  try {
    return new URL(value);
  } catch (cause) {
    throw new RemoteBackendUrlInvalidError({ source, cause });
  }
};

const normalizeRemoteBaseUrl = (
  rawValue: string,
  source: RemoteBackendUrlInvalidError["source"],
): URL => {
  const trimmed = rawValue.trim();
  let normalizedInput: string;

  if (trimmed.includes("\\")) {
    throw new RemoteBackendUrlInvalidError({ source });
  }

  if (trimmed.startsWith("//")) {
    if (!hasAuthority(trimmed, 2)) {
      throw new RemoteBackendUrlInvalidError({ source });
    }
    normalizedInput = `https:${trimmed}`;
  } else {
    const authority = leadingAuthorityToken(trimmed);
    const isBareAuthority =
      BARE_IPV6_AUTHORITY_PATTERN.test(authority) || BARE_HOST_WITH_PORT_PATTERN.test(authority);
    if (isLocalPath(trimmed) && !isBareAuthority) {
      throw new RemoteBackendUrlInvalidError({ source });
    }

    const explicitSchemeMatch = EXPLICIT_SCHEME_PATTERN.exec(trimmed);
    if (explicitSchemeMatch) {
      const protocol = `${explicitSchemeMatch[1]!.toLowerCase()}:`;
      if (!SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(protocol)) {
        throw new RemoteBackendUrlInvalidError({ source, protocol });
      }
      if (!hasAuthority(trimmed, explicitSchemeMatch[0].length)) {
        throw new RemoteBackendUrlInvalidError({ source });
      }
      normalizedInput = trimmed;
    } else {
      if (isBareAuthority) {
        normalizedInput = `https://${trimmed}`;
      } else if (authority.includes(":")) {
        const schemeMatch = RFC_SCHEME_PREFIX_PATTERN.exec(authority);
        const protocol = schemeMatch ? `${schemeMatch[1]!.toLowerCase()}:` : undefined;
        throw new RemoteBackendUrlInvalidError({
          source,
          protocol:
            protocol && !SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(protocol) ? protocol : undefined,
        });
      } else {
        normalizedInput = `https://${trimmed}`;
      }
    }
  }

  const url = parseRemoteBaseUrl(normalizedInput, source);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  };
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch (cause) {
      throw new RemotePairingUrlInvalidError({ cause });
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingUrlInvalidError({
        protocol: url.protocol,
      });
    }
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(
        hostedPairingRequest.host,
        "hosted-pairing-host",
      );
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new RemotePairingTokenMissingError({ host: url.host });
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new RemoteBackendUrlMissingError();
  }
  const normalizedHost = normalizeRemoteBaseUrl(host, "direct-host");
  if (!pairingCode) {
    throw new RemotePairingCodeMissingError({ host: normalizedHost.host });
  }

  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};
