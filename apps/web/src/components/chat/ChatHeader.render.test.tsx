import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t4code/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primaryEnvironmentId: "environment-primary" as EnvironmentId | null,
  panelProps: null as Record<string, unknown> | null,
  gitProps: null as Record<string, unknown> | null,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => harness.primaryEnvironmentId,
}));

vi.mock("./ChatHeaderPanelMenu", () => ({
  ChatHeaderPanelMenu: (props: Record<string, unknown>) => {
    harness.panelProps = props;
    return <div data-testid="panel-menu" />;
  },
}));

vi.mock("../ProjectScriptsControl", () => ({
  default: () => <div data-testid="scripts-control" />,
}));

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => <div data-testid="open-in-picker" />,
}));

vi.mock("../GitActionsControl", () => ({
  default: (props: Record<string, unknown>) => {
    harness.gitProps = props;
    return <div data-testid="git-actions" />;
  },
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { ChatHeader } from "./ChatHeader";

const environmentId = EnvironmentId.make("environment-primary");

function props(
  overrides: Partial<ComponentProps<typeof ChatHeader>> = {},
): ComponentProps<typeof ChatHeader> {
  return {
    activeThreadEnvironmentId: environmentId,
    activeThreadId: ThreadId.make("thread-1"),
    activeThreadTitle: "Thread title",
    activeProjectName: undefined,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: {} as never,
    availableEditors: [],
    rightPanelOpen: false,
    gitCwd: null,
    providerStatuses: [],
    settings: {
      providerInstances: DEFAULT_SERVER_SETTINGS.providerInstances,
      providers: DEFAULT_SERVER_SETTINGS.providers,
    },
    canCreatePanel: false,
    onCreateChatPanel: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenProviderTerminalPanel: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(),
    onUpdateProjectScript: vi.fn(),
    onDeleteProjectScript: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  harness.primaryEnvironmentId = environmentId;
  harness.panelProps = null;
  harness.gitProps = null;
});

describe("ChatHeader rendering", () => {
  it("omits project actions when no project is active", () => {
    const markup = renderToStaticMarkup(<ChatHeader {...props()} />);

    expect(markup).toContain("Thread title");
    expect(markup).toContain("pr-16");
    expect(markup).not.toContain("scripts-control");
    expect(markup).not.toContain("open-in-picker");
    expect(markup).not.toContain("git-actions");
  });

  it("renders every project action and forwards a draft identity", () => {
    const onOpenProviderTerminalPanel = vi.fn();
    const markup = renderToStaticMarkup(
      <ChatHeader
        {...props({
          activeProjectName: "Project",
          activeProjectScripts: [],
          rightPanelOpen: true,
          draftId: "draft-1" as never,
          onOpenProviderTerminalPanel,
        })}
      />,
    );

    expect(markup).toContain("pr-0");
    expect(markup).toContain("scripts-control");
    expect(markup).toContain("open-in-picker");
    expect(markup).toContain("git-actions");
    expect(harness.gitProps).toMatchObject({ draftId: "draft-1", hideTrigger: true });
    expect(harness.panelProps?.["onOpenProviderTerminalPanel"]).toBe(onOpenProviderTerminalPanel);

    (harness.panelProps!["onAddCustomAction"] as () => void)();
  });

  it("omits the local editor picker for a remote environment", () => {
    harness.primaryEnvironmentId = EnvironmentId.make("different");
    const markup = renderToStaticMarkup(
      <ChatHeader {...props({ activeProjectName: "Remote project", activeProjectScripts: [] })} />,
    );

    expect(markup).not.toContain("open-in-picker");
    expect(markup).toContain("git-actions");
    expect(harness.gitProps).not.toHaveProperty("draftId");
  });
});
