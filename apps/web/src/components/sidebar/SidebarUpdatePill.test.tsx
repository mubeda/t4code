import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  dismissed: false,
  setDismissed: vi.fn(),
  visible: false,
  disabled: false,
  action: "none" as "none" | "download" | "install",
  showWarning: false,
  actionError: null as string | null,
  shouldToast: false,
  toastAdd: vi.fn(),
  stackedToast: vi.fn((value: unknown) => value),
  confirm: vi.fn(),
  bridge: null as null | {
    downloadUpdate: ReturnType<typeof vi.fn>;
    installUpdate: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useState: () => [harness.dismissed, harness.setDismissed],
}));
vi.mock("../../env", () => ({ isDesktopHost: true }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => harness.state }));
vi.mock("../desktopUpdate.logic", () => ({
  getArm64IntelBuildWarningDescription: () => "Use the native Apple Silicon build.",
  getDesktopUpdateActionError: () => harness.actionError,
  getDesktopUpdateButtonTooltip: () => "Update tooltip",
  getDesktopUpdateInstallConfirmationMessage: () => "Restart now?",
  isDesktopUpdateButtonDisabled: () => harness.disabled,
  resolveDesktopUpdateButtonAction: () => harness.action,
  shouldShowArm64IntelBuildWarning: () => harness.showWarning,
  shouldShowDesktopUpdateButton: () => harness.visible,
  shouldToastDesktopUpdateActionResult: () => harness.shouldToast,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
  stackedThreadToast: harness.stackedToast,
}));
vi.mock("../ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: React.ReactNode }) => <strong>{children}</strong>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import { SidebarUpdatePill } from "./SidebarUpdatePill";

function visit(node: React.ReactNode, entries: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, entries);
    return entries;
  }
  if (!React.isValidElement(node)) return entries;
  entries.push(node);
  visit((node.props as { children?: React.ReactNode }).children, entries);
  const render = (node.props as { render?: React.ReactNode }).render;
  if (render) visit(render, entries);
  return entries;
}

function actionButton(tree: React.ReactNode) {
  const button = visit(tree).find(
    (element) =>
      element.type === "button" &&
      (element.props as Record<string, unknown>).className ===
        "update-main relative flex h-full flex-1 items-center gap-2 px-2 enabled:cursor-pointer",
  );
  if (!button) throw new Error("Update action button not found");
  return button.props as { onClick: () => void; disabled: boolean; "aria-disabled"?: boolean };
}

beforeEach(() => {
  harness.state = null;
  harness.dismissed = false;
  harness.setDismissed.mockReset();
  harness.visible = false;
  harness.disabled = false;
  harness.action = "none";
  harness.showWarning = false;
  harness.actionError = null;
  harness.shouldToast = false;
  harness.toastAdd.mockReset();
  harness.stackedToast.mockClear();
  harness.confirm.mockReset();
  harness.confirm.mockReturnValue(true);
  harness.bridge = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm: harness.confirm, desktopBridge: null },
  });
});

describe("SidebarUpdatePill", () => {
  it("hides when neither an update nor architecture warning is visible", () => {
    expect(SidebarUpdatePill()).toBeNull();
  });

  it("renders the Apple Silicon warning independently", () => {
    harness.state = { status: "idle" };
    harness.showWarning = true;
    const markup = renderToStaticMarkup(<SidebarUpdatePill />);
    expect(markup).toContain("Intel build on Apple Silicon");
    expect(markup).toContain("Use the native Apple Silicon build.");
  });

  it("renders available, downloading, disabled, install, and dismissed states", () => {
    harness.state = { status: "available" };
    harness.visible = true;
    harness.action = "download";
    let tree = SidebarUpdatePill();
    expect(renderToStaticMarkup(tree)).toContain("Update available");
    const dismiss = visit(tree).find(
      (element) =>
        element.type === "button" &&
        (element.props as Record<string, unknown>)["aria-label"] === "Dismiss update",
    );
    if (!dismiss) throw new Error("Dismiss button not found");
    (dismiss.props as { onClick: () => void }).onClick();
    expect(harness.setDismissed).toHaveBeenCalledWith(true);

    harness.state = { status: "downloading", downloadPercent: 42.8 };
    harness.disabled = true;
    tree = SidebarUpdatePill();
    expect(renderToStaticMarkup(tree)).toContain("Downloading (42%)");
    expect(actionButton(tree).disabled).toBe(true);
    expect(actionButton(tree)["aria-disabled"]).toBe(true);

    harness.state = { status: "downloading", downloadPercent: null };
    expect(renderToStaticMarkup(<SidebarUpdatePill />)).toContain("Downloading…");

    harness.state = { status: "downloaded" };
    harness.disabled = false;
    harness.action = "install";
    expect(renderToStaticMarkup(<SidebarUpdatePill />)).toContain("Restart to update");

    harness.dismissed = true;
    harness.visible = false;
    expect(SidebarUpdatePill()).toBeNull();
  });

  it("guards actions without a bridge, state, or enabled action", () => {
    harness.state = { status: "available" };
    harness.visible = true;
    harness.action = "download";
    actionButton(SidebarUpdatePill()).onClick();

    harness.bridge = {
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
    };
    (window as unknown as { desktopBridge: unknown }).desktopBridge = harness.bridge;
    harness.disabled = true;
    actionButton(SidebarUpdatePill()).onClick();
    harness.disabled = false;
    harness.action = "none";
    actionButton(SidebarUpdatePill()).onClick();
    expect(harness.bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("downloads updates and reports completion and action failures", async () => {
    const downloadUpdate = vi.fn().mockResolvedValue({ completed: true });
    harness.bridge = { downloadUpdate, installUpdate: vi.fn() };
    (window as unknown as { desktopBridge: unknown }).desktopBridge = harness.bridge;
    harness.state = { status: "available" };
    harness.visible = true;
    harness.action = "download";
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() => expect(downloadUpdate).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Update downloaded" }),
      ),
    );

    harness.toastAdd.mockReset();
    harness.shouldToast = true;
    harness.actionError = "network failed";
    downloadUpdate.mockResolvedValueOnce({ completed: false });
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not download update" }),
      ),
    );
  });

  it("reports rejected download attempts with error and unknown causes", async () => {
    const downloadUpdate = vi.fn().mockRejectedValue(new Error("offline"));
    harness.bridge = { downloadUpdate, installUpdate: vi.fn() };
    (window as unknown as { desktopBridge: unknown }).desktopBridge = harness.bridge;
    harness.state = { status: "available" };
    harness.visible = true;
    harness.action = "download";
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ description: "offline" }),
      ),
    );

    harness.toastAdd.mockReset();
    downloadUpdate.mockRejectedValueOnce("offline");
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ description: "An unexpected error occurred." }),
      ),
    );
  });

  it("installs only after confirmation and reports result and rejection failures", async () => {
    const installUpdate = vi.fn().mockResolvedValue({ completed: false });
    harness.bridge = { downloadUpdate: vi.fn(), installUpdate };
    (window as unknown as { desktopBridge: unknown }).desktopBridge = harness.bridge;
    harness.state = { status: "downloaded" };
    harness.visible = true;
    harness.action = "install";
    harness.confirm.mockReturnValueOnce(false);
    actionButton(SidebarUpdatePill()).onClick();
    expect(installUpdate).not.toHaveBeenCalled();

    harness.shouldToast = true;
    harness.actionError = "install failed";
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not install update" }),
      ),
    );

    harness.toastAdd.mockReset();
    installUpdate.mockRejectedValueOnce("rejected");
    actionButton(SidebarUpdatePill()).onClick();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ description: "An unexpected error occurred." }),
      ),
    );
  });
});
