# Center Terminal Close Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every center-panel terminal dismissal closes the matching backend terminal session and provider CLI process while preserving the existing chat-panel lifecycle.

**Architecture:** Keep `centerPanelStore` and `useCenterPanelActions` responsible for persisted surface state and chat-thread deletion. Add terminal-aware dismissal handlers in `ChatView`, where terminal RPC commands, terminal UI state, and scheduler cleanup already live. Each handler will calculate the surfaces it removes, deduplicate their terminal identifiers, optimistically remove them from terminal UI state, invoke `terminal.close` with history deletion, and release the input scheduler only after a successful response.

**Tech Stack:** React 19, TypeScript, Zustand, Effect `AsyncResult`, Vite+, Tauri 2, Vitest-compatible Vite+ tests.

## Global Constraints

- Follow `/Users/admin/.codex/worktrees/44f9/t4code/AGENTS.md`.
- Do not add process or RPC dependencies to `centerPanelStore` or `useCenterPanelActions`.
- Preserve the existing optimistic-close behavior used by right-panel terminals.
- Preserve the existing chat-panel deletion behavior by delegating surface mutations to `useCenterPanelActions`.
- Issue at most one `terminal.close` call per terminal identifier in one dismissal operation.
- Before completion, `vp test`, `vp check`, and `vp run typecheck` must pass.
- The final regression check must use the packaged macOS app and verify the provider process exits.

---

## Task 1: Add failing center-terminal lifecycle tests

**Files:**

- Modify: `apps/web/src/components/ChatView.hooks.test.tsx:787`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx:3508`

- [ ] **Step 1: Add a small terminal-close assertion helper**

Immediately after `commandCallsFor`, add a helper that extracts terminal IDs without weakening the command-input type checks:

```ts
function closedTerminalIds(): string[] {
  return commandCallsFor("terminal.close").map((call) => {
    const command = call.input as {
      environmentId: EnvironmentId;
      input: {
        threadId: ThreadId;
        terminalId: string;
        deleteHistory: boolean;
      };
    };
    expect(command.environmentId).toBe(environmentId);
    expect(command.input.threadId).toBe(threadId);
    expect(command.input.deleteHistory).toBe(true);
    return command.input.terminalId;
  });
}
```

- [ ] **Step 2: Strengthen the existing single-tab-close regression test**

Rename the test to `closes a center terminal session when its tab is closed`, retain its current surface-removal assertion, and add:

```ts
expect(closedTerminalIds()).toEqual(["terminal-42"]);
```

This is the smallest reproduction of the live defect: before the production fix, the surface disappears but `closedTerminalIds()` returns `[]`.

- [ ] **Step 3: Add coverage for the terminal panel's internal close control**

Add a fresh test that makes a center terminal active, invokes the captured `CenterTerminalPanel.onClose`, and checks both layers of lifecycle state:

```ts
it("closes a center terminal session from the panel close control", () => {
  seedConnectedServerThread();
  useCenterPanelStore.getState().openTerminalPanel(threadRef, "terminal-panel");
  publishSeededStoreState(useCenterPanelStore);
  renderServerRoute();

  const panel = capturedProps("centerTerminalPanel");
  (panel["onClose"] as () => void)();

  expect(closedTerminalIds()).toEqual(["terminal-panel"]);
  expect(
    useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.some((surface) => surface.id === "terminal:terminal-panel") ??
      false,
  ).toBe(false);
});
```

- [ ] **Step 4: Add exact bulk-dismissal coverage**

Add three independent tests so each handler reads a fresh store snapshot:

```ts
it("closes only removed center terminals when closing other surfaces", () => {
  seedConnectedServerThread();
  for (const terminalId of ["terminal-left", "terminal-kept", "terminal-right"]) {
    useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
  }
  publishSeededStoreState(useCenterPanelStore);
  renderServerRoute();

  const tabs = capturedProps("centerPanelTabs");
  const kept = useCenterPanelStore
    .getState()
    .byThreadKey[threadKey]!.surfaces.find(
      (surface) => surface.id === "terminal:terminal-kept",
    )!;
  (tabs["onCloseOtherSurfaces"] as (surface: typeof kept) => void)(kept);

  expect(closedTerminalIds()).toEqual(["terminal-left", "terminal-right"]);
  expect(
    useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.map((surface) => surface.id),
  ).toEqual([HOST_SURFACE_ID, "terminal:terminal-kept"]);
});

it("closes only center terminals to the right of the selected surface", () => {
  seedConnectedServerThread();
  for (const terminalId of ["terminal-left", "terminal-middle", "terminal-right"]) {
    useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
  }
  publishSeededStoreState(useCenterPanelStore);
  renderServerRoute();

  const tabs = capturedProps("centerPanelTabs");
  const selected = useCenterPanelStore
    .getState()
    .byThreadKey[threadKey]!.surfaces.find(
      (surface) => surface.id === "terminal:terminal-left",
    )!;
  (tabs["onCloseSurfacesToRight"] as (surface: typeof selected) => void)(selected);

  expect(closedTerminalIds()).toEqual(["terminal-middle", "terminal-right"]);
  expect(
    useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.map((surface) => surface.id),
  ).toEqual([HOST_SURFACE_ID, "terminal:terminal-left"]);
});

it("closes every center terminal when closing all surfaces", () => {
  seedConnectedServerThread();
  for (const terminalId of ["terminal-one", "terminal-two"]) {
    useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
  }
  publishSeededStoreState(useCenterPanelStore);
  renderServerRoute();

  const tabs = capturedProps("centerPanelTabs");
  (tabs["onCloseAllSurfaces"] as () => void)();

  expect(closedTerminalIds()).toEqual(["terminal-one", "terminal-two"]);
  expect(useCenterPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toEqual([]);
});
```

Add `HOST_SURFACE_ID` to the existing `centerPanelStore` test import if it is not already imported.

- [ ] **Step 5: Prove chat-only dismissals do not invoke terminal shutdown**

```ts
it("does not close a terminal when dismissing a center chat surface", () => {
  seedConnectedServerThread();
  const siblingThreadId = ThreadId.make("center-chat-only");
  useCenterPanelStore.getState().openChatPanel(threadRef, siblingThreadId, "Codex");
  publishSeededStoreState(useCenterPanelStore);
  renderServerRoute();

  const tabs = capturedProps("centerPanelTabs");
  const chatSurface = useCenterPanelStore
    .getState()
    .byThreadKey[threadKey]!.surfaces.find((surface) => surface.kind === "chat")!;
  (tabs["onCloseSurface"] as (surface: typeof chatSurface) => void)(chatSurface);

  expect(commandCallsFor("terminal.close")).toHaveLength(0);
  expect(commandCallsFor("thread.delete")).toHaveLength(1);
});
```

- [ ] **Step 6: Run the focused tests and confirm RED for the intended reason**

Run:

```bash
vp test apps/web/src/components/ChatView.hooks.test.tsx -t "center"
```

Expected: the new terminal lifecycle assertions fail because no `terminal.close` command is recorded. The chat-only assertion continues to pass. Do not modify production code until this failure is observed.

- [ ] **Step 7: Commit the failing regression tests**

```bash
git add apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "test(web): cover center terminal shutdown lifecycle"
```

---

## Task 2: Route every center dismissal through terminal cleanup

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx:125`
- Modify: `apps/web/src/components/ChatView.tsx:1333`
- Modify: `apps/web/src/components/ChatView.tsx:5121`
- Modify: `apps/web/src/components/ChatView.tsx:5341`

- [ ] **Step 1: Import the center-surface union**

Update the center-panel store import:

```ts
import {
  type CenterSurface,
  HOST_SURFACE_ID,
  selectThreadCenterPanelState,
  type OpenTerminalPanelOptions,
  useCenterPanelStore,
} from "../centerPanelStore";
```

- [ ] **Step 2: Add the shared cleanup callback beside center-panel state**

After calculating `centerPanelState`, add:

```ts
const cleanupCenterPanelSurfaces = useCallback(
  (surfaces: readonly CenterSurface[]) => {
    if (!activeThreadRef) return;
    const terminalIds = new Set(
      surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? [surface.terminalId] : [],
      ),
    );

    for (const terminalId of terminalIds) {
      storeCloseTerminal(activeThreadRef, terminalId);
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Success") {
          releaseTerminalInputScheduler(
            activeThreadRef.environmentId,
            activeThreadRef.threadId,
            terminalId,
          );
        }
      })();
    }
  },
  [activeThreadRef, closeTerminalMutation, storeCloseTerminal],
);
```

This mirrors `cleanupRightPanelSurfaces`: UI cleanup is immediate, the RPC is fire-and-forget, and scheduler cleanup follows only a successful close response.

- [ ] **Step 3: Add one handler per center dismissal semantic**

Place these callbacks after `cleanupCenterPanelSurfaces`:

```ts
const closeCenterPanelSurface = useCallback(
  (surface: CenterSurface) => {
    if (!activeThreadRef) return;
    cleanupCenterPanelSurfaces([surface]);
    centerPanelActions.closeSurface(activeThreadRef, surface);
  },
  [activeThreadRef, centerPanelActions, cleanupCenterPanelSurfaces],
);

const closeOtherCenterPanelSurfaces = useCallback(
  (surface: CenterSurface) => {
    if (!activeThreadRef) return;
    const keptIds = new Set([HOST_SURFACE_ID, surface.id]);
    cleanupCenterPanelSurfaces(
      centerPanelState.surfaces.filter((entry) => !keptIds.has(entry.id)),
    );
    centerPanelActions.closeOtherSurfaces(activeThreadRef, surface);
  },
  [
    activeThreadRef,
    centerPanelActions,
    centerPanelState.surfaces,
    cleanupCenterPanelSurfaces,
  ],
);

const closeCenterPanelSurfacesToRight = useCallback(
  (surface: CenterSurface) => {
    if (!activeThreadRef) return;
    const surfaceIndex = centerPanelState.surfaces.findIndex(
      (entry) => entry.id === surface.id,
    );
    if (surfaceIndex < 0) return;
    cleanupCenterPanelSurfaces(centerPanelState.surfaces.slice(surfaceIndex + 1));
    centerPanelActions.closeSurfacesToRight(activeThreadRef, surface);
  },
  [
    activeThreadRef,
    centerPanelActions,
    centerPanelState.surfaces,
    cleanupCenterPanelSurfaces,
  ],
);

const closeAllCenterPanelSurfaces = useCallback(() => {
  if (!activeThreadRef) return;
  cleanupCenterPanelSurfaces(centerPanelState.surfaces);
  centerPanelActions.closeAllSurfaces(activeThreadRef);
}, [
  activeThreadRef,
  centerPanelActions,
  centerPanelState.surfaces,
  cleanupCenterPanelSurfaces,
]);
```

The `HOST_SURFACE_ID` exception in close-others matches `useCenterPanelActions.closeOtherSurfaces`; it must not accidentally close a terminal merely because the host is also retained.

- [ ] **Step 4: Replace the tab strip's direct store-action callbacks**

Update `CenterPanelTabs`:

```tsx
<CenterPanelTabs
  surfaces={centerPanelState.surfaces}
  activeSurfaceId={centerPanelState.activeSurfaceId}
  onActivate={(surface) =>
    centerPanelActions.activateSurface(activeThreadRef, surface.id)
  }
  onCloseSurface={closeCenterPanelSurface}
  onCloseOtherSurfaces={closeOtherCenterPanelSurfaces}
  onCloseSurfacesToRight={closeCenterPanelSurfacesToRight}
  onCloseAllSurfaces={closeAllCenterPanelSurfaces}
/>
```

- [ ] **Step 5: Reuse single-close for the terminal panel's internal control**

Update `CenterTerminalPanel`:

```tsx
<CenterTerminalPanel
  key={activeCenterSurface.id}
  threadRef={activeThreadRef}
  surface={activeCenterSurface}
  keybindings={keybindings}
  focusRequestId={terminalFocusRequestId}
  onAddTerminalContext={addTerminalContextToDraft}
  onClose={() => closeCenterPanelSurface(activeCenterSurface)}
/>
```

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
vp test apps/web/src/components/ChatView.hooks.test.tsx -t "center"
```

Expected: every focused center-panel lifecycle test passes.

- [ ] **Step 7: Run the complete ChatView hook suite**

Run:

```bash
vp test apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: the full file passes with no regressions in drawer or right-panel terminal behavior.

- [ ] **Step 8: Commit the implementation**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "fix(web): close center terminal sessions"
```

---

## Task 3: Verify repository quality gates

**Files:**

- No expected source changes.

- [ ] **Step 1: Run the complete test suite**

```bash
vp test
```

Expected: exit code `0`.

- [ ] **Step 2: Run repository checks**

```bash
vp check
```

Expected: exit code `0`.

- [ ] **Step 3: Run TypeScript validation**

```bash
vp run typecheck
```

Expected: exit code `0`.

- [ ] **Step 4: Inspect the final diff and worktree state**

```bash
git diff HEAD~2 --check
git status --short
```

Expected: no whitespace errors and no uncommitted implementation changes.

---

## Task 4: Re-run the packaged macOS regression test

**Files:**

- Generated app bundle only; do not commit build artifacts.

- [ ] **Step 1: Build the UI-test application bundle**

Run:

```bash
T4CODE_E2E_BUNDLE=app vp run test:ui:desktop:build
```

Expected: the packaged macOS test application builds successfully.

- [ ] **Step 2: Establish a clean baseline**

Launch the packaged app, open the existing T4Code task for
`/Users/admin/.codex/worktrees/44f9/t4code`, and record:

- the terminal count shown in the app;
- the absence of a provider CLI child process for the terminal about to be launched.

- [ ] **Step 3: Launch a provider terminal from the toolbar menu**

Open the toolbar action menu and choose **Codex Terminal**. Verify:

- a center terminal tab appears;
- the provider process command is
  `codex --dangerously-bypass-approvals-and-sandbox`;
- the process current working directory is
  `/Users/admin/.codex/worktrees/44f9/t4code`;
- the terminal count increases by one.

- [ ] **Step 4: Close the provider terminal tab and poll for lifecycle completion**

Click the center tab's close control. Poll process state and the app status instead of relying on a fixed delay.

Expected:

- the center terminal surface disappears;
- the provider CLI child process exits;
- the terminal count returns to its baseline value.

- [ ] **Step 5: Exercise the internal close control**

Launch **Codex Terminal** again and use the terminal panel's own **Close Terminal** action.

Expected: the same three outcomes from Step 4.

- [ ] **Step 6: Save concise evidence**

Capture one post-close screenshot showing the absent terminal surface and baseline terminal count. Record the observed PID and exit result in the final handoff.

---

## Task 5: Final review and handoff

**Files:**

- Review: `apps/web/src/components/ChatView.tsx`
- Review: `apps/web/src/components/ChatView.hooks.test.tsx`

- [ ] **Step 1: Review against the approved design**

Confirm:

- tab close and internal close share one handler;
- close others, close to right, and close all clean exactly their removed terminal surfaces;
- chat-only close still delegates to the existing chat deletion lifecycle;
- no RPC or terminal state dependency was added to `centerPanelStore` or `centerPanelActions`;
- terminal close input includes `deleteHistory: true`;
- scheduler release is success-only;
- per-operation terminal IDs are deduplicated.

- [ ] **Step 2: Request code review**

Use `superpowers:requesting-code-review` and address any correctness findings before completion.

- [ ] **Step 3: Verify again before claiming completion**

Use `superpowers:verification-before-completion` and cite fresh outputs for:

- focused lifecycle tests;
- `vp test`;
- `vp check`;
- `vp run typecheck`;
- packaged macOS provider-process shutdown.

- [ ] **Step 4: Report the outcome**

Lead with the fixed lifecycle behavior, identify the two source files changed, list the verification evidence, and link the macOS screenshot artifact.
