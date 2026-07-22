// @vitest-environment happy-dom

import { EnvironmentId } from "@t4code/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  browseCalls: [] as Array<{ environmentId: string; input: { partialPath: string; mode: string } }>,
  refresh: vi.fn(),
  responses: new Map<
    string,
    {
      data: Record<string, unknown> | null;
      error: string | null;
      isPending: boolean;
    }
  >(),
  reset() {
    this.browseCalls.length = 0;
    this.refresh.mockReset();
    this.responses.clear();
  },
}));

function queryKey(target: { environmentId: string; input: { partialPath: string } }): string {
  return `${target.environmentId}:${target.input.partialPath}`;
}

vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (target: { environmentId: string; input: { partialPath: string; mode: string } }) => {
      h.browseCalls.push(target);
      return target;
    },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { environmentId: string; input: { partialPath: string } } | null) =>
    target === null
      ? { data: null, error: null, isPending: false, refresh: h.refresh }
      : {
          ...(h.responses.get(queryKey(target)) ?? {
            data: null,
            error: null,
            isPending: true,
          }),
          refresh: h.refresh,
        },
}));

const { RemoteDirectoryPickerDialog } = await import("./RemoteDirectoryPickerDialog");
type RemoteDirectoryPickerDialogProps = React.ComponentProps<typeof RemoteDirectoryPickerDialog>;

interface MountedPicker {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mounted: MountedPicker[] = [];

function pickerProps(
  overrides: Partial<RemoteDirectoryPickerDialogProps> = {},
): RemoteDirectoryPickerDialogProps {
  return {
    open: true,
    environmentId: EnvironmentId.make("environment-one"),
    initialPath: "/workspace",
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

async function mount(element: ReactElement): Promise<MountedPicker> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const picker = { container, root };
  mounted.push(picker);
  await act(async () => root.render(element));
  return picker;
}

async function rerender(picker: MountedPicker, element: ReactElement): Promise<void> {
  await act(async () => picker.root.render(element));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.reset();
});

afterEach(async () => {
  for (const picker of mounted.splice(0)) {
    await act(async () => picker.root.unmount());
    picker.container.remove();
  }
});

describe("RemoteDirectoryPickerDialog runtime behavior", () => {
  it("keeps a closed dialog inert and renders ordinary navigation buttons when opened", async () => {
    const props = pickerProps({ open: false });
    const picker = await mount(<RemoteDirectoryPickerDialog {...props} />);

    expect(h.browseCalls).toEqual([]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    h.responses.set("environment-one:/workspace", {
      data: {
        parentPath: "/workspace",
        directoryPath: "/workspace",
        entries: [{ name: "child", fullPath: "/workspace/child" }],
      },
      error: null,
      isPending: false,
    });
    await rerender(picker, <RemoteDirectoryPickerDialog {...pickerProps()} />);

    expect(h.browseCalls.at(-1)).toEqual({
      environmentId: "environment-one",
      input: { partialPath: "/workspace", mode: "directory" },
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(document.body.querySelector('[role="option"]')).toBeNull();
    expect(button("child").getAttribute("type")).toBe("button");
    expect(button("child").querySelector("svg")).not.toBeNull();
    expect(button("child").className).toContain("justify-start");
  });

  it("shows the canonical resolved path without changing the active browse request", async () => {
    h.responses.set("environment-one:~", {
      data: {
        parentPath: "C:\\Users\\mauro",
        directoryPath: "C:\\Users\\mauro",
        ancestorPath: "C:\\Users",
        breadcrumbs: [
          { name: "C:\\", fullPath: "C:\\" },
          { name: "Users", fullPath: "C:\\Users" },
          { name: "mauro", fullPath: "C:\\Users\\mauro" },
        ],
        entries: [],
      },
      error: null,
      isPending: false,
    });

    await mount(<RemoteDirectoryPickerDialog {...pickerProps({ initialPath: "~" })} />);

    expect(h.browseCalls.at(-1)).toEqual({
      environmentId: "environment-one",
      input: { partialPath: "~", mode: "directory" },
    });
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="Server directory path"]')
        ?.value,
    ).toBe("C:\\Users\\mauro");
    expect(document.body.querySelectorAll("[data-directory-breadcrumb-separator]")).toHaveLength(2);
  });

  it("keeps dot-directories collapsed until the hidden-folders control is used", async () => {
    h.responses.set("environment-one:/workspace", {
      data: {
        parentPath: "/workspace",
        directoryPath: "/workspace",
        entries: [
          { name: ".git", fullPath: "/workspace/.git" },
          { name: "packages", fullPath: "/workspace/packages" },
        ],
      },
      error: null,
      isPending: false,
    });
    await mount(<RemoteDirectoryPickerDialog {...pickerProps()} />);

    expect(() => button(".git")).toThrow("Missing button: .git");
    expect(button("packages")).toBeTruthy();

    await act(async () => button("Show hidden folders").click());
    expect(button(".git")).toBeTruthy();
    expect(button("Hide hidden folders")).toBeTruthy();
  });

  it("keeps stale directory data disabled while path and environment requests change", async () => {
    h.responses.set("environment-one:/workspace", {
      data: {
        parentPath: "/workspace",
        directoryPath: "/canonical/one",
        entries: [{ name: "next", fullPath: "/workspace/next" }],
      },
      error: null,
      isPending: false,
    });
    const onSelect = vi.fn();
    const picker = await mount(<RemoteDirectoryPickerDialog {...pickerProps({ onSelect })} />);

    await act(async () => button("next").click());
    expect(h.browseCalls.at(-1)).toEqual({
      environmentId: "environment-one",
      input: { partialPath: "/workspace/next", mode: "directory" },
    });
    expect(button("Select folder").disabled).toBe(true);

    await rerender(
      picker,
      <RemoteDirectoryPickerDialog
        {...pickerProps({
          environmentId: EnvironmentId.make("environment-two"),
          initialPath: "/remote",
          onSelect,
        })}
      />,
    );
    expect(h.browseCalls.at(-1)).toEqual({
      environmentId: "environment-two",
      input: { partialPath: "/remote", mode: "directory" },
    });
    expect(button("Select folder").disabled).toBe(true);

    h.responses.set("environment-two:/remote", {
      data: { parentPath: "/remote", directoryPath: "/canonical/two", entries: [] },
      error: null,
      isPending: false,
    });
    await rerender(
      picker,
      <RemoteDirectoryPickerDialog
        {...pickerProps({
          environmentId: EnvironmentId.make("environment-two"),
          initialPath: "/remote",
          onSelect,
        })}
      />,
    );
    await act(async () => button("Select folder").click());

    expect(onSelect).toHaveBeenCalledWith("/canonical/two");
    expect(onSelect).not.toHaveBeenCalledWith("/canonical/one");
  });
});
