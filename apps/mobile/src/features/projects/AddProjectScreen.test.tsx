import { EnvironmentId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => {
  interface QueryView {
    data: unknown;
    error: string | null;
    isPending: boolean;
    refresh: () => void;
  }
  const emptyView: QueryView = { data: null, error: null, isPending: false, refresh: () => {} };
  return {
    emptyView,
    params: {} as Record<string, string | ReadonlyArray<string> | undefined>,
    routerPush: [] as Array<unknown>,
    routerReplace: [] as Array<unknown>,
    routerSetParams: [] as Array<unknown>,
    savedConnectionsById: {} as Record<
      string,
      { readonly environmentId: string; readonly environmentLabel: string }
    >,
    serverConfigs: new Map<string, unknown>(),
    projects: [] as Array<unknown>,
    discoveryView: { ...emptyView } as QueryView,
    browseView: { ...emptyView } as QueryView,
    browseRequests: [] as Array<unknown>,
    pressables: [] as Array<Record<string, unknown>>,
    textInputs: [] as Array<Record<string, unknown>>,
    alerts: [] as Array<ReadonlyArray<unknown>>,
    uuidCounter: 0,
    createCalls: [] as Array<unknown>,
    cloneCalls: [] as Array<unknown>,
    repositoryCalls: [] as Array<unknown>,
    createImpl: (async (_value: unknown): Promise<unknown> => {
      throw new Error("createImpl not configured");
    }) as (value: unknown) => Promise<unknown>,
    cloneImpl: (async (_value: unknown): Promise<unknown> => {
      throw new Error("cloneImpl not configured");
    }) as (value: unknown) => Promise<unknown>,
    repositoryImpl: (async (_value: unknown): Promise<unknown> => {
      throw new Error("repositoryImpl not configured");
    }) as (value: unknown) => Promise<unknown>,
    markers: {
      create: { marker: "project-create" },
      clone: { marker: "clone-repository" },
      repository: { marker: "repository-lookup" },
    },
  };
});

vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: (target: unknown) => {
      h.routerPush.push(target);
    },
    replace: (target: unknown) => {
      h.routerReplace.push(target);
    },
    setParams: (nextParams: unknown) => {
      h.routerSetParams.push(nextParams);
    },
  }),
  useLocalSearchParams: () => h.params,
}));

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <i data-activity-indicator="true" />,
  Alert: {
    alert: (...args: ReadonlyArray<unknown>) => {
      h.alerts.push(args);
    },
  },
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return <button type="button">{props.children}</button>;
  },
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 12, left: 0, right: 0 }),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => h.projects,
  useServerConfigs: () => h.serverConfigs,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { readonly kind?: string; readonly args?: unknown } | null) => {
    if (atom === null) {
      return h.emptyView;
    }
    if (atom.kind === "discovery") {
      return h.discoveryView;
    }
    h.browseRequests.push(atom.args);
    return h.browseView;
  },
}));

vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (args: unknown) => ({ kind: "discovery", args }),
    repository: h.markers.repository,
    cloneRepository: h.markers.clone,
  },
}));

vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (args: unknown) => ({ kind: "browse", args }),
  },
}));

vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    create: h.markers.create,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (value: unknown) => {
    if (command === h.markers.create) {
      h.createCalls.push(value);
      return h.createImpl(value);
    }
    if (command === h.markers.clone) {
      h.cloneCalls.push(value);
      return h.cloneImpl(value);
    }
    throw new Error("unexpected atom command");
  },
}));

vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) => (target: unknown) => {
    if (family === h.markers.repository) {
      h.repositoryCalls.push(target);
      return h.repositoryImpl(target);
    }
    throw new Error("unexpected atom query runner");
  },
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: h.savedConnectionsById }),
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  AppTextInput: (props: Record<string, unknown>) => {
    h.textInputs.push(props);
    return <i data-input-placeholder={String(props.placeholder ?? "")} />;
  },
}));

vi.mock("../../components/ErrorBanner", () => ({
  ErrorBanner: (props: { readonly message: string }) => (
    <div data-error-banner="true">{props.message}</div>
  ),
}));

vi.mock("../../components/SourceControlIcon", () => ({
  SourceControlIcon: (props: { readonly kind: string }) => <i data-source-icon={props.kind} />,
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#112233",
}));

vi.mock("../../lib/uuid", () => ({
  uuidv4: () => {
    h.uuidCounter += 1;
    return `uuid-${h.uuidCounter}`;
  },
}));

import {
  AddProjectDestinationScreen,
  AddProjectLocalFolderScreen,
  AddProjectRepositoryScreen,
  AddProjectSourceScreen,
} from "./AddProjectScreen";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV_ALPHA = EnvironmentId.make("env-alpha");
const ENV_BETA = EnvironmentId.make("env-beta");

function serverConfig(os: string | null, baseDirectory: string | null): unknown {
  return {
    environment: { platform: { os } },
    settings: { addProjectBaseDirectory: baseDirectory },
  };
}

function connectEnvironment(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly os?: string | null;
  readonly baseDirectory?: string | null;
  readonly withConfig?: boolean;
}): void {
  h.savedConnectionsById[input.environmentId] = {
    environmentId: input.environmentId,
    environmentLabel: input.label,
  };
  if (input.withConfig !== false) {
    h.serverConfigs.set(
      input.environmentId,
      serverConfig(input.os ?? "darwin", input.baseDirectory ?? null),
    );
  }
}

function providerDiscoveryItem(input: {
  readonly kind: string;
  readonly label: string;
  readonly status: "available" | "missing";
  readonly authStatus?: "authenticated" | "unauthenticated" | "unknown";
  readonly authDetail?: string;
  readonly installHint?: string;
}): unknown {
  return {
    kind: input.kind,
    label: input.label,
    status: input.status,
    version: Option.none(),
    installHint: input.installHint ?? `Install the ${input.label} CLI.`,
    detail: Option.none(),
    auth: {
      status: input.authStatus ?? "unknown",
      account: Option.none(),
      host: Option.none(),
      detail: input.authDetail === undefined ? Option.none() : Option.some(input.authDetail),
    },
  };
}

function render(element: ReactElement): string {
  h.pressables.length = 0;
  h.textInputs.length = 0;
  return renderToStaticMarkup(element);
}

function press(markup: string, text: string): void {
  const segments = markup.split("<button").slice(1);
  const index = segments.findIndex((segment) => segment.includes(text));
  if (index < 0) {
    throw new Error(`no pressable rendering "${text}" found`);
  }
  const onPress = h.pressables[index]?.onPress;
  if (typeof onPress !== "function") {
    throw new Error(`pressable rendering "${text}" has no onPress handler`);
  }
  (onPress as () => void)();
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  h.params = {};
  h.routerPush.length = 0;
  h.routerReplace.length = 0;
  h.routerSetParams.length = 0;
  h.savedConnectionsById = {};
  h.serverConfigs = new Map();
  h.projects = [];
  h.discoveryView = { ...h.emptyView };
  h.browseView = { ...h.emptyView };
  h.browseRequests.length = 0;
  h.alerts.length = 0;
  h.uuidCounter = 0;
  h.createCalls.length = 0;
  h.cloneCalls.length = 0;
  h.repositoryCalls.length = 0;
  h.createImpl = async () => AsyncResult.success(undefined);
  h.cloneImpl = async () => AsyncResult.success({ cwd: "/cloned" });
  h.repositoryImpl = async () =>
    AsyncResult.success({ sshUrl: "git@github.com:acme/app.git", nameWithOwner: "acme/app" });
});

describe("AddProjectSourceScreen", () => {
  it("when: no environments are connected, shows the empty state", () => {
    const markup = render(<AddProjectSourceScreen />);

    expect(markup).toContain("No environments connected");
    expect(markup).not.toContain("Local folder");

    press(markup, "Add environment");
    expect(h.routerReplace).toEqual(["/connections/new"]);
  });

  it("when: several environments exist, lists them sorted and routes selections", () => {
    connectEnvironment({ environmentId: ENV_BETA, label: "Beta", os: "windows" });
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", os: "darwin" });
    connectEnvironment({ environmentId: "env-gamma", label: "Gamma", os: "linux" });
    connectEnvironment({ environmentId: "env-delta", label: "Delta", withConfig: false });
    h.discoveryView = {
      ...h.emptyView,
      data: {
        versionControlSystems: [],
        sourceControlProviders: [
          providerDiscoveryItem({
            kind: "github",
            label: "GitHub",
            status: "available",
            authStatus: "authenticated",
          }),
          providerDiscoveryItem({
            kind: "gitlab",
            label: "GitLab",
            status: "available",
            authStatus: "unauthenticated",
            authDetail: "Run glab auth login to continue.",
          }),
          providerDiscoveryItem({
            kind: "bitbucket",
            label: "Bitbucket",
            status: "missing",
            installHint: "Install the Bitbucket CLI first.",
          }),
        ],
      },
    };

    const markup = render(<AddProjectSourceScreen />);

    expect(markup).toContain("Connected environments");
    expect(markup.indexOf(">Alpha<")).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf(">Alpha<")).toBeLessThan(markup.indexOf(">Beta<"));
    expect(markup.indexOf(">Beta<")).toBeLessThan(markup.indexOf(">Delta<"));
    expect(markup.indexOf(">Delta<")).toBeLessThan(markup.indexOf(">Gamma<"));

    expect(markup).toContain("Local folder");
    expect(markup).toContain("Git URL");
    expect(markup).toContain("GitHub repository");
    expect(markup).toContain("Clone GitHub owner/repo");
    expect(markup.indexOf("GitHub repository")).toBeLessThan(
      markup.indexOf("Azure DevOps repository"),
    );
    expect(markup.indexOf("Azure DevOps repository")).toBeLessThan(
      markup.indexOf("Bitbucket repository"),
    );
    expect(markup.indexOf("Bitbucket repository")).toBeLessThan(
      markup.indexOf("GitLab repository"),
    );
    expect(markup).toContain("Run glab auth login to continue.");
    expect(markup).toContain("Install the Bitbucket CLI first.");
    expect(markup).toContain(
      "Provider status unavailable. Open Source Control settings and rescan.",
    );

    press(markup, ">Beta<");
    expect(h.routerSetParams).toEqual([{ environmentId: ENV_BETA }]);

    press(markup, "Local folder");
    expect(h.routerPush.at(-1)).toEqual({
      pathname: "/new/add-project/local",
      params: { environmentId: ENV_ALPHA },
    });

    press(markup, "GitHub repository");
    expect(h.routerPush.at(-1)).toEqual({
      pathname: "/new/add-project/repository",
      params: { environmentId: ENV_ALPHA, source: "github" },
    });
  });

  it("when: an environment is requested by param, marks it selected and shows discovery progress", () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha" });
    connectEnvironment({ environmentId: ENV_BETA, label: "Beta" });
    h.params = { environmentId: [ENV_BETA] };
    h.discoveryView = { ...h.emptyView, isPending: true };

    const markup = render(<AddProjectSourceScreen />);

    const betaSegment = markup.split("<button").find((segment) => segment.includes(">Beta<"));
    expect(betaSegment).toContain('data-symbol="checkmark"');
    const alphaSegment = markup.split("<button").find((segment) => segment.includes(">Alpha<"));
    expect(alphaSegment).not.toContain('data-symbol="checkmark"');
    expect(markup).toContain("data-activity-indicator");
  });
});

describe("AddProjectRepositoryScreen", () => {
  it("when: the git url source is selected, keeps the lookup disabled for empty input", () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha" });
    h.params = { environmentId: ENV_ALPHA, source: "url" };

    const markup = render(<AddProjectRepositoryScreen />);

    expect(markup).toContain("https://github.com/org/repo.git");
    expect(markup).toContain("Continue");

    press(markup, "Continue");
    expect(h.repositoryCalls).toEqual([]);
    expect(h.routerPush).toEqual([]);
  });

  it("when: a provider source is selected, shows the provider path hint", () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha" });
    h.params = { environmentId: ENV_ALPHA, source: "github" };

    const markup = render(<AddProjectRepositoryScreen />);

    expect(h.textInputs[0]?.placeholder).toBe("owner/repo");
    expect(markup).toContain("Lookup repository");

    const submit = h.textInputs[0]?.onSubmitEditing;
    expect(typeof submit).toBe("function");
    (submit as () => void)();
    expect(h.repositoryCalls).toEqual([]);
  });

  it("when: the source param is unknown, falls back to the git url source", () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha" });
    h.params = { environmentId: ENV_ALPHA, source: "sourceforge" };

    const markup = render(<AddProjectRepositoryScreen />);

    expect(markup).toContain("Continue");
    expect(h.textInputs[0]?.placeholder).toBe("https://github.com/org/repo.git");
  });
});

describe("AddProjectLocalFolderScreen", () => {
  it("when: no environment is available, shows the empty state", () => {
    const markup = render(<AddProjectLocalFolderScreen />);

    expect(markup).toContain("No environments connected");
  });

  it("when: browsing the base directory, lists visible folders sorted and navigates", () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      baseDirectory: "/home/dev",
    });
    h.browseView = {
      ...h.emptyView,
      data: {
        entries: [
          { name: "zeta", fullPath: "/home/dev/zeta" },
          { name: ".git", fullPath: "/home/dev/.git" },
          { name: "apps", fullPath: "/home/dev/apps" },
        ],
      },
    };

    const markup = render(<AddProjectLocalFolderScreen />);

    expect(h.textInputs[0]?.value).toBe("/home/dev/");
    expect(h.browseRequests).toEqual([
      { environmentId: ENV_ALPHA, input: { partialPath: "/home/dev/" } },
    ]);
    expect(markup).toContain(">apps<");
    expect(markup).toContain(">zeta<");
    expect(markup).not.toContain(".git");
    expect(markup.indexOf(">apps<")).toBeLessThan(markup.indexOf(">zeta<"));
    expect(markup).toContain(">..<");

    press(markup, ">..<");
    press(markup, ">apps<");
  });

  it("when: the browse query fails while pending, shows the error and a spinner", () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      baseDirectory: "/home/dev",
    });
    h.browseView = { ...h.emptyView, error: "Browse failed", isPending: true };

    const markup = render(<AddProjectLocalFolderScreen />);

    expect(markup).toContain("Browse failed");
    expect(markup).toContain("data-activity-indicator");
  });

  it("when: submitting a valid path, creates the project and opens the draft", async () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      baseDirectory: "/home/dev/projects",
    });

    const markup = render(<AddProjectLocalFolderScreen />);
    press(markup, "Add project");
    await flushAsync();

    expect(h.createCalls).toHaveLength(1);
    const call = h.createCalls[0] as {
      environmentId: string;
      input: { type: string; projectId: string; workspaceRoot: string; title: string };
    };
    expect(call.environmentId).toBe(ENV_ALPHA);
    expect(call.input.type).toBe("project.create");
    expect(call.input.projectId).toBe("uuid-1");
    expect(call.input.workspaceRoot).toBe("/home/dev/projects");
    expect(call.input.title).toBe("projects");
    expect(h.routerReplace).toEqual([
      {
        pathname: "/new/draft",
        params: { environmentId: ENV_ALPHA, projectId: "uuid-1", title: "projects" },
      },
    ]);
  });

  it("when: the path already belongs to a project, alerts and reopens it", async () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      baseDirectory: "/home/dev/projects",
    });
    h.projects = [
      {
        id: "project-existing",
        environmentId: ENV_ALPHA,
        title: "Existing project",
        workspaceRoot: "/home/dev/projects",
      },
    ];

    const markup = render(<AddProjectLocalFolderScreen />);
    press(markup, "Add project");
    await flushAsync();

    expect(h.alerts).toEqual([["Project already exists", "Existing project"]]);
    expect(h.createCalls).toEqual([]);
    expect(h.routerReplace).toEqual([
      {
        pathname: "/new/draft",
        params: {
          environmentId: ENV_ALPHA,
          projectId: "project-existing",
          title: "Existing project",
        },
      },
    ]);
  });

  it("when: project creation fails, stays on the screen", async () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      baseDirectory: "/home/dev/projects",
    });
    h.createImpl = async () => AsyncResult.failure(Cause.fail(new Error("create exploded")));

    const markup = render(<AddProjectLocalFolderScreen />);
    press(markup, "Add project");
    await flushAsync();

    expect(h.createCalls).toHaveLength(1);
    expect(h.routerReplace).toEqual([]);
  });

  it("when: a windows path targets a non-windows environment, rejects the submit", async () => {
    connectEnvironment({
      environmentId: ENV_ALPHA,
      label: "Alpha",
      os: "darwin",
      baseDirectory: "C:\\Users\\dev",
    });

    const markup = render(<AddProjectLocalFolderScreen />);
    press(markup, "Add project");
    await flushAsync();

    expect(h.createCalls).toEqual([]);
    expect(h.routerReplace).toEqual([]);
  });

  it("when: the environment has no base directory, starts from the home shorthand", () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", baseDirectory: null });

    render(<AddProjectLocalFolderScreen />);

    expect(h.textInputs[0]?.value).toBe("~/");
    expect(h.browseRequests).toEqual([{ environmentId: ENV_ALPHA, input: { partialPath: "~/" } }]);
  });
});

describe("AddProjectDestinationScreen", () => {
  it("when: cloning succeeds, creates the project from the cloned path", async () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", baseDirectory: "/srv" });
    h.params = {
      environmentId: ENV_ALPHA,
      remoteUrl: "git@github.com:acme/app.git",
      repositoryTitle: "acme/app",
    };
    h.cloneImpl = async () => AsyncResult.success({ cwd: "/srv/app" });

    const markup = render(<AddProjectDestinationScreen />);

    expect(markup).toContain("acme/app");
    expect(markup).toContain("git@github.com:acme/app.git");

    press(markup, "Clone project");
    await flushAsync();

    expect(h.cloneCalls).toEqual([
      {
        environmentId: ENV_ALPHA,
        input: { remoteUrl: "git@github.com:acme/app.git", destinationPath: "/srv" },
      },
    ]);
    expect(h.createCalls).toHaveLength(1);
    const call = h.createCalls[0] as { input: { workspaceRoot: string } };
    expect(call.input.workspaceRoot).toBe("/srv/app");
    expect(h.routerReplace).toEqual([
      {
        pathname: "/new/draft",
        params: { environmentId: ENV_ALPHA, projectId: "uuid-1", title: "app" },
      },
    ]);
  });

  it("when: cloning fails, does not create a project", async () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", baseDirectory: "/srv" });
    h.params = { environmentId: ENV_ALPHA, remoteUrl: "git@github.com:acme/app.git" };
    h.cloneImpl = async () => AsyncResult.failure(Cause.fail("clone exploded"));

    const markup = render(<AddProjectDestinationScreen />);
    press(markup, "Clone project");
    await flushAsync();

    expect(h.cloneCalls).toHaveLength(1);
    expect(h.createCalls).toEqual([]);
    expect(h.routerReplace).toEqual([]);
  });

  it("when: project creation fails after a clone, stays on the screen", async () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", baseDirectory: "/srv" });
    h.params = { environmentId: ENV_ALPHA, remoteUrl: "git@github.com:acme/app.git" };
    h.cloneImpl = async () => AsyncResult.success({ cwd: "/srv/app" });
    h.createImpl = async () => AsyncResult.failure(Cause.fail(new Error("create exploded")));

    const markup = render(<AddProjectDestinationScreen />);
    press(markup, "Clone project");
    await flushAsync();

    expect(h.createCalls).toHaveLength(1);
    expect(h.routerReplace).toEqual([]);
  });

  it("when: no remote url is provided, does not attempt a clone", async () => {
    connectEnvironment({ environmentId: ENV_ALPHA, label: "Alpha", baseDirectory: "/srv" });
    h.params = { environmentId: ENV_ALPHA };

    const markup = render(<AddProjectDestinationScreen />);

    expect(markup).not.toContain("data-error-banner");

    press(markup, "Clone project");
    await flushAsync();

    expect(h.cloneCalls).toEqual([]);
    expect(h.createCalls).toEqual([]);
  });

  it("when: no environment is available, shows the empty state", () => {
    h.params = { remoteUrl: "git@github.com:acme/app.git" };

    const markup = render(<AddProjectDestinationScreen />);

    expect(markup).toContain("No environments connected");
  });
});
