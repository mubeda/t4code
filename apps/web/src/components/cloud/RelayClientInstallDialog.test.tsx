import type { RelayClientInstallDialogState } from "../../cloud/relayClientInstallDialog";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  state: { status: "idle" } as RelayClientInstallDialogState,
  dialogs: [] as Array<Record<string, unknown>>,
  buttons: [] as Array<Record<string, unknown>>,
  responses: [] as boolean[],
  closes: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: () => harness.state,
}));
vi.mock("../../cloud/relayClientInstallDialog", () => ({
  completeRelayClientInstallDialogClose: () => (harness.closes += 1),
  readRelayClientInstallDialogState: () => harness.state,
  respondToRelayClientInstallConfirmation: (confirmed: boolean) =>
    harness.responses.push(confirmed),
  subscribeRelayClientInstallDialog: () => () => undefined,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button>{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/dialog", () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Dialog: (props: Record<string, unknown>) => {
      harness.dialogs.push(props);
      return <>{props.children as React.ReactNode}</>;
    },
    DialogDescription: Wrapper,
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogPanel: Wrapper,
    DialogPopup: Wrapper,
    DialogTitle: Wrapper,
  };
});

import { RelayClientInstallDialog } from "./RelayClientInstallDialog";

beforeEach(() => {
  harness.state = { status: "idle" };
  harness.dialogs.length = 0;
  harness.buttons.length = 0;
  harness.responses.length = 0;
  harness.closes = 0;
});

function render(): string {
  return renderToStaticMarkup(<RelayClientInstallDialog />);
}

function requireEntry(
  entries: Array<Record<string, unknown>>,
  index: number,
): Record<string, unknown> {
  const entry = entries[index];
  if (!entry) throw new Error(`Expected captured entry ${index}`);
  return entry;
}

describe("RelayClientInstallDialog", () => {
  it("renders confirmation actions and responds to every close path", () => {
    harness.state = { status: "confirming", version: "1.2.3" };
    const markup = render();

    expect(markup).toContain("Install relay client?");
    expect(markup).toContain("1.2.3");
    expect(harness.dialogs[0]).toMatchObject({ open: true });
    const dialog = requireEntry(harness.dialogs, 0);
    (requireEntry(harness.buttons, 0).onClick as () => void)();
    (requireEntry(harness.buttons, 1).onClick as () => void)();
    (dialog.onOpenChange as (open: boolean) => void)(false);
    (dialog.onOpenChange as (open: boolean) => void)(true);
    (dialog.onOpenChangeComplete as (open: boolean) => void)(false);
    (dialog.onOpenChangeComplete as (open: boolean) => void)(true);
    expect(harness.responses).toEqual([false, true, false]);
    expect(harness.closes).toBe(1);
  });

  it("renders active installation stages, including unknown progress", () => {
    harness.state = { status: "installing", version: "1.2.3", stage: "downloading" };
    expect(render()).toContain("Downloading relay client");
    expect(render()).toContain("3 of 7");

    harness.state = {
      status: "installing",
      version: "1.2.3",
      stage: "unknown-stage" as "checking",
    };
    expect(render()).toContain("0 of 7");
  });

  it("keeps the closing view while closing the dialog", () => {
    harness.state = {
      status: "closing",
      view: { status: "installing", version: "1.2.3", stage: "activating" },
    };
    const markup = render();

    expect(markup).toContain("Activating installation");
    expect(harness.dialogs[0]).toMatchObject({ open: false });
    (requireEntry(harness.dialogs, 0).onOpenChange as (open: boolean) => void)(false);
    expect(harness.responses).toEqual([]);
  });
});
