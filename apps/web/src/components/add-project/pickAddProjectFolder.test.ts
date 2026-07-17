import { EnvironmentId } from "@t4code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WslEnvironmentCandidate } from "~/wslPaths";

import type { AddProjectHostOption } from "./AddProjectDialog.logic";
import { pickAddProjectFolder, type PickAddProjectFolderInput } from "./pickAddProjectFolder";

const ENV_PRIMARY = EnvironmentId.make("primary");
const ENV_WSL = EnvironmentId.make("wsl");

const primaryHost: AddProjectHostOption = {
  environmentId: ENV_PRIMARY,
  label: "Local",
  platform: "MacIntel",
  baseDirectory: "~/",
  isPrimary: true,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};

const wslHost: AddProjectHostOption = {
  environmentId: ENV_WSL,
  label: "Ubuntu",
  platform: "Linux",
  baseDirectory: "~/",
  isPrimary: false,
  desktopInstanceId: "wsl:Ubuntu",
  nativePickerAvailable: true,
};

function makeInput(
  options: {
    readonly host?: AddProjectHostOption;
    readonly pickedPath?: string | null;
    readonly wslCandidates?: ReadonlyArray<WslEnvironmentCandidate<EnvironmentId>>;
  } = {},
): PickAddProjectFolderInput & {
  readonly dialogs: { readonly pickFolder: ReturnType<typeof vi.fn> };
} {
  const pickFolder = vi.fn(async () => options.pickedPath ?? null);
  return {
    host: options.host ?? primaryHost,
    primaryEnvironmentId: ENV_PRIMARY,
    initialPath: "~/",
    dialogs: { pickFolder },
    getWslState: async () => ({
      enabled: true,
      wslOnly: false,
      distro: null,
      available: true,
      distros: [],
      preflightError: null,
    }),
    primaryRunningDistro: null,
    wslCandidates: options.wslCandidates ?? [],
  };
}

describe("pickAddProjectFolder", () => {
  it("returns cancellation without an error", async () => {
    const result = await pickAddProjectFolder(makeInput({ pickedPath: null }));
    expect(result).toEqual({ _tag: "Cancelled" });
  });

  it("returns a primary local selection", async () => {
    const result = await pickAddProjectFolder(makeInput({ pickedPath: "/Users/me/code" }));
    expect(result).toEqual({
      _tag: "Selected",
      environmentId: EnvironmentId.make("primary"),
      path: "/Users/me/code",
    });
  });

  it("targets a mapped WSL backend and returns its Linux path", async () => {
    const input = makeInput({
      host: wslHost,
      pickedPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\code",
      wslCandidates: [
        {
          environmentId: EnvironmentId.make("wsl"),
          backendId: "wsl:Ubuntu",
          runningDistro: "Ubuntu",
        },
      ],
    });
    const result = await pickAddProjectFolder(input);
    expect(input.dialogs.pickFolder).toHaveBeenCalledWith({
      initialPath: "~/",
      targetEnvironmentId: "wsl:Ubuntu",
    });
    expect(result).toEqual({
      _tag: "Selected",
      environmentId: EnvironmentId.make("wsl"),
      path: "/home/me/code",
    });
  });

  it("rejects an unmatched WSL selection", async () => {
    const result = await pickAddProjectFolder(
      makeInput({
        pickedPath: "\\\\wsl.localhost\\Fedora\\srv\\code",
        wslCandidates: [],
      }),
    );
    expect(result).toEqual({
      _tag: "Failure",
      message: "Start the matching WSL backend, then choose the folder again.",
    });
  });
});
