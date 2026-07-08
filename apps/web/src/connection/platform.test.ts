import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";

// ── Controllable mock state ──────────────────────────────────────────
const pf = vi.hoisted(() => ({
  isHostedStatic: false,
  session: null as null | { readClerkToken: () => unknown },
  desktopPrimaryBearer: null as null | (() => Promise<string | null>),
  primaryTarget: null as unknown,
  secondaryRead: { _tag: "Success", bootstraps: [] as unknown[] } as unknown,
  descriptor: { environmentId: "environment-primary", label: "Primary" } as unknown,
  bearerAccess: { access_token: "secondary-token", expires_in: 3_600 } as unknown,
  clearCalls: [] as string[],
  trackCalls: [] as Array<{ requestId: string; tag: string }>,
  ackCalls: [] as string[],
}));

vi.mock("../hostedPairing", () => ({
  isHostedStaticApp: () => pf.isHostedStatic,
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => pf.session },
}));

vi.mock("../rpc/requestLatencyState", () => ({
  trackRpcRequestSent: (requestId: string, tag: string) => {
    pf.trackCalls.push({ requestId, tag });
  },
  acknowledgeRpcRequest: (requestId: string) => {
    pf.ackCalls.push(requestId);
  },
}));

vi.mock("../composerDraftStore", () => ({
  clearComposerDraftsEnvironment: (environmentId: string) => {
    pf.clearCalls.push(environmentId);
  },
}));

vi.mock("../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: () =>
    pf.desktopPrimaryBearer ? pf.desktopPrimaryBearer() : Promise.resolve(null),
}));

vi.mock("../environments/primary/httpLayer", async () => {
  const Layer = await import("effect/Layer");
  return { primaryEnvironmentHttpLayer: Layer.empty };
});

vi.mock("../environments/primary/target", () => ({
  readPrimaryEnvironmentTarget: () => {
    if (pf.primaryTarget instanceof Error) {
      throw pf.primaryTarget;
    }
    return pf.primaryTarget;
  },
}));

vi.mock("./desktopLocal", () => ({
  desktopLocalConnectionId: (backendId: string) => `local:${backendId}`,
  readDesktopSecondaryBootstrapsResult: () => pf.secondaryRead,
}));

vi.mock("./storage", async () => {
  const Layer = await import("effect/Layer");
  return { connectionStorageLayer: Layer.empty };
});

vi.mock("@t3tools/client-runtime/relay", async () => {
  const Stream = await import("effect/Stream");
  return {
    managedRelaySessionAtom: { _tag: "managedRelaySessionAtom" },
    managedRelayAccountChanges: () => Stream.empty,
  };
});

vi.mock("@t3tools/client-runtime/environment", () => ({
  fetchRemoteEnvironmentDescriptor: (_input: { httpBaseUrl: string }) =>
    Effect.succeed(pf.descriptor),
}));

vi.mock("@t3tools/client-runtime/authorization", () => ({
  bootstrapRemoteBearerSession: (_input: unknown) => Effect.succeed(pf.bearerAccess),
}));

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  connectionPlatformLayer,
  primaryRegistrationToRetainAfterTopologyRead,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const PREPARE_INPUT = {
  connectionId: "ssh-connection",
  expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
  target: TARGET,
};

class ReadClerkTokenError extends Data.TaggedError("ReadClerkTokenError")<{
  readonly message: string;
}> {}

interface BridgeOptions {
  readonly failDescriptor?: boolean;
  readonly failEnsure?: unknown;
  readonly pairingToken?: string | null;
  readonly failBearer?: boolean;
  readonly failDisconnect?: boolean;
}

function makeBridge(calls: string[], options: BridgeOptions = {}): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      if (options.failEnsure !== undefined) {
        throw options.failEnsure;
      }
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: options.pairingToken === undefined ? "pairing-token" : options.pairingToken,
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      if (options.failBearer === true) {
        throw new Error("bearer denied");
      }
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
    disconnectSshEnvironment: async () => {
      calls.push("disconnect");
      if (options.failDisconnect === true) {
        throw new Error("disconnect failed");
      }
      return undefined;
    },
  } as unknown as DesktopBridge;
}

function stubBrowser(options: { desktopBridge?: DesktopBridge; platform?: string } = {}): void {
  vi.stubGlobal("window", options.desktopBridge ? { desktopBridge: options.desktopBridge } : {});
  vi.stubGlobal("navigator", {
    platform: options.platform ?? "Win32",
    onLine: true,
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

interface DomStubs {
  readonly windowListeners: (type: string) => Array<() => void>;
  readonly documentListeners: (type: string) => Array<() => void>;
  readonly fireWindow: (type: string) => void;
  readonly fireDocument: (type: string) => void;
}

function makeDomStubs(options: { desktopBridge?: DesktopBridge } = {}): DomStubs {
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const add = (map: Map<string, Array<() => void>>) => (type: string, handler: () => void) => {
    const bucket = map.get(type) ?? [];
    bucket.push(handler);
    map.set(type, bucket);
  };
  const remove = (map: Map<string, Array<() => void>>) => (type: string, handler: () => void) => {
    const bucket = map.get(type);
    if (!bucket) return;
    const index = bucket.indexOf(handler);
    if (index >= 0) bucket.splice(index, 1);
  };
  vi.stubGlobal("window", {
    desktopBridge: options.desktopBridge,
    addEventListener: add(windowListeners),
    removeEventListener: remove(windowListeners),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: add(documentListeners),
    removeEventListener: remove(documentListeners),
  });
  vi.stubGlobal("navigator", { platform: "Win32", onLine: true });
  return {
    windowListeners: (type) => windowListeners.get(type) ?? [],
    documentListeners: (type) => documentListeners.get(type) ?? [],
    fireWindow: (type) => {
      for (const handler of Array.from(windowListeners.get(type) ?? [])) handler();
    },
    fireDocument: (type) => {
      for (const handler of Array.from(documentListeners.get(type) ?? [])) handler();
    },
  };
}

function waitFor(check: () => boolean) {
  return Effect.gen(function* () {
    for (let index = 0; index < 2_000; index += 1) {
      if (check()) return;
      // Cooperative yield (clock-agnostic: it.effect runs on a frozen TestClock).
      yield* Effect.yieldNow;
    }
    throw new Error("Timed out waiting for a stubbed DOM listener to register.");
  });
}

function resetPf(): void {
  pf.isHostedStatic = false;
  pf.session = null;
  pf.desktopPrimaryBearer = null;
  pf.primaryTarget = null;
  pf.secondaryRead = { _tag: "Success", bootstraps: [] };
  pf.descriptor = { environmentId: "environment-primary", label: "Primary" };
  pf.bearerAccess = { access_token: "secondary-token", expires_in: 3_600 };
  pf.clearCalls.length = 0;
  pf.trackCalls.length = 0;
  pf.ackCalls.length = 0;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPf();
});

// ─────────────────────────────────────────────────────────────────────
// Existing pure-function coverage (unchanged behavior)
// ─────────────────────────────────────────────────────────────────────

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);
      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("blocks provisioning when the SSH environment issues no pairing token", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { pairingToken: null }),
        TARGET,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(calls).toEqual(["ensure"]);
    }),
  );

  it.effect("maps a cancelled preparation to an authentication block", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failEnsure: new Error("User cancelled the prompt") }),
        TARGET,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }),
  );

  it.effect("maps a non-cancel preparation failure to a transient error", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failEnsure: "boom" }),
        TARGET,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("propagates a bearer-session failure while preparing", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failBearer: true }),
        TARGET,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");
    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// connectionPlatformLayer — capability services and connection source
// ─────────────────────────────────────────────────────────────────────

describe("connectionPlatformLayer capabilities", () => {
  it.effect("builds the layer and exposes the platform capability services", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    return Effect.gen(function* () {
      const presentation = yield* ClientPresentation;
      expect(presentation.metadata.label).toBe("T4Code Desktop");
      expect(yield* ClientPresentation).toBeDefined();
      expect(yield* CloudSession).toBeDefined();
      expect(yield* PrimaryEnvironmentAuth).toBeDefined();
      expect(yield* SshEnvironmentGateway).toBeDefined();
      expect(yield* PlatformConnectionSource).toBeDefined();
      expect(yield* EnvironmentOwnedDataCleanup).toBeDefined();
      expect(yield* EnvironmentRpcRequestObserver).toBeDefined();
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("labels the web client and omits the os when the platform is blank", () => {
    stubBrowser({ platform: "" });
    return Effect.gen(function* () {
      const presentation = yield* ClientPresentation;
      expect(presentation.metadata.label).toBe("T4Code Web");
      expect("os" in presentation.metadata).toBe(false);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer cloud session token", () => {
  it.effect("blocks when no relay session is signed in", () => {
    stubBrowser();
    pf.session = null;
    return Effect.gen(function* () {
      const cloud = yield* CloudSession;
      const error = yield* cloud.clerkToken.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("returns the clerk token when the relay session yields one", () => {
    stubBrowser();
    pf.session = { readClerkToken: () => Effect.succeed("clerk-token") };
    return Effect.gen(function* () {
      const cloud = yield* CloudSession;
      expect(yield* cloud.clerkToken).toBe("clerk-token");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks when the relay session has no clerk token", () => {
    stubBrowser();
    pf.session = { readClerkToken: () => Effect.succeed(null) };
    return Effect.gen(function* () {
      const cloud = yield* CloudSession;
      const error = yield* cloud.clerkToken.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("maps a clerk token read failure to a transient error", () => {
    stubBrowser();
    pf.session = {
      readClerkToken: () => Effect.fail(new ReadClerkTokenError({ message: "network down" })),
    };
    return Effect.gen(function* () {
      const cloud = yield* CloudSession;
      const error = yield* cloud.clerkToken.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer primary bearer credential", () => {
  it.effect("wraps the desktop primary bearer token in an option", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.resolve("primary-bearer");
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      const token = yield* auth.bearerToken;
      expect(Option.isSome(token)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("reports no credential when the desktop returns null", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.resolve(null);
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      expect(Option.isNone(yield* auth.bearerToken)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("maps a desktop credential read rejection to a transient error", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.reject(new Error("keychain locked"));
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      const error = yield* auth.bearerToken.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer ssh gateway", () => {
  it.effect("provisions through the desktop bridge", () => {
    const bridge = makeBridge([]);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const provisioned = yield* ssh.provision(TARGET);
      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks provisioning when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh.provision(TARGET).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("prepares an SSH bearer session through the desktop bridge", () => {
    const bridge = makeBridge([]);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const prepared = yield* ssh.prepare(PREPARE_INPUT);
      expect(prepared.bearerToken).toBe("bearer-token");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks preparation when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh.prepare(PREPARE_INPUT).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks preparation when the bridge issues no pairing token", () => {
    const bridge = makeBridge([], { pairingToken: null });
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh.prepare(PREPARE_INPUT).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("disconnects through the desktop bridge when present", () => {
    const calls: string[] = [];
    const bridge = makeBridge(calls);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect(TARGET);
      expect(calls).toContain("disconnect");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("is a no-op disconnect when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect(TARGET);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("maps a disconnect failure to a transient error", () => {
    const bridge = makeBridge([], { failDisconnect: true });
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh.disconnect(TARGET).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer environment side effects", () => {
  it.effect("clears composer drafts for an environment", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const cleanup = yield* EnvironmentOwnedDataCleanup;
      yield* cleanup.clear(EnvironmentId.make("environment-x"));
      expect(pf.clearCalls).toContain("environment-x");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("tracks and acknowledges observed RPC requests", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const observer = yield* EnvironmentRpcRequestObserver;
      const acknowledge = yield* observer.observe({
        environmentId: EnvironmentId.make("environment-x"),
        method: "session.start",
      });
      expect(pf.trackCalls).toHaveLength(1);
      expect(pf.trackCalls[0]!.tag).toContain("session.start");
      yield* acknowledge;
      expect(pf.ackCalls).toHaveLength(1);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer connectivity and wakeups", () => {
  it.effect("reports the current network status and wires connectivity listeners", () => {
    const dom = makeDomStubs();
    return Effect.gen(function* () {
      const connectivity = yield* Connectivity.Connectivity;
      expect(yield* connectivity.status).toBe("online");

      const fiber = yield* Effect.forkChild(Stream.runDrain(connectivity.changes));
      yield* waitFor(() => dom.windowListeners("online").length > 0);
      expect(dom.windowListeners("offline").length).toBeGreaterThan(0);
      // Exercise both browser online/offline listener bodies.
      dom.fireWindow("online");
      dom.fireWindow("offline");
      yield* Fiber.interrupt(fiber);
      // The release finalizer removed the listeners.
      expect(dom.windowListeners("online").length).toBe(0);
      expect(dom.windowListeners("offline").length).toBe(0);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("wires a visibility-change wakeup listener and tears it down", () => {
    const dom = makeDomStubs();
    return Effect.gen(function* () {
      const wakeups = yield* Wakeups.ConnectionWakeups;
      const fiber = yield* Effect.forkChild(Stream.runDrain(wakeups.changes));
      yield* waitFor(() => dom.documentListeners("visibilitychange").length > 0);
      // Fire while visible so the listener enqueues an application-active wakeup.
      dom.fireDocument("visibilitychange");
      yield* Fiber.interrupt(fiber);
      expect(dom.documentListeners("visibilitychange").length).toBe(0);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

// ─────────────────────────────────────────────────────────────────────
// PlatformConnectionSource registrations stream
// ─────────────────────────────────────────────────────────────────────

describe("connectionPlatformLayer connection source", () => {
  it.effect("emits no registrations for the hosted static app", () => {
    pf.isHostedStatic = true;
    stubBrowser();
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const head = yield* Stream.runHead(source.registrations);
      expect(Option.isNone(head)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("polls the primary and desktop-local topology into registrations", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.primaryTarget = {
      source: "cli",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    };
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "wsl",
          label: "WSL: Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3202/",
          wsBaseUrl: "ws://127.0.0.1:3202/",
          bootstrapToken: "bootstrap-token",
        },
        {
          // A not-yet-ready desktop-local backend is skipped this poll.
          id: "pending",
          label: "",
          httpBaseUrl: null,
          wsBaseUrl: null,
          bootstrapToken: undefined,
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runHead(source.registrations.pipe(Stream.take(1))),
      );
      yield* TestClock.adjust("3 seconds");
      const head = yield* Fiber.join(fiber);
      expect(Option.isSome(head)).toBe(true);
      const registrations = Option.getOrThrow(head);
      // Primary (same-origin) + secondary (desktop-local bearer) registrations.
      expect(registrations.length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(Layer.mergeAll(connectionPlatformLayer, TestClock.layer())));
  });

  it.effect("logs and yields an empty batch when both topology reads fail", () => {
    stubBrowser();
    pf.isHostedStatic = false;
    pf.primaryTarget = new Error("invalid primary target");
    pf.secondaryRead = { _tag: "Failure", cause: new Error("IPC unavailable") };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runHead(source.registrations.pipe(Stream.take(1))),
      );
      yield* TestClock.adjust("3 seconds");
      const head = yield* Fiber.join(fiber);
      expect(Option.isSome(head)).toBe(true);
      // No primary target and a failed secondary read yields an empty batch.
      expect(Option.getOrThrow(head)).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(connectionPlatformLayer, TestClock.layer())));
  });
});
