"use client";

import { scopeProjectRef } from "@t4code/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t4code/client-runtime/state/runtime";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProviderInstanceId,
} from "@t4code/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget, desktopLocalBackendId } from "~/connection/desktopLocal";
import { useDesktopLocalBootstraps } from "~/connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { readLocalApi } from "~/localApi";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  defaultAddProjectParent,
  getEnvironmentBrowsePlatform,
  joinProjectPath,
  shouldUseNativePicker,
  validateAddProjectPath,
  validateGitCloneParentPath,
  validateGitCloneUrl,
  validateProjectName,
  type AddProjectHostOption,
  type AddProjectStep,
} from "./AddProjectDialog.logic";
import { createAddProjectOperations, type AddProjectCommandResult } from "./addProjectOperations";
import { pickAddProjectFolder, type PickAddProjectFolderResult } from "./pickAddProjectFolder";

export interface AddProjectWorkflow {
  readonly hosts: ReadonlyArray<AddProjectHostOption>;
  readonly selectedHost: AddProjectHostOption;
  readonly step: AddProjectStep;
  readonly busy: boolean;
  readonly hostPath: string;
  readonly cloneUrl: string;
  readonly cloneParent: string;
  readonly createName: string;
  readonly createParent: string;
  readonly error: string | null;
  readonly canPickParent: boolean;
  readonly selectHost: (environmentId: EnvironmentId) => void;
  readonly back: () => void;
  readonly browse: () => Promise<void>;
  readonly setHostPath: (path: string) => void;
  readonly submitHostPath: () => Promise<void>;
  readonly openClone: () => void;
  readonly setCloneUrl: (url: string) => void;
  readonly setCloneParent: (path: string) => void;
  readonly pickCloneParent: () => Promise<void>;
  readonly submitClone: () => Promise<void>;
  readonly openCreate: () => void;
  readonly setCreateName: (name: string) => void;
  readonly setCreateParent: (path: string) => void;
  readonly pickCreateParent: () => Promise<void>;
  readonly submitCreate: () => Promise<void>;
}

export interface AddProjectWorkflowStateInput {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly hosts: ReadonlyArray<AddProjectHostOption>;
  readonly primaryEnvironmentId: EnvironmentId;
  readonly operations: Pick<
    ReturnType<typeof createAddProjectOperations>,
    "addFolder" | "clone" | "create"
  >;
  readonly pickFolder: (
    host: AddProjectHostOption,
    initialPath: string,
  ) => Promise<PickAddProjectFolderResult>;
}

function fallbackHost(primaryEnvironmentId: EnvironmentId): AddProjectHostOption {
  return {
    environmentId: primaryEnvironmentId,
    label: "This device",
    platform: getEnvironmentBrowsePlatform(undefined),
    baseDirectory: "~/",
    isPrimary: true,
    desktopInstanceId: null,
    nativePickerAvailable: typeof window !== "undefined" && window.desktopBridge !== undefined,
  };
}

function primaryHost(input: AddProjectWorkflowStateInput): AddProjectHostOption {
  return (
    input.hosts.find((host) => host.environmentId === input.primaryEnvironmentId) ??
    input.hosts[0] ??
    fallbackHost(input.primaryEnvironmentId)
  );
}

function unexpectedErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

export function useAddProjectWorkflowState(
  input: AddProjectWorkflowStateInput,
): AddProjectWorkflow {
  const initialHost = primaryHost(input);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(initialHost.environmentId);
  const [step, setStep] = useState<AddProjectStep>("start");
  const [busy, setBusy] = useState(false);
  const [hostPath, setHostPathState] = useState(initialHost.baseDirectory);
  const [cloneUrl, setCloneUrlState] = useState("");
  const [cloneParent, setCloneParentState] = useState(initialHost.baseDirectory);
  const [createName, setCreateNameState] = useState("");
  const [createParent, setCreateParentState] = useState(initialHost.baseDirectory);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const openRef = useRef(input.open);
  const previousOpenRef = useRef(false);
  openRef.current = input.open;

  const selectedHost =
    input.hosts.find((host) => host.environmentId === selectedEnvironmentId) ?? initialHost;

  const resetForHost = useCallback((host: AddProjectHostOption) => {
    setSelectedEnvironmentId(host.environmentId);
    setStep("start");
    setBusy(false);
    busyRef.current = false;
    setHostPathState(host.baseDirectory);
    setCloneUrlState("");
    setCloneParentState(host.baseDirectory);
    setCreateNameState("");
    setCreateParentState(host.baseDirectory);
    setError(null);
  }, []);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = input.open;
    if (input.open && !wasOpen) {
      generationRef.current += 1;
      resetForHost(primaryHost(input));
      return;
    }
    if (!input.open && wasOpen) {
      generationRef.current += 1;
      setBusy(false);
      busyRef.current = false;
    }
  }, [input.open, input.hosts, input.primaryEnvironmentId, resetForHost]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      openRef.current = false;
    },
    [],
  );

  const isCurrent = useCallback(
    (generation: number) => generationRef.current === generation && openRef.current,
    [],
  );

  const beginAsync = useCallback((): number | null => {
    if (!openRef.current || busyRef.current) {
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    return generationRef.current;
  }, []);

  const finishAsync = useCallback(
    (generation: number) => {
      if (!isCurrent(generation)) {
        return;
      }
      busyRef.current = false;
      setBusy(false);
    },
    [isCurrent],
  );

  const closeAfterSuccess = useCallback(
    (generation: number) => {
      if (!isCurrent(generation)) {
        return;
      }
      busyRef.current = false;
      setBusy(false);
      generationRef.current += 1;
      input.onOpenChange(false);
    },
    [input.onOpenChange, isCurrent],
  );

  const completeOperation = useCallback(
    async (generation: number, operation: (shouldContinue: () => boolean) => Promise<boolean>) => {
      const shouldContinue = () => isCurrent(generation);
      try {
        const succeeded = await operation(shouldContinue);
        if (!isCurrent(generation)) {
          return;
        }
        if (succeeded) {
          closeAfterSuccess(generation);
        } else {
          finishAsync(generation);
        }
      } catch (cause) {
        if (isCurrent(generation)) {
          finishAsync(generation);
          setError(unexpectedErrorMessage(cause));
        }
      }
    },
    [closeAfterSuccess, finishAsync, isCurrent],
  );

  const selectHost = useCallback(
    (environmentId: EnvironmentId) => {
      const nextHost = input.hosts.find((host) => host.environmentId === environmentId);
      if (nextHost === undefined || nextHost.environmentId === selectedHost.environmentId) {
        return;
      }
      generationRef.current += 1;
      resetForHost(nextHost);
    },
    [input.hosts, resetForHost, selectedHost.environmentId],
  );

  const back = useCallback(() => {
    generationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setStep("start");
    setError(null);
  }, []);

  const browse = useCallback(async () => {
    if (!shouldUseNativePicker(selectedHost)) {
      setStep("host-path");
      setError(null);
      return;
    }
    const generation = beginAsync();
    if (generation === null) {
      return;
    }
    try {
      const picked = await input.pickFolder(selectedHost, hostPath);
      if (!isCurrent(generation)) {
        return;
      }
      if (picked._tag === "Cancelled") {
        finishAsync(generation);
        return;
      }
      if (picked._tag === "Failure") {
        finishAsync(generation);
        setError(picked.message);
        return;
      }
      await completeOperation(generation, (shouldContinue) =>
        input.operations.addFolder({
          environmentId: picked.environmentId,
          workspaceRoot: picked.path,
          shouldContinue,
        }),
      );
    } catch (cause) {
      if (isCurrent(generation)) {
        finishAsync(generation);
        setError(unexpectedErrorMessage(cause));
      }
    }
  }, [
    beginAsync,
    completeOperation,
    finishAsync,
    hostPath,
    input.operations,
    input.pickFolder,
    isCurrent,
    selectedHost,
  ]);

  const submitHostPath = useCallback(async () => {
    const validationError = validateAddProjectPath(hostPath, selectedHost.platform);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    const generation = beginAsync();
    if (generation === null) {
      return;
    }
    await completeOperation(generation, (shouldContinue) =>
      input.operations.addFolder({
        environmentId: selectedHost.environmentId,
        workspaceRoot: hostPath.trim(),
        shouldContinue,
      }),
    );
  }, [beginAsync, completeOperation, hostPath, input.operations, selectedHost]);

  const openClone = useCallback(() => {
    setStep("clone");
    setError(null);
  }, []);

  const openCreate = useCallback(() => {
    setStep("create");
    setError(null);
  }, []);

  const pickParent = useCallback(
    async (kind: "clone" | "create") => {
      if (!shouldUseNativePicker(selectedHost)) {
        return;
      }
      const generation = beginAsync();
      if (generation === null) {
        return;
      }
      const initialPath = kind === "clone" ? cloneParent : createParent;
      try {
        const picked = await input.pickFolder(selectedHost, initialPath);
        if (!isCurrent(generation)) {
          return;
        }
        if (picked._tag === "Cancelled") {
          finishAsync(generation);
          return;
        }
        if (picked._tag === "Failure") {
          finishAsync(generation);
          setError(picked.message);
          return;
        }
        const routedHost = input.hosts.find((host) => host.environmentId === picked.environmentId);
        if (routedHost === undefined) {
          finishAsync(generation);
          setError("The selected folder host is unavailable.");
          return;
        }
        if (routedHost.environmentId !== selectedHost.environmentId) {
          generationRef.current += 1;
          setSelectedEnvironmentId(routedHost.environmentId);
          setHostPathState(routedHost.baseDirectory);
        }
        busyRef.current = false;
        setBusy(false);
        setError(null);
        if (kind === "clone") {
          setStep("clone");
          setCloneParentState(picked.path);
        } else {
          setStep("create");
          setCreateParentState(picked.path);
        }
      } catch (cause) {
        if (isCurrent(generation)) {
          finishAsync(generation);
          setError(unexpectedErrorMessage(cause));
        }
      }
    },
    [
      beginAsync,
      cloneParent,
      createParent,
      finishAsync,
      input.hosts,
      input.pickFolder,
      isCurrent,
      selectedHost,
    ],
  );

  const submitClone = useCallback(async () => {
    const validationError =
      validateGitCloneUrl(cloneUrl) ?? validateGitCloneParentPath(cloneParent);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    const generation = beginAsync();
    if (generation === null) {
      return;
    }
    await completeOperation(generation, (shouldContinue) =>
      input.operations.clone({
        environmentId: selectedHost.environmentId,
        url: cloneUrl.trim(),
        parentDir: cloneParent.trim(),
        shouldContinue,
      }),
    );
  }, [
    beginAsync,
    cloneParent,
    cloneUrl,
    completeOperation,
    input.operations,
    selectedHost.environmentId,
  ]);

  const submitCreate = useCallback(async () => {
    const validationError =
      validateProjectName(createName) ??
      validateAddProjectPath(createParent, selectedHost.platform);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    const generation = beginAsync();
    if (generation === null) {
      return;
    }
    await completeOperation(generation, (shouldContinue) =>
      input.operations.create({
        environmentId: selectedHost.environmentId,
        workspaceRoot: joinProjectPath(createParent, createName, selectedHost.platform),
        shouldContinue,
      }),
    );
  }, [beginAsync, completeOperation, createName, createParent, input.operations, selectedHost]);

  const setHostPath = useCallback((path: string) => {
    setHostPathState(path);
    setError(null);
  }, []);
  const setCloneUrl = useCallback((url: string) => {
    setCloneUrlState(url);
    setError(null);
  }, []);
  const setCloneParent = useCallback((path: string) => {
    setCloneParentState(path);
    setError(null);
  }, []);
  const setCreateName = useCallback((name: string) => {
    setCreateNameState(name);
    setError(null);
  }, []);
  const setCreateParent = useCallback((path: string) => {
    setCreateParentState(path);
    setError(null);
  }, []);

  return {
    hosts: input.hosts,
    selectedHost,
    step,
    busy,
    hostPath,
    cloneUrl,
    cloneParent,
    createName,
    createParent,
    error,
    canPickParent: shouldUseNativePicker(selectedHost),
    selectHost,
    back,
    browse,
    setHostPath,
    submitHostPath,
    openClone,
    setCloneUrl,
    setCloneParent,
    pickCloneParent: () => pickParent("clone"),
    submitClone,
    openCreate,
    setCreateName,
    setCreateParent,
    pickCreateParent: () => pickParent("create"),
    submitCreate,
  };
}

function adaptAtomResult<T, E>(result: AtomCommandResult<T, E>): AddProjectCommandResult<T> {
  if (result._tag === "Success") {
    return { _tag: "Success", value: result.value as T };
  }
  return {
    _tag: "Failure",
    error: isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result),
  };
}

function readPrimaryRunningDistro(): string | null {
  if (typeof window === "undefined" || window.desktopBridge === undefined) {
    return null;
  }
  try {
    return (
      window.desktopBridge
        .getLocalEnvironmentBootstraps()
        .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ?? null
    );
  } catch {
    return null;
  }
}

export function useAddProjectWorkflow(input: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): AddProjectWorkflow {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const projects = useProjects();
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cloneRepository = useAtomCommand(vcsEnvironment.clone, { reportFailure: false });
  const primaryEnvironmentId =
    primaryEnvironment?.environmentId ?? EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

  const hosts = useMemo((): ReadonlyArray<AddProjectHostOption> => {
    const catalogHosts = environments.map((environment): AddProjectHostOption => {
      const isPrimary = environment.environmentId === primaryEnvironment?.environmentId;
      const desktopInstanceId = isDesktopLocalConnectionTarget(environment.entry.target)
        ? (desktopLocalBootstraps.find(
            (bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl,
          )?.id ?? null)
        : null;
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        platform: getEnvironmentBrowsePlatform(environment.serverConfig?.environment.platform.os),
        baseDirectory: defaultAddProjectParent(
          environment.serverConfig?.settings?.addProjectBaseDirectory,
        ),
        isPrimary,
        desktopInstanceId,
        nativePickerAvailable: typeof window !== "undefined" && window.desktopBridge !== undefined,
      };
    });
    return catalogHosts.length > 0 ? catalogHosts : [fallbackHost(primaryEnvironmentId)];
  }, [
    desktopLocalBootstraps,
    environments,
    primaryEnvironment?.environmentId,
    primaryEnvironmentId,
  ]);

  const operations = useMemo(
    () =>
      createAddProjectOperations({
        getProjects: () => projectsRef.current,
        createProject: async (commandInput) =>
          adaptAtomResult(
            mapAtomCommandResult(
              await createProject({
                environmentId: commandInput.environmentId,
                input: {
                  projectId: commandInput.projectId,
                  title: commandInput.title,
                  workspaceRoot: commandInput.workspaceRoot,
                  createWorkspaceRootIfMissing: commandInput.createWorkspaceRootIfMissing,
                  initializeGit: commandInput.initializeGit,
                  defaultModelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: DEFAULT_MODEL,
                  },
                },
              }),
              () => undefined,
            ),
          ),
        cloneRepository: async (commandInput) =>
          adaptAtomResult(
            await cloneRepository({
              environmentId: commandInput.environmentId,
              input: {
                url: commandInput.url,
                parentDir: commandInput.parentDir,
              },
            }),
          ),
        openProject: async (commandInput) =>
          adaptAtomResult(
            await settlePromise(() =>
              handleNewThread(scopeProjectRef(commandInput.environmentId, commandInput.projectId)),
            ),
          ),
        reportFailure: (title, error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title,
              description: unexpectedErrorMessage(error),
            }),
          );
        },
      }),
    [cloneRepository, createProject, handleNewThread],
  );

  const wslCandidates = useMemo(
    () =>
      environments.flatMap((environment) => {
        const backendId = desktopLocalBackendId(environment.entry.target);
        if (backendId === null) {
          return [];
        }
        const bootstrap = desktopLocalBootstraps.find(
          (candidate) => candidate.httpBaseUrl === environment.displayUrl,
        );
        return [
          {
            environmentId: environment.environmentId,
            backendId,
            runningDistro: bootstrap?.runningDistro ?? null,
          },
        ];
      }),
    [desktopLocalBootstraps, environments],
  );

  const pickFolder = useCallback(
    async (
      host: AddProjectHostOption,
      initialPath: string,
    ): Promise<PickAddProjectFolderResult> => {
      const api = readLocalApi();
      if (api === undefined) {
        return { _tag: "Failure", message: "Folder picking is unavailable." };
      }
      return pickAddProjectFolder({
        host,
        primaryEnvironmentId,
        initialPath,
        dialogs: api.dialogs,
        getWslState: () =>
          typeof window === "undefined" || window.desktopBridge === undefined
            ? Promise.resolve(null)
            : window.desktopBridge.getWslState(),
        primaryRunningDistro: readPrimaryRunningDistro(),
        wslCandidates,
      });
    },
    [primaryEnvironmentId, wslCandidates],
  );

  return useAddProjectWorkflowState({
    ...input,
    hosts,
    primaryEnvironmentId,
    operations,
    pickFolder,
  });
}
