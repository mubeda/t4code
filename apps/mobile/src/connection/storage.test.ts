import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  CredentialStore,
  ProfileStore,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, vi } from "vite-plus/test";

// ── In-memory secure store ────────────────────────────────────────────
const secure = vi.hoisted(() => {
  const values = new Map<string, string>();
  const state = { failGet: false, failSet: false, failDelete: false };
  return { values, state };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) =>
    secure.state.failGet
      ? Promise.reject(new Error("keychain get failed"))
      : Promise.resolve(secure.values.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    if (secure.state.failSet) {
      return Promise.reject(new Error("keychain set failed"));
    }
    secure.values.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    if (secure.state.failDelete) {
      return Promise.reject(new Error("keychain delete failed"));
    }
    secure.values.delete(key);
    return Promise.resolve();
  },
}));

// ── In-memory expo-file-system ────────────────────────────────────────
const fs = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const state = { textError: null as Error | null };
  return { files, dirs, state };
});

vi.mock("expo-file-system", () => {
  class Directory {
    readonly path: string;
    constructor(...segments: ReadonlyArray<string>) {
      this.path = segments.join("/");
    }
    get exists(): boolean {
      return fs.dirs.has(this.path);
    }
    create(_options?: unknown): void {
      fs.dirs.add(this.path);
    }
    delete(): void {
      fs.dirs.delete(this.path);
      const prefix = `${this.path}/`;
      for (const key of Array.from(fs.files.keys())) {
        if (key.startsWith(prefix)) {
          fs.files.delete(key);
        }
      }
    }
  }
  class File {
    readonly path: string;
    constructor(directory: Directory | string, name: string) {
      const base = typeof directory === "string" ? directory : directory.path;
      this.path = `${base}/${name}`;
    }
    get exists(): boolean {
      return fs.files.has(this.path);
    }
    create(_options?: unknown): void {
      if (!fs.files.has(this.path)) {
        fs.files.set(this.path, "");
      }
    }
    write(content: string): void {
      fs.files.set(this.path, content);
    }
    text(): Promise<string> {
      if (fs.state.textError) {
        return Promise.reject(fs.state.textError);
      }
      return Promise.resolve(fs.files.get(this.path) ?? "");
    }
    delete(): void {
      fs.files.delete(this.path);
    }
  }
  return { Directory, File, Paths: { document: "/doc" } };
});

import { connectionStorageLayer } from "./storage";
import {
  CONNECTION_CATALOG_KEY,
  LEGACY_CONNECTIONS_KEY,
  makeCatalogStore,
  type SecureCatalogStorage,
} from "./catalog-store";

// ── Fixtures ──────────────────────────────────────────────────────────
const ENV = EnvironmentId.make("environment-1");
const decodeOrchestrationShellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const decodeOrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread);

function relayRegistration(environmentId: EnvironmentId = ENV, label = "Relay env") {
  return new RelayConnectionRegistration({
    target: new RelayConnectionTarget({ environmentId, label }),
  });
}

function bearerRegistration(connectionId = "connection-1", environmentId: EnvironmentId = ENV) {
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label: "Bearer env", connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label: "Bearer profile",
      httpBaseUrl: "https://bearer.example/",
      wsBaseUrl: "wss://bearer.example/",
    }),
    credential: new BearerConnectionCredential({ token: "bearer-token" }),
  });
}

function bearerProfile(connectionId = "connection-1") {
  return new BearerConnectionProfile({
    connectionId,
    environmentId: ENV,
    label: "Bearer profile",
    httpBaseUrl: "https://bearer.example/",
    wsBaseUrl: "wss://bearer.example/",
  });
}

function dpopToken(environmentId: EnvironmentId = ENV) {
  return new TokenStore.RemoteDpopAccessToken({
    environmentId,
    label: "Relay token",
    endpoint: {
      httpBaseUrl: "https://relay.example/",
      wsBaseUrl: "wss://relay.example/",
      providerKind: "t3_relay",
    },
    accessToken: "access-token",
    expiresAtEpochMs: 1_800_000_000_000,
    dpopThumbprint: "thumbprint",
  });
}

const shellSnapshot: OrchestrationShellSnapshot = decodeOrchestrationShellSnapshot({
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-06-01T00:00:00.000Z",
});

function makeThread(id = "thread-1"): OrchestrationThread {
  return decodeOrchestrationThread({
    id,
    projectId: ProjectId.make("project-1"),
    title: "Thread title",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
}

beforeEach(() => {
  secure.values.clear();
  secure.state.failGet = false;
  secure.state.failSet = false;
  secure.state.failDelete = false;
  fs.files.clear();
  fs.dirs.clear();
  fs.state.textError = null;
});

describe("connectionStorageLayer fixtures", () => {
  it("decode a minimal orchestration thread standalone", () => {
    const thread = makeThread();
    expect(thread.id).toBe("thread-1");
    expect(thread.messages).toEqual([]);
    expect(shellSnapshot.projects).toEqual([]);
  });
});

describe("connectionStorageLayer targets and registrations", () => {
  it.effect("lists an empty catalog then reflects registered relay and bearer targets", () =>
    Effect.gen(function* () {
      const targetStore = yield* ConnectionTargetStore;
      const registrationStore = yield* ConnectionRegistrationStore;

      expect(yield* targetStore.list).toEqual([]);

      yield* registrationStore.register(relayRegistration());
      yield* registrationStore.register(bearerRegistration("connection-1"));
      const listed = yield* targetStore.list;
      expect(listed.map((target) => target.environmentId).sort()).toContain(ENV);
      expect(listed.some((target) => target._tag === "BearerConnectionTarget")).toBe(true);

      // Removing the bearer target drops it from the persisted catalog.
      yield* registrationStore.remove(
        new BearerConnectionTarget({
          environmentId: ENV,
          label: "Bearer env",
          connectionId: "connection-1",
        }),
      );
      const afterRemoval = yield* targetStore.list;
      expect(afterRemoval.some((target) => target._tag === "BearerConnectionTarget")).toBe(false);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("maps a secure-store read failure to a list-targets persistence error", () =>
    Effect.gen(function* () {
      secure.state.failGet = true;
      const targetStore = yield* ConnectionTargetStore;
      const error = yield* targetStore.list.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("list-targets");
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("maps a secure-store write failure to a register-connection persistence error", () =>
    Effect.gen(function* () {
      secure.state.failSet = true;
      const registrationStore = yield* ConnectionRegistrationStore;
      const error = yield* registrationStore.register(relayRegistration()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("register-connection");
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("maps a secure-store write failure to a remove-connection persistence error", () =>
    Effect.gen(function* () {
      secure.state.failSet = true;
      const registrationStore = yield* ConnectionRegistrationStore;
      const error = yield* registrationStore
        .remove(new RelayConnectionTarget({ environmentId: ENV, label: "Relay env" }))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("remove-connection");
    }).pipe(Effect.provide(connectionStorageLayer)),
  );
});

describe("connectionStorageLayer profiles, credentials, and tokens", () => {
  it.effect("stores and clears connection profiles", () =>
    Effect.gen(function* () {
      const profileStore = yield* ProfileStore.ConnectionProfileStore;

      expect(Option.isNone(yield* profileStore.get("connection-1"))).toBe(true);

      yield* profileStore.put(bearerProfile("connection-1"));
      const stored = yield* profileStore.get("connection-1");
      expect(Option.isSome(stored)).toBe(true);
      expect(Option.getOrThrow(stored).connectionId).toBe("connection-1");

      yield* profileStore.remove("connection-1");
      expect(Option.isNone(yield* profileStore.get("connection-1"))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("stores and clears connection credentials", () =>
    Effect.gen(function* () {
      const credentialStore = yield* CredentialStore.ConnectionCredentialStore;

      expect(Option.isNone(yield* credentialStore.get("connection-1"))).toBe(true);

      yield* credentialStore.put(
        "connection-1",
        new BearerConnectionCredential({ token: "secret" }),
      );
      const stored = yield* credentialStore.get("connection-1");
      expect(Option.isSome(stored)).toBe(true);
      expect(Option.getOrThrow(stored).token).toBe("secret");

      yield* credentialStore.remove("connection-1");
      expect(Option.isNone(yield* credentialStore.get("connection-1"))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("stores and clears remote dpop tokens", () =>
    Effect.gen(function* () {
      const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;

      expect(Option.isNone(yield* tokenStore.get(ENV))).toBe(true);

      yield* tokenStore.put(dpopToken());
      const stored = yield* tokenStore.get(ENV);
      expect(Option.isSome(stored)).toBe(true);
      expect(Option.getOrThrow(stored).accessToken).toBe("access-token");

      yield* tokenStore.remove(ENV);
      expect(Option.isNone(yield* tokenStore.get(ENV))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );
});

describe("connectionStorageLayer shell snapshot cache", () => {
  it.effect("returns none when no shell snapshot has been persisted", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      expect(Option.isNone(yield* cache.loadShell(ENV))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("round-trips a shell snapshot, overwriting an existing file", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;

      yield* cache.saveShell(ENV, shellSnapshot);
      const first = yield* cache.loadShell(ENV);
      expect(Option.isSome(first)).toBe(true);
      expect(Option.getOrThrow(first).snapshotSequence).toBe(0);

      // Saving again exercises the overwrite branch (file already exists).
      yield* cache.saveShell(ENV, shellSnapshot);
      expect(Option.isSome(yield* cache.loadShell(ENV))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("falls back to a legacy shell snapshot file", () =>
    Effect.gen(function* () {
      // Seed a legacy snapshot document as a raw JSON string literal.
      fs.files.set(
        "/doc/shell-snapshots/environment-1.json",
        '{"schemaVersion":1,"environmentId":"environment-1","snapshotReceivedAt":"2026-06-01T00:00:00.000Z","snapshot":{"snapshotSequence":3,"projects":[],"threads":[],"updatedAt":"2026-06-01T00:00:00.000Z"}}',
      );
      const cache = yield* EnvironmentCacheStore;
      const loaded = yield* cache.loadShell(ENV);
      expect(Option.isSome(loaded)).toBe(true);
      expect(Option.getOrThrow(loaded).snapshotSequence).toBe(3);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("maps a shell read failure to a load-shell persistence error", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      yield* cache.saveShell(ENV, shellSnapshot);
      fs.state.textError = new Error("read failed");
      const error = yield* cache.loadShell(ENV).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("load-shell");
    }).pipe(Effect.provide(connectionStorageLayer)),
  );
});

describe("connectionStorageLayer thread snapshot cache", () => {
  it.effect("returns none for a thread that has not been cached", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      expect(Option.isNone(yield* cache.loadThread(ENV, ThreadId.make("thread-1")))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("round-trips a thread snapshot and removes it", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      const thread = makeThread("thread-1");

      yield* cache.saveThread(ENV, thread);
      const loaded = yield* cache.loadThread(ENV, thread.id);
      expect(Option.isSome(loaded)).toBe(true);
      expect(Option.getOrThrow(loaded).id).toBe("thread-1");

      // Saving again exercises the overwrite branch.
      yield* cache.saveThread(ENV, thread);

      yield* cache.removeThread(ENV, thread.id);
      expect(Option.isNone(yield* cache.loadThread(ENV, thread.id))).toBe(true);

      // Removing a thread that is already gone is a no-op.
      yield* cache.removeThread(ENV, thread.id);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("maps a thread read failure to a load-thread persistence error", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      const thread = makeThread("thread-1");
      yield* cache.saveThread(ENV, thread);
      fs.state.textError = new Error("read failed");
      const error = yield* cache.loadThread(ENV, thread.id).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("load-thread");
    }).pipe(Effect.provide(connectionStorageLayer)),
  );
});

describe("connectionStorageLayer clear", () => {
  it.effect("clears the current file, legacy file, and thread directory for an environment", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;

      yield* cache.saveShell(ENV, shellSnapshot);
      yield* cache.saveThread(ENV, makeThread("thread-1"));
      fs.files.set(
        "/doc/shell-snapshots/environment-1.json",
        '{"schemaVersion":1,"environmentId":"environment-1","snapshotReceivedAt":"2026-06-01T00:00:00.000Z","snapshot":{"snapshotSequence":0,"projects":[],"threads":[],"updatedAt":"2026-06-01T00:00:00.000Z"}}',
      );
      fs.dirs.add("/doc/connection-thread-snapshots/environment-1");

      yield* cache.clear(ENV);

      expect(fs.files.has("/doc/connection-shell-snapshots/environment-1.json")).toBe(false);
      expect(fs.files.has("/doc/shell-snapshots/environment-1.json")).toBe(false);
      expect(fs.dirs.has("/doc/connection-thread-snapshots/environment-1")).toBe(false);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );

  it.effect("clears cleanly when nothing has been persisted", () =>
    Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      yield* cache.clear(ENV);
      expect(Option.isNone(yield* cache.loadShell(ENV))).toBe(true);
    }).pipe(Effect.provide(connectionStorageLayer)),
  );
});

// ── Pre-existing catalog-store coverage (retained) ────────────────────
function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage: SecureCatalogStorage = {
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    deleteItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  };
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* makeCatalogStore(memory.storage);

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* makeCatalogStore(memory.storage);

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* makeCatalogStore(memory.storage);

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
