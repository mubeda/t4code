// @vitest-environment happy-dom

import type {
  CheckpointDiffTarget,
  ComposerPathSearchTarget,
} from "@t4code/client-runtime/state/threads";
import type { VcsRefTarget } from "@t4code/client-runtime/state/vcs";
import type { VcsListRefsResult, VcsRef } from "@t4code/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Dispatch, SetStateAction } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type EffectCallback = () => void | (() => void);

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let stateSlots = new Map<number, unknown>();

  return {
    effects: [] as EffectCallback[],
    beginRender(): void {
      cursor = 0;
      this.effects = [];
    },
    reset(): void {
      cursor = 0;
      stateSlots = new Map();
      this.effects = [];
    },
    useCallback<T>(callback: T): T {
      cursor += 1;
      return callback;
    },
    useEffect(effect: EffectCallback): void {
      cursor += 1;
      hooks.effects.push(effect);
    },
    useMemo<T>(factory: () => T): T {
      cursor += 1;
      return factory();
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = cursor;
      cursor += 1;
      if (!stateSlots.has(index)) {
        stateSlots.set(
          index,
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        );
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = stateSlots.get(index) as T;
        stateSlots.set(
          index,
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue,
        );
      };
      return [stateSlots.get(index) as T, setValue];
    },
  };
});

interface QueryDescriptor {
  readonly kind: "fullThreadDiff" | "listRefs" | "searchEntries" | "turnDiff";
  readonly args: {
    readonly environmentId: string;
    readonly input: Readonly<Record<string, unknown>>;
  };
  readonly key: string;
}

interface QueryView {
  readonly data: unknown;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const testState = vi.hoisted(() => ({
  atomResults: new Map<string, unknown>(),
  queryDescriptors: [] as Array<QueryDescriptor | null>,
  queryViews: new Map<QueryDescriptor["kind"], QueryView>(),
  refreshedAtoms: [] as QueryDescriptor[],
  threadState: null as unknown as {
    data: Option.Option<unknown>;
    error: Option.Option<string>;
    status: string;
  },
}));

function descriptor(kind: QueryDescriptor["kind"], args: QueryDescriptor["args"]): QueryDescriptor {
  return {
    kind,
    args,
    key: `${kind}:${JSON.stringify(args)}`,
  };
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useState: hooks.useState,
  };
});

vi.mock("effect/unstable/reactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/unstable/reactivity")>();
  type Read = (get: (atom: QueryDescriptor) => unknown) => unknown;
  interface TestAtom {
    readonly read: Read;
    readonly label?: string;
    pipe: (...operations: Array<(atom: TestAtom) => TestAtom>) => TestAtom;
  }
  const make = (read: Read): TestAtom => {
    const atom: TestAtom = {
      read,
      pipe: (...operations) => operations.reduce((current, operation) => operation(current), atom),
    };
    return atom;
  };
  const withLabel =
    (label: string) =>
    (atom: TestAtom): TestAtom => ({ ...atom, label });
  return {
    ...actual,
    Atom: {
      ...actual.Atom,
      make,
      withLabel,
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { read: (get: (page: QueryDescriptor) => unknown) => unknown }) =>
    atom.read((page) => {
      if (!testState.atomResults.has(page.key)) {
        throw new Error(`Missing atom result for ${page.key}.`);
      }
      return testState.atomResults.get(page.key);
    }),
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    refresh: (atom: QueryDescriptor) => {
      testState.refreshedAtoms.push(atom);
    },
  },
}));

vi.mock("./threads", () => ({
  useEnvironmentThread: () => testState.threadState,
}));

vi.mock("./query", () => ({
  useEnvironmentQuery: (query: QueryDescriptor | null) => {
    testState.queryDescriptors.push(query);
    if (query === null) {
      return {
        data: null,
        error: null,
        isPending: false,
        refresh: vi.fn(),
      };
    }
    return (
      testState.queryViews.get(query.kind) ?? {
        data: null,
        error: null,
        isPending: false,
        refresh: vi.fn(),
      }
    );
  },
}));

vi.mock("./vcs", () => ({
  vcsEnvironment: {
    listRefs: (args: QueryDescriptor["args"]) => descriptor("listRefs", args),
  },
}));

vi.mock("./projects", () => ({
  projectEnvironment: {
    searchEntries: (args: QueryDescriptor["args"]) => descriptor("searchEntries", args),
  },
}));

vi.mock("./orchestration", () => ({
  orchestrationEnvironment: {
    fullThreadDiff: (args: QueryDescriptor["args"]) => descriptor("fullThreadDiff", args),
    turnDiff: (args: QueryDescriptor["args"]) => descriptor("turnDiff", args),
  },
}));

import {
  useBranches,
  useCheckpointDiff,
  useComposerPathSearch,
  usePaginatedBranches,
  useThreadDetail,
} from "./queries";

let captured: unknown;

function HookHarness({ run }: { readonly run: () => unknown }) {
  captured = run();
  return null;
}

function renderHook<A>(run: () => A): A {
  captured = undefined;
  hooks.beginRender();
  renderToStaticMarkup(createElement(HookHarness, { run }));
  return captured as A;
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const effect of hooks.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }
  }
  return cleanups;
}

function refsTarget(overrides: Partial<VcsRefTarget> = {}): VcsRefTarget {
  return {
    environmentId: "environment-1" as VcsRefTarget["environmentId"],
    cwd: "/repo",
    query: null,
    ...overrides,
  };
}

function searchTarget(overrides: Partial<ComposerPathSearchTarget> = {}): ComposerPathSearchTarget {
  return {
    environmentId: "environment-1" as ComposerPathSearchTarget["environmentId"],
    cwd: "/repo",
    query: "src",
    ...overrides,
  };
}

function checkpointTarget(overrides: Partial<CheckpointDiffTarget> = {}): CheckpointDiffTarget {
  return {
    environmentId: "environment-1" as CheckpointDiffTarget["environmentId"],
    threadId: "thread-1" as CheckpointDiffTarget["threadId"],
    fromTurnCount: 0,
    toTurnCount: 3,
    ignoreWhitespace: true,
    ...overrides,
  };
}

function ref(name: string, current = false): VcsRef {
  return {
    name,
    current,
    isDefault: name === "main",
    worktreePath: null,
  };
}

function page(
  refs: ReadonlyArray<VcsRef>,
  options: Partial<Omit<VcsListRefsResult, "refs">> = {},
): VcsListRefsResult {
  return {
    refs,
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: refs.length,
    ...options,
  };
}

function setPageResult(
  target: VcsRefTarget,
  cursor: number | undefined,
  result: unknown,
): QueryDescriptor {
  const query = target.query?.trim() ?? "";
  const input = {
    cwd: target.cwd!,
    ...(query.length > 0 ? { query } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    limit: 100,
  };
  const pageDescriptor = descriptor("listRefs", {
    environmentId: target.environmentId as string,
    input,
  });
  testState.atomResults.set(pageDescriptor.key, result);
  return pageDescriptor;
}

beforeEach(() => {
  hooks.reset();
  testState.atomResults.clear();
  testState.queryDescriptors = [];
  testState.queryViews.clear();
  testState.refreshedAtoms = [];
  testState.threadState = {
    data: Option.none(),
    error: Option.none(),
    status: "empty",
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useThreadDetail", () => {
  it.each([
    ["live", false, false],
    ["synchronizing", true, false],
    ["deleted", false, true],
  ] as const)("maps the %s thread status", (status, isPending, isDeleted) => {
    const thread = { id: "thread-1" };
    testState.threadState = {
      data: Option.some(thread),
      error: Option.some("sync warning"),
      status,
    };

    expect(renderHook(() => useThreadDetail(null, null))).toEqual({
      data: thread,
      error: "sync warning",
      isPending,
      isDeleted,
    });
  });

  it("maps absent thread data and errors to null", () => {
    expect(renderHook(() => useThreadDetail(null, null))).toEqual({
      data: null,
      error: null,
      isPending: false,
      isDeleted: false,
    });
  });
});

describe("useBranches", () => {
  it("disables the query until both target fields exist", () => {
    const view = renderHook(() => useBranches(refsTarget({ environmentId: null })));

    expect(testState.queryDescriptors).toEqual([null]);
    expect(view.data).toBeNull();
  });

  it.each([
    ["   ", { cwd: "/repo", limit: 100 }],
    ["  feature  ", { cwd: "/repo", query: "feature", limit: 100 }],
  ] as const)("normalizes the %j query", (query, expectedInput) => {
    const refresh = vi.fn();
    testState.queryViews.set("listRefs", {
      data: { refs: [] },
      error: null,
      isPending: false,
      refresh,
    });

    const view = renderHook(() => useBranches(refsTarget({ query })));

    expect(testState.queryDescriptors[0]).toMatchObject({
      kind: "listRefs",
      args: { environmentId: "environment-1", input: expectedInput },
    });
    expect(view.refresh).toBe(refresh);
  });
});

describe("usePaginatedBranches", () => {
  it("merges pages, preserves first-page flags, and suppresses duplicate cursors", () => {
    const target = refsTarget({ query: "  feat " });
    setPageResult(
      target,
      undefined,
      AsyncResult.success(
        page([ref("main", true), ref("feature")], {
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: 2,
          totalCount: 4,
        }),
      ),
    );
    setPageResult(
      target,
      2,
      AsyncResult.success(
        page([ref("feature", true), ref("release")], {
          isRepo: false,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 5,
        }),
      ),
    );

    const first = renderHook(() => usePaginatedBranches(target));
    first.loadNext();
    first.loadNext();
    const merged = renderHook(() => usePaginatedBranches(target));

    expect(merged.refs.map((item) => [item.name, item.current])).toEqual([
      ["main", true],
      ["feature", true],
      ["release", false],
    ]);
    expect(merged.data).toMatchObject({
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: null,
      totalCount: 5,
    });
    expect(merged.isPending).toBe(false);
  });

  it("reports pending pages and refreshes only the first page", () => {
    const target = refsTarget();
    const firstPage = setPageResult(
      target,
      undefined,
      AsyncResult.success(page([ref("main")], { nextCursor: 1, totalCount: 2 })),
    );
    setPageResult(target, 1, AsyncResult.initial(true));

    const first = renderHook(() => usePaginatedBranches(target));
    first.loadNext();
    const pending = renderHook(() => usePaginatedBranches(target));
    pending.refresh();
    const refreshed = renderHook(() => usePaginatedBranches(target));

    expect(pending.isPending).toBe(true);
    expect(testState.refreshedAtoms).toEqual([firstPage]);
    expect(refreshed.refs.map((item) => item.name)).toEqual(["main"]);
  });

  it.each([
    [Cause.fail(new Error("refs exploded")), "refs exploded"],
    [Cause.fail(new Error("")), "Failed to load refs."],
    [Cause.fail("opaque failure"), "Failed to load refs."],
  ] as const)("formats a failed page", (cause, expected) => {
    const target = refsTarget();
    setPageResult(target, undefined, AsyncResult.failure<never, unknown>(cause));

    const result = renderHook(() => usePaginatedBranches(target));

    expect(result.error).toBe(expected);
    expect(result.data).toBeNull();
    expect(result.refs).toEqual([]);
  });

  it("returns an inert view for an incomplete target", () => {
    const result = renderHook(() => usePaginatedBranches(refsTarget({ cwd: null })));

    result.loadNext();
    result.refresh();
    expect(result).toMatchObject({ data: null, refs: [], error: null, isPending: false });
    expect(testState.refreshedAtoms).toEqual([]);
  });
});

describe("useComposerPathSearch", () => {
  it("debounces a trimmed search and exposes the query result", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    testState.queryViews.set("searchEntries", {
      data: { entries: [{ path: "src/main.ts", kind: "file" }] },
      error: null,
      isPending: false,
      refresh,
    });

    const initial = renderHook(() => useComposerPathSearch(searchTarget({ query: "   " })));
    const cleanups = runEffects();
    const changed = renderHook(() => useComposerPathSearch(searchTarget({ query: "  src  " })));
    runEffects();

    expect(initial.entries).toEqual([]);
    expect(changed.isPending).toBe(true);
    expect(testState.queryDescriptors.at(-1)).toBeNull();

    vi.advanceTimersByTime(120);
    const settled = renderHook(() => useComposerPathSearch(searchTarget({ query: "  src  " })));

    expect(testState.queryDescriptors.at(-1)).toMatchObject({
      kind: "searchEntries",
      args: {
        environmentId: "environment-1",
        input: { cwd: "/repo", query: "src", limit: 80 },
      },
    });
    expect(settled).toEqual({
      entries: [{ path: "src/main.ts", kind: "file" }],
      error: null,
      isPending: false,
      refresh,
    });
    for (const cleanup of cleanups) cleanup();
  });

  it("cancels a superseded debounce timer", () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    renderHook(() => useComposerPathSearch(searchTarget({ query: "first" })));
    const [cleanup] = runEffects();
    cleanup!();

    renderHook(() => useComposerPathSearch(searchTarget({ query: "second" })));
    runEffects();
    vi.advanceTimersByTime(119);
    const pending = renderHook(() => useComposerPathSearch(searchTarget({ query: "second" })));

    expect(pending.isPending).toBe(true);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(testState.queryDescriptors.at(-1)).toMatchObject({
      kind: "searchEntries",
      args: { input: { query: "first" } },
    });

    vi.advanceTimersByTime(1);
    renderHook(() => useComposerPathSearch(searchTarget({ query: "second" })));
    expect(testState.queryDescriptors.at(-1)).toMatchObject({
      kind: "searchEntries",
      args: { input: { query: "second" } },
    });
  });

  it("disables searching when the environment or cwd is absent", () => {
    renderHook(() => useComposerPathSearch(searchTarget({ environmentId: null })));
    expect(testState.queryDescriptors).toEqual([null]);

    testState.queryDescriptors = [];
    hooks.reset();
    renderHook(() => useComposerPathSearch(searchTarget({ cwd: null })));
    expect(testState.queryDescriptors).toEqual([null]);
  });
});

describe("useCheckpointDiff", () => {
  it("selects the full-thread request for a zero turn count", () => {
    renderHook(() => useCheckpointDiff(checkpointTarget()));

    expect(testState.queryDescriptors).toEqual([
      {
        kind: "fullThreadDiff",
        key: expect.any(String),
        args: {
          environmentId: "environment-1",
          input: {
            threadId: "thread-1",
            toTurnCount: 3,
            ignoreWhitespace: true,
          },
        },
      },
      null,
    ]);
  });

  it("selects the bounded turn request for a nonzero turn count", () => {
    renderHook(() => useCheckpointDiff(checkpointTarget({ fromTurnCount: 1, toTurnCount: 4 })));

    expect(testState.queryDescriptors).toEqual([
      null,
      {
        kind: "turnDiff",
        key: expect.any(String),
        args: {
          environmentId: "environment-1",
          input: {
            threadId: "thread-1",
            fromTurnCount: 1,
            toTurnCount: 4,
            ignoreWhitespace: true,
          },
        },
      },
    ]);
  });

  it.each([
    [{ environmentId: null }, undefined],
    [{ threadId: null }, undefined],
    [{ fromTurnCount: null }, undefined],
    [{ toTurnCount: null }, undefined],
    [{}, { enabled: false }],
  ] as const)("disables incomplete or explicitly disabled requests", (overrides, options) => {
    renderHook(() => useCheckpointDiff(checkpointTarget(overrides), options));

    expect(testState.queryDescriptors).toEqual([null, null]);
  });
});
