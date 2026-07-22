import { useCallback, useEffect, useRef, useState } from "react";
import { EnvironmentId } from "@t4code/contracts";
import type { UnifiedSettings } from "@t4code/contracts/settings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t4code/client-runtime/state/runtime";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { RemoteDirectoryPickerDialog } from "./RemoteDirectoryPickerDialog";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function WorktreeWorkspaceSetting() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const initialEnvironmentId =
    primaryEnvironment?.environmentId ?? environments[0]?.environmentId ?? null;
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    initialEnvironmentId,
  );

  useEffect(() => {
    if (
      selectedEnvironmentId === null ||
      !environments.some((environment) => environment.environmentId === selectedEnvironmentId)
    ) {
      setSelectedEnvironmentId(
        primaryEnvironment?.environmentId ?? environments[0]?.environmentId ?? null,
      );
    }
  }, [environments, primaryEnvironment?.environmentId, selectedEnvironmentId]);

  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === selectedEnvironmentId) ?? null;
  if (selectedEnvironment === null) {
    return (
      <SettingsRow
        title="Workspace"
        description="Connect a host to configure where new worktrees are created."
        control={
          <DraftInput
            value=""
            onCommit={() => undefined}
            disabled
            aria-label="Workspace directory"
          />
        }
      />
    );
  }

  return (
    <EnvironmentWorktreeWorkspaceSetting
      key={selectedEnvironment.environmentId}
      environment={selectedEnvironment}
      environments={environments}
      onSelectEnvironment={setSelectedEnvironmentId}
    />
  );
}

function EnvironmentWorktreeWorkspaceSetting({
  environment,
  environments,
  onSelectEnvironment,
}: {
  readonly environment: EnvironmentPresentation;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedWorkspace, setConfirmedWorkspace] = useState<{
    readonly value: string;
    readonly source: UnifiedSettings;
  } | null>(null);
  const connected = environment.connection.phase === "connected";

  useEffect(() => {
    if (confirmedWorkspace !== null && settings !== confirmedWorkspace.source) {
      setConfirmedWorkspace(null);
    }
  }, [confirmedWorkspace, settings]);

  const save = useCallback(
    async (worktreeBaseDirectory: string) => {
      setPending(true);
      const result = await updateSettings({ worktreeBaseDirectory });
      if (isAtomCommandInterrupted(result)) {
        setPending(false);
        return;
      }
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error && failure.message.trim().length > 0
            ? failure.message
            : "Workspace could not be saved.",
        );
      } else {
        setError(null);
        setConfirmedWorkspace({
          value: result.value?.worktreeBaseDirectory ?? worktreeBaseDirectory,
          source: latestSettings.current,
        });
      }
      setPending(false);
    },
    [updateSettings],
  );

  const configured = confirmedWorkspace?.value ?? settings.worktreeBaseDirectory;
  return (
    <>
      <SettingsRow
        title="Workspace"
        description={
          configured
            ? "New worktrees are created inside this host directory."
            : "Default: worktrees are stored next to each project."
        }
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : !connected ? (
            `Reconnect ${environment.label} to change Workspace.`
          ) : null
        }
        resetAction={
          configured && connected && !pending ? (
            <SettingResetButton label="Workspace" onClick={() => void save("")} />
          ) : null
        }
        control={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {environments.length > 1 ? (
              <Select
                value={environment.environmentId}
                disabled={pending}
                onValueChange={(value) => {
                  if (value !== null) onSelectEnvironment(EnvironmentId.make(value));
                }}
              >
                <SelectTrigger aria-label="Workspace host" className="w-full sm:w-40">
                  <SelectValue>{environment.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((candidate) => (
                    <SelectItem
                      hideIndicator
                      disabled={candidate.connection.phase !== "connected"}
                      key={candidate.environmentId}
                      value={candidate.environmentId}
                    >
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <DraftInput
              value={configured}
              onCommit={(value) => void save(value)}
              disabled={!connected || pending}
              aria-label="Workspace directory"
              spellCheck={false}
              className="w-full font-mono sm:w-72"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!connected || pending}
              onClick={() => setPickerOpen(true)}
            >
              Browse
            </Button>
          </div>
        }
      />
      <RemoteDirectoryPickerDialog
        open={pickerOpen}
        environmentId={environment.environmentId}
        initialPath={configured || "~"}
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          setPickerOpen(false);
          void save(path);
        }}
      />
    </>
  );
}
