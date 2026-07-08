import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { connectionStorageLayer, makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

// ── In-memory IndexedDB fake ─────────────────────────────────────────
// The production storage code attaches listeners *then* triggers the op, so
// the fake must fire events after the synchronous body has run — every
// request/transaction event is deferred through `queueMicrotask`.

type FaultMode = "none" | "get" | "put" | "cursor";

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }
  fire(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
}

class FakeTransaction {
  error: unknown = null;
  private readonly listeners = new Map<string, Array<() => void>>();
  constructor(
    private readonly store: Map<IDBValidKey, unknown>,
    private readonly fault: FaultMode,
  ) {}
  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }
  fire(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
  objectStore(_name: string) {
    return {
      get: (key: IDBValidKey) => {
        const request = new FakeRequest();
        queueMicrotask(() => {
          if (this.fault === "get") {
            request.error = new Error("boom-get");
            request.fire("error");
            return;
          }
          request.result = this.store.has(key) ? this.store.get(key) : undefined;
          request.fire("success");
        });
        return request;
      },
      put: (value: unknown, key: IDBValidKey) => {
        const request = new FakeRequest();
        queueMicrotask(() => {
          if (this.fault === "put") {
            this.error = new Error("boom-put");
            this.fire("error");
            return;
          }
          this.store.set(key, value);
          request.result = key;
          request.fire("success");
          this.fire("complete");
        });
        return request;
      },
      delete: (key: IDBValidKey) => {
        const request = new FakeRequest();
        queueMicrotask(() => {
          this.store.delete(key);
          request.fire("success");
          this.fire("complete");
        });
        return request;
      },
      openCursor: (range: { includes: (key: IDBValidKey) => boolean }) => {
        const request = new FakeRequest();
        queueMicrotask(() => {
          if (this.fault === "cursor") {
            request.error = new Error("boom-cursor");
            request.fire("error");
            return;
          }
          const keys = [...this.store.keys()]
            .filter((key) => range.includes(key))
            .sort() as IDBValidKey[];
          let index = 0;
          const step = () => {
            if (index >= keys.length) {
              request.result = null;
              request.fire("success");
              this.fire("complete");
              return;
            }
            const key = keys[index++]!;
            request.result = {
              delete: () => {
                this.store.delete(key);
              },
              continue: () => {
                queueMicrotask(step);
              },
            };
            request.fire("success");
          };
          step();
        });
        return request;
      },
    };
  }
}

interface FakeDatabaseHandle {
  readonly db: IDBDatabase;
  readonly stores: Map<string, Map<IDBValidKey, unknown>>;
}

function makeFakeDatabase(fault: FaultMode = "none"): FakeDatabaseHandle {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const ensure = (name: string) => {
    const existing = stores.get(name);
    if (existing) return existing;
    const created = new Map<IDBValidKey, unknown>();
    stores.set(name, created);
    return created;
  };
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      ensure(name);
      return {};
    },
    transaction: (storeName: string, _mode: string) =>
      new FakeTransaction(ensure(storeName), fault),
    close: () => undefined,
  } as unknown as IDBDatabase;
  return { db, stores };
}

type OpenMode = "success" | "error" | "undefined";

function installFakeIndexedDb(
  options: { open?: OpenMode; fault?: FaultMode } = {},
): FakeDatabaseHandle {
  const handle = makeFakeDatabase(options.fault ?? "none");
  const openMode = options.open ?? "success";
  if (openMode === "undefined") {
    vi.stubGlobal("indexedDB", undefined);
  } else {
    vi.stubGlobal("indexedDB", {
      open: (_name: string, _version: number) => {
        const request = new FakeRequest();
        queueMicrotask(() => {
          if (openMode === "error") {
            request.error = new Error("open-denied");
            request.fire("error");
            return;
          }
          request.result = handle.db;
          request.fire("upgradeneeded");
          request.fire("success");
        });
        return request;
      },
    });
  }
  vi.stubGlobal("IDBKeyRange", {
    bound: (lower: string, upper: string) => ({
      includes: (key: IDBValidKey) => typeof key === "string" && key >= lower && key <= upper,
    }),
  });
  vi.stubGlobal("window", {});
  return handle;
}

// ── Domain fixtures ──────────────────────────────────────────────────

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const connectionId = "connection-1";
const now = "2026-03-29T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" } as const;

function bearerRegistration(): BearerConnectionRegistration {
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId,
      label: "Bearer backend",
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label: "Bearer backend",
      httpBaseUrl: "http://127.0.0.1:3201/",
      wsBaseUrl: "ws://127.0.0.1:3201/",
    }),
    credential: new BearerConnectionCredential({ token: "bearer-token" }),
  });
}

function shellSnapshot(): OrchestrationShellSnapshot {
  return { snapshotSequence: 0, projects: [], threads: [], updatedAt: now };
}

function orchestrationThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Demo Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as OrchestrationThread;
}

const remoteToken = new TokenStore.RemoteDpopAccessToken({
  environmentId,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://relay.example/",
    wsBaseUrl: "wss://relay.example/",
    providerKind: "t3_relay",
  },
  accessToken: "remote-access-token",
  expiresAtEpochMs: 1_000,
  dpopThumbprint: "thumb",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// makeCatalogStore
// ─────────────────────────────────────────────────────────────────────

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );

  it.effect("reads an empty document when the backend has no stored catalog", () =>
    Effect.gen(function* () {
      let reads = 0;
      const store = yield* makeCatalogStore({
        read: Effect.sync(() => {
          reads += 1;
          return null;
        }),
        write: () => Effect.void,
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      // The second read is served from the in-memory cache without re-reading.
      expect(yield* store.read).toEqual(emptyCatalog);
      expect(reads).toBe(1);
    }),
  );

  it.effect("treats a blank stored catalog as empty", () =>
    Effect.gen(function* () {
      const store = yield* makeCatalogStore({
        read: Effect.succeed("   "),
        write: () => Effect.void,
      });

      expect(yield* store.read).toEqual(emptyCatalog);
    }),
  );

  it.effect("update transforms, encodes, persists, and caches the next document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed(null),
        write: (raw) => Effect.sync(() => writes.push(raw)),
      });

      yield* store.update((document) => ({
        ...document,
        profiles: [bearerRegistration().profile],
      }));

      expect(writes).toHaveLength(1);
      const persisted = decodeCatalog(writes[0]!);
      expect(persisted.profiles).toHaveLength(1);
      // The cached document reflects the update without another backend read.
      const cached = yield* store.read;
      expect(cached.profiles).toHaveLength(1);
    }),
  );

  it.effect("decodes and caches a well-formed stored catalog", () => {
    const encoded = encodeCatalog(emptyCatalog);
    return Effect.gen(function* () {
      let reads = 0;
      const store = yield* makeCatalogStore({
        read: Effect.sync(() => {
          reads += 1;
          return encoded;
        }),
        write: () => Effect.void,
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      yield* store.read;
      expect(reads).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// makeCatalogBackend
// ─────────────────────────────────────────────────────────────────────

describe("makeCatalogBackend (desktop bridge)", () => {
  it.effect("reads and writes through the desktop bridge secure storage", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(true);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue("stored-catalog"),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      expect(yield* backend.read).toBe("stored-catalog");
      yield* backend.write("payload");
      expect(setConnectionCatalog).toHaveBeenCalledWith("payload");
      // The bridge backend does not expose a quarantine seam.
      expect(backend.quarantine).toBeUndefined();
    }),
  );

  it.effect("maps desktop bridge read rejections to a transient error", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockRejectedValue(new Error("locked")),
          setConnectionCatalog: vi.fn().mockResolvedValue(true),
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.read.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("load the local connection catalog");
    }),
  );

  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("makeCatalogBackend (IndexedDB)", () => {
  it.effect("reads null when the catalog store is empty, then round-trips a write", () =>
    Effect.gen(function* () {
      const handle = installFakeIndexedDb();
      const backend = makeCatalogBackend(handle.db);

      expect(yield* backend.read).toBeNull();
      yield* backend.write("catalog-json");
      expect(yield* backend.read).toBe("catalog-json");

      yield* backend.quarantine!("corrupt-json");
      const catalogStore = handle.stores.get("catalog")!;
      const quarantineKey = [...catalogStore.keys()].find(
        (key) => typeof key === "string" && key.startsWith("document:corrupt:"),
      );
      expect(quarantineKey).toBeDefined();
    }),
  );

  it.effect("maps IndexedDB read failures to a transient error", () =>
    Effect.gen(function* () {
      const handle = installFakeIndexedDb({ fault: "get" });
      const backend = makeCatalogBackend(handle.db);

      const error = yield* backend.read.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("maps IndexedDB write failures to a transient error", () =>
    Effect.gen(function* () {
      const handle = installFakeIndexedDb({ fault: "put" });
      const backend = makeCatalogBackend(handle.db);

      const error = yield* backend.write("payload").pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────
// connectionStorageLayer (end-to-end over the fake IndexedDB)
// ─────────────────────────────────────────────────────────────────────

describe("connectionStorageLayer", () => {
  it.effect("registers, reads, updates, and removes catalog-backed stores", () => {
    installFakeIndexedDb();
    return Effect.gen(function* () {
      const targetStore = yield* ConnectionTargetStore;
      const registrationStore = yield* ConnectionRegistrationStore;
      const profileStore = yield* ProfileStore.ConnectionProfileStore;
      const credentialStore = yield* CredentialStore.ConnectionCredentialStore;
      const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;

      expect(yield* targetStore.list).toEqual([]);
      expect(Option.isNone(yield* profileStore.get(connectionId))).toBe(true);
      expect(Option.isNone(yield* credentialStore.get(connectionId))).toBe(true);
      expect(Option.isNone(yield* tokenStore.get(environmentId))).toBe(true);

      yield* registrationStore.register(bearerRegistration());

      const targets = yield* targetStore.list;
      expect(targets).toHaveLength(1);
      expect(targets[0]!.environmentId).toBe(environmentId);
      expect(Option.isSome(yield* profileStore.get(connectionId))).toBe(true);
      expect(Option.isSome(yield* credentialStore.get(connectionId))).toBe(true);

      // Remote DPoP token round-trip.
      yield* tokenStore.put(remoteToken);
      const token = yield* tokenStore.get(environmentId);
      expect(Option.isSome(token)).toBe(true);
      yield* tokenStore.remove(environmentId);
      expect(Option.isNone(yield* tokenStore.get(environmentId))).toBe(true);

      // Direct profile/credential mutation seams.
      yield* profileStore.put(bearerRegistration().profile);
      expect(Option.isSome(yield* profileStore.get(connectionId))).toBe(true);
      yield* profileStore.remove(connectionId);
      expect(Option.isNone(yield* profileStore.get(connectionId))).toBe(true);
      yield* credentialStore.put(connectionId, new BearerConnectionCredential({ token: "t2" }));
      expect(Option.isSome(yield* credentialStore.get(connectionId))).toBe(true);
      yield* credentialStore.remove(connectionId);
      expect(Option.isNone(yield* credentialStore.get(connectionId))).toBe(true);

      yield* registrationStore.remove(bearerRegistration().target);
      expect(yield* targetStore.list).toEqual([]);
    }).pipe(Effect.provide(connectionStorageLayer));
  });

  it.effect("persists and restores shell and thread snapshots", () => {
    installFakeIndexedDb();
    return Effect.gen(function* () {
      const cacheStore = yield* EnvironmentCacheStore;

      expect(Option.isNone(yield* cacheStore.loadShell(environmentId))).toBe(true);
      yield* cacheStore.saveShell(environmentId, shellSnapshot());
      const shell = yield* cacheStore.loadShell(environmentId);
      expect(Option.isSome(shell)).toBe(true);

      expect(Option.isNone(yield* cacheStore.loadThread(environmentId, threadId))).toBe(true);
      yield* cacheStore.saveThread(environmentId, orchestrationThread());
      const thread = yield* cacheStore.loadThread(environmentId, threadId);
      expect(Option.isSome(thread)).toBe(true);

      // A thread cached under a different environment is not returned.
      expect(Option.isNone(yield* cacheStore.loadThread(otherEnvironmentId, threadId))).toBe(true);

      yield* cacheStore.removeThread(environmentId, threadId);
      expect(Option.isNone(yield* cacheStore.loadThread(environmentId, threadId))).toBe(true);

      // Repopulate, then clear the whole environment (shell + thread range).
      yield* cacheStore.saveShell(environmentId, shellSnapshot());
      yield* cacheStore.saveThread(environmentId, orchestrationThread());
      yield* cacheStore.clear(environmentId);
      expect(Option.isNone(yield* cacheStore.loadShell(environmentId))).toBe(true);
      expect(Option.isNone(yield* cacheStore.loadThread(environmentId, threadId))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer));
  });

  it.effect("fails to build when IndexedDB is unavailable", () => {
    installFakeIndexedDb({ open: "undefined" });
    return ConnectionTargetStore.pipe(
      Effect.provide(connectionStorageLayer),
      Effect.flip,
      Effect.asVoid,
    );
  });

  it.effect("fails to build when the database open request errors", () => {
    installFakeIndexedDb({ open: "error" });
    return ConnectionTargetStore.pipe(
      Effect.provide(connectionStorageLayer),
      Effect.flip,
      Effect.asVoid,
    );
  });
});
