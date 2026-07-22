# Workspace Picker Folder Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create a directory on the selected T4Code host from the **Select Workspace folder** dialog, enter it, and select it.

**Architecture:** Reuse the existing `projectEnvironment.createEntry` command and server-side `WorkspaceService::create_entry` validation. Add one shared host-path join helper for Windows, UNC, and POSIX paths, then add an inline name editor to the existing remote picker; successful creation changes the browse target so the normal filesystem browse query canonicalizes the new location.

**Tech Stack:** React 19, TypeScript, Effect Atom command results, shared path utilities, Vite+ test, happy-dom.

## Global Constraints

- Creation targets the selected host through `environmentId`.
- Creation targets the picker's current canonical `directoryPath`, never the local desktop filesystem.
- Reuse `projects.createEntry`; do not add a second filesystem-create RPC.
- Successful creation enters the created folder.
- The server remains authoritative for invalid names, collisions, permissions, traversal, and symlink boundaries.
- Do not optimistically insert a folder row before server success.
- Empty names are disabled; duplicate submission is blocked while pending.
- Enter creates and Escape cancels the inline editor.
- Use TDD.
- `vp check` and `vp run typecheck` must pass before completion.

## File Structure

- Modify `packages/shared/src/path.ts`: add a browser-safe `joinHostPath` helper.
- Modify `packages/shared/src/path.test.ts`: Windows drive, UNC, POSIX, separator normalization, and root coverage.
- Modify `apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx`: inline editor and remote mutation command.
- Modify `apps/web/src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx`: real React interaction, success, failure, pending, and host routing.
- Modify `apps/web/src/components/settings/RemoteDirectoryPickerDialog.test.tsx`: static layout/mocking coverage for the new controls.

---

### Task 1: Add one shared host-aware path join

**Files:**
- Modify: `packages/shared/src/path.ts`
- Modify: `packages/shared/src/path.test.ts`

**Interfaces:**
- Produces: `joinHostPath(base: string, relativePath: string): string` from the existing `@t4code/shared/path` subpath.
- Consumes later: the picker joins canonical current directory and server-returned normalized relative path.

- [ ] **Step 1: Write failing path tests**

Add to `packages/shared/src/path.test.ts`:

```ts
import { joinHostPath } from "./path";

describe("joinHostPath", () => {
  it("joins Windows drive paths with Windows separators", () => {
    expect(joinHostPath("X:\\Workspaces\\t4code", "new-folder")).toBe(
      "X:\\Workspaces\\t4code\\new-folder",
    );
    expect(joinHostPath("X:\\", "new-folder")).toBe("X:\\new-folder");
    expect(joinHostPath("X:\\", "")).toBe("X:\\");
  });

  it("joins UNC roots without losing the leading share marker", () => {
    expect(joinHostPath("\\\\server\\share\\", "team/new-folder")).toBe(
      "\\\\server\\share\\team\\new-folder",
    );
  });

  it("joins POSIX roots and normalizes relative separators", () => {
    expect(joinHostPath("/srv/projects", "team\\new-folder")).toBe(
      "/srv/projects/team/new-folder",
    );
    expect(joinHostPath("/", "new-folder")).toBe("/new-folder");
  });

  it("returns the normalized base for an empty or dot relative path", () => {
    expect(joinHostPath("/srv/projects/", "")).toBe("/srv/projects");
    expect(joinHostPath("X:\\Workspaces\\", ".")).toBe("X:\\Workspaces");
  });
});
```

- [ ] **Step 2: Run the shared-path test and confirm RED**

```powershell
corepack pnpm --filter @t4code/shared exec vp test run src/path.test.ts
```

Expected: FAIL because `joinHostPath` is not exported.

- [ ] **Step 3: Implement `joinHostPath`**

Add to `packages/shared/src/path.ts`:

```ts
export function joinHostPath(base: string, relativePath: string): string {
  const separator: "/" | "\\" = isWindowsAbsolutePath(base) || base.includes("\\") ? "\\" : "/";
  const isPosixRoot = base === "/";
  const isWindowsDriveRoot = /^[a-zA-Z]:[\\/]*$/.test(base);
  const normalizedBase = isPosixRoot
    ? "/"
    : isWindowsDriveRoot
      ? `${base.slice(0, 2)}\\`
      : base.replace(/[\\/]+$/, "");
  const segments = relativePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return normalizedBase;
  if (normalizedBase === "/") return `/${segments.join("/")}`;
  if (isWindowsDriveRoot) return `${normalizedBase}${segments.join("\\")}`;
  return [normalizedBase, ...segments].join(separator);
}
```

Do not interpret `..`; the server rejects unsafe relative paths. This helper only composes a server-returned normalized relative path for the next browse request.

- [ ] **Step 4: Run shared-path tests and confirm GREEN**

```powershell
corepack pnpm --filter @t4code/shared exec vp test run src/path.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared path helper**

```powershell
git add packages/shared/src/path.ts packages/shared/src/path.test.ts
git commit -m "feat(shared): join remote host paths"
```

### Task 2: Add inline remote folder creation to the picker

**Files:**
- Modify: `apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx`
- Modify: `apps/web/src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx`
- Modify: `apps/web/src/components/settings/RemoteDirectoryPickerDialog.test.tsx`

**Interfaces:**
- Consumes: `joinHostPath`, `projectEnvironment.createEntry`, `useAtomCommand`, `isAtomCommandInterrupted`, `squashAtomCommandFailure`.
- Produces: **New folder** → inline editor → create → new browse target.

- [ ] **Step 1: Extend the runtime harness and add a failing success test**

In `RemoteDirectoryPickerDialog.runtime.test.tsx`, import `AsyncResult`, extend `h`, and mock the command:

```ts
import { AsyncResult } from "effect/unstable/reactivity";

const h = vi.hoisted(() => ({
  // keep existing fields
  createEntry: vi.fn(),
  reset() {
    // keep existing reset work
    this.createEntry.mockReset().mockResolvedValue(
      AsyncResult.success({ relativePath: "new-folder" }),
    );
  },
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: { createEntry: "project-create-entry" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => h.createEntry,
}));
```

Add an input helper:

```ts
function input(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing input: ${label}`);
  return found;
}

async function typeValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
```

Add the success test:

```tsx
it("creates a folder on the selected host and enters it", async () => {
  h.responses.set("environment-one:/workspace", {
    data: { directoryPath: "/canonical/workspace", breadcrumbs: [], entries: [] },
    error: null,
    isPending: false,
  });
  await mount(<RemoteDirectoryPickerDialog {...pickerProps()} />);

  await act(async () => button("New folder").click());
  await typeValue(input("New folder name"), "generated");
  await act(async () => button("Create").click());

  expect(h.createEntry).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment-one"),
    input: {
      cwd: "/canonical/workspace",
      relativePath: "generated",
      kind: "directory",
    },
  });
  expect(h.browseCalls.at(-1)).toEqual({
    environmentId: "environment-one",
    input: { partialPath: "/canonical/workspace/new-folder", mode: "directory" },
  });
});
```

- [ ] **Step 2: Add failing cancellation, pending, and error tests**

Add:

```tsx
it("validates the name, prevents duplicate submission, and cancels on Escape", async () => {
  h.responses.set("environment-one:/workspace", {
    data: { directoryPath: "/workspace", breadcrumbs: [], entries: [] },
    error: null,
    isPending: false,
  });
  let resolveCreate!: (value: unknown) => void;
  h.createEntry.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve; }));
  await mount(<RemoteDirectoryPickerDialog {...pickerProps()} />);

  await act(async () => button("New folder").click());
  expect(button("Create").disabled).toBe(true);
  await typeValue(input("New folder name"), "generated");
  await act(async () => button("Create").click());
  expect(button("Create").disabled).toBe(true);
  await act(async () => button("Create").click());
  expect(h.createEntry).toHaveBeenCalledOnce();
  await act(async () => resolveCreate(AsyncResult.success({ relativePath: "generated" })));

  await act(async () => button("New folder").click());
  await act(async () =>
    input("New folder name").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.body.querySelector('input[aria-label="New folder name"]')).toBeNull();
});

it("keeps the editor open and shows a server mutation failure", async () => {
  h.responses.set("environment-one:/workspace", {
    data: { directoryPath: "/workspace", breadcrumbs: [], entries: [] },
    error: null,
    isPending: false,
  });
  h.createEntry.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("Access denied"))),
  );
  await mount(<RemoteDirectoryPickerDialog {...pickerProps()} />);

  await act(async () => button("New folder").click());
  await typeValue(input("New folder name"), "generated");
  await act(async () => button("Create").click());

  expect(input("New folder name").value).toBe("generated");
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Access denied");
});
```

Import `Cause` for the failure case.

- [ ] **Step 3: Run the runtime picker test and confirm RED**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx --project unit
```

Expected: FAIL because the New folder control and mutation are absent.

- [ ] **Step 4: Implement the remote mutation state and submit function**

Add imports to `RemoteDirectoryPickerDialog.tsx`:

```ts
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";
import { joinHostPath } from "@t4code/shared/path";
import { FolderPlusIcon } from "lucide-react";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { Input } from "../ui/input";
```

Inside the component add:

```ts
const createEntry = useAtomCommand(projectEnvironment.createEntry, { reportFailure: false });
const [newFolderName, setNewFolderName] = useState<string | null>(null);
const [createPending, setCreatePending] = useState(false);
const [createError, setCreateError] = useState<string | null>(null);
const trimmedFolderName = newFolderName?.trim() ?? "";

const closeNewFolder = () => {
  if (createPending) return;
  setNewFolderName(null);
  setCreateError(null);
};

const submitNewFolder = () => {
  if (!directoryPath || trimmedFolderName.length === 0 || createPending) return;
  const parentPath = directoryPath;
  setCreatePending(true);
  setCreateError(null);
  void createEntry({
    environmentId,
    input: { cwd: parentPath, relativePath: trimmedFolderName, kind: "directory" },
  })
    .then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setCreateError(error instanceof Error ? error.message : "Unable to create folder");
        }
        return;
      }
      setNewFolderName(null);
      setPath(joinHostPath(parentPath, result.value.relativePath));
      query.refresh();
    })
    .catch((cause: unknown) => {
      setCreateError(cause instanceof Error ? cause.message : "Unable to create folder");
    })
    .finally(() => setCreatePending(false));
};
```

Reset the editor in the existing open/environment effect:

```ts
setNewFolderName(null);
setCreatePending(false);
setCreateError(null);
```

- [ ] **Step 5: Render the toolbar action and inline editor**

Place beside **Refresh**:

```tsx
<Button
  type="button"
  variant="outline"
  size="sm"
  aria-label="New folder"
  disabled={directoryPath === null || query.isPending}
  onClick={() => {
    setNewFolderName("");
    setCreateError(null);
  }}
>
  <FolderPlusIcon className="size-4" />
  New folder
</Button>
```

Immediately below the toolbar row render:

```tsx
{newFolderName !== null ? (
  <form
    className="flex items-start gap-2 rounded-lg border bg-muted/24 p-2"
    onSubmit={(event) => {
      event.preventDefault();
      submitNewFolder();
    }}
  >
    <div className="min-w-0 flex-1 space-y-1">
      <Input
        autoFocus
        aria-label="New folder name"
        value={newFolderName}
        disabled={createPending}
        onChange={(event) => setNewFolderName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeNewFolder();
        }}
      />
      {createError ? <p role="alert" className="text-xs text-destructive">{createError}</p> : null}
    </div>
    <Button type="button" variant="ghost" size="sm" disabled={createPending} onClick={closeNewFolder}>
      Cancel
    </Button>
    <Button type="submit" size="sm" disabled={trimmedFolderName.length === 0 || createPending}>
      {createPending ? "Creating…" : "Create"}
    </Button>
  </form>
) : null}
```

- [ ] **Step 6: Update the static test harness**

In `RemoteDirectoryPickerDialog.test.tsx`:

- add `createEntry` to `harness` and reset it to `AsyncResult.success({ relativePath: "new-folder" })`;
- mock `~/state/projects` and `~/state/use-atom-command` exactly as in the runtime test;
- mock `../ui/input` with an `<input>` that forwards `aria-label`, `value`, `onChange`, and `onKeyDown`;
- add a static assertion that **New folder** is disabled without canonical query data and enabled when `directoryPath` exists.

Use this assertion:

```ts
expect(button("New folder").disabled).toBe(false);
expect(renderPicker(pickerProps())).toContain("New folder");
```

- [ ] **Step 7: Run picker tests and confirm GREEN**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/settings/RemoteDirectoryPickerDialog.test.tsx src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx --project unit
```

Expected: PASS.

- [ ] **Step 8: Commit the picker feature**

```powershell
git add apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.test.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx
git commit -m "feat(web): create folders from workspace picker"
```

### Task 3: Verify the subsystem and repository gates

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: focused test evidence and mandatory repository gate results.

- [ ] **Step 1: Run focused path and picker tests**

```powershell
corepack pnpm --filter @t4code/shared exec vp test run src/path.test.ts
corepack pnpm --filter @t4code/web exec vp test run src/components/settings/RemoteDirectoryPickerDialog.test.tsx src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx --project unit
```

Expected: PASS.

- [ ] **Step 2: Run the built-in Vite+ suite**

```powershell
vp test
```

Expected: PASS.

- [ ] **Step 3: Run mandatory repository checks**

```powershell
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 4: Perform the desktop/remote smoke check**

1. Open Settings → **Select Workspace folder** on the Windows host.
2. Navigate to an empty directory and select **New folder**.
3. Verify Enter creates the folder and the picker enters it.
4. Verify **Select folder** returns the new canonical path.
5. Repeat with a duplicate name and verify the picker stays open with a useful error.
6. Repeat against a remote/WSL host and verify creation occurs on that host, not locally.

Expected: the new folder is created only on the selected T4Code host and is immediately selectable.

- [ ] **Step 5: Confirm repository cleanliness**

```powershell
git status --short
git diff --check
```

Expected: no unintended changes or whitespace errors.
