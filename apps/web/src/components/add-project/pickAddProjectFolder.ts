import type {
  DesktopWslState,
  EnvironmentId,
  LocalApi,
  PickFolderOptions,
} from "@t4code/contracts";

import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
  type WslEnvironmentCandidate,
} from "~/wslPaths";

import type { AddProjectHostOption } from "./AddProjectDialog.logic";

export type PickAddProjectFolderResult =
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Selected"; readonly environmentId: EnvironmentId; readonly path: string }
  | { readonly _tag: "Failure"; readonly message: string };

export interface PickAddProjectFolderInput {
  readonly host: AddProjectHostOption;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly initialPath: string;
  readonly dialogs: Pick<LocalApi["dialogs"], "pickFolder">;
  readonly getWslState: () => Promise<DesktopWslState | null>;
  readonly primaryRunningDistro: string | null;
  readonly wslCandidates: ReadonlyArray<WslEnvironmentCandidate<EnvironmentId>>;
}

export async function pickAddProjectFolder(
  input: PickAddProjectFolderInput,
): Promise<PickAddProjectFolderResult> {
  const wslState =
    input.host.isPrimary && input.host.platform === "Linux"
      ? await input.getWslState().catch(() => null)
      : null;
  const targetEnvironmentId = resolveProjectPickerTarget({
    browseEnvironmentId: input.host.environmentId,
    primaryEnvironmentId: input.primaryEnvironmentId,
    desktopInstanceId: input.host.desktopInstanceId,
    wslConfiguration: wslState,
  });
  const options: PickFolderOptions = {
    initialPath: input.initialPath,
    ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
  };
  const pickedPath = await input.dialogs.pickFolder(options);
  if (!pickedPath) return { _tag: "Cancelled" };
  if (!parseWslUncPath(pickedPath)) {
    return {
      _tag: "Selected",
      environmentId: input.host.environmentId,
      path: pickedPath,
    };
  }

  const selection = resolveWslProjectSelection(
    pickedPath,
    applyWslEnvironmentConfiguration(
      input.wslCandidates,
      input.primaryEnvironmentId,
      wslState,
      input.primaryRunningDistro,
    ),
  );
  return selection
    ? {
        _tag: "Selected",
        environmentId: selection.environmentId,
        path: selection.linuxPath,
      }
    : {
        _tag: "Failure",
        message: "Start the matching WSL backend, then choose the folder again.",
      };
}
