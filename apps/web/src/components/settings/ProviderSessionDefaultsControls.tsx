import type {
  ProviderDriverKind,
  ProviderSessionDefault,
  ServerProviderModel,
} from "@t4code/contracts";
import { useId, useRef } from "react";
import {
  getProviderSessionDefaultControls,
  type ProviderSessionDefaultChange,
  updateProviderSessionDefault,
} from "@t4code/shared/providerSessionDefaults";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

interface ProviderSessionDefaultsControlsProps {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly value: ProviderSessionDefault | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderSessionDefault) => void;
}

export function ProviderSessionDefaultsControls({
  driver,
  models,
  value,
  disabled,
  onChange,
}: ProviderSessionDefaultsControlsProps) {
  const idPrefix = useId();
  const modelLabels = useRef(new Map<string, string>());
  const modelId = `${idPrefix}-model`;
  const effortId = `${idPrefix}-effort`;
  const fastModeId = `${idPrefix}-fast-mode`;
  const controls = getProviderSessionDefaultControls({
    driver,
    models,
    ...(value ? { configuredDefault: value } : {}),
  });
  const modelDisabled = disabled;
  const selectedModel = controls.modelAvailable ? controls.resolvedModel : controls.configuredModel;
  const selectedServerModel = models.find((model) => model.slug === selectedModel);
  if (selectedServerModel)
    modelLabels.current.set(selectedServerModel.slug, selectedServerModel.name);
  const modelLabel =
    selectedServerModel?.name ?? modelLabels.current.get(selectedModel) ?? selectedModel;

  const change = (next: ProviderSessionDefaultChange) => {
    onChange(
      updateProviderSessionDefault({
        driver,
        models,
        change: next,
        ...(value ? { current: value } : {}),
      }),
    );
  };

  return (
    <div
      className="grid gap-3 pt-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-end"
      data-testid="provider-session-defaults"
    >
      <div className="min-w-0 space-y-1">
        <label className="text-sm font-medium" htmlFor={modelId}>
          Default model
        </label>
        <Select
          disabled={modelDisabled}
          value={selectedModel}
          onValueChange={(next) => {
            if (next) change({ type: "model", value: next });
          }}
        >
          <SelectTrigger aria-label="Default model" id={modelId}>
            <SelectValue>{modelLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {!controls.modelAvailable ? (
              <SelectItem disabled value={controls.configuredModel}>
                {controls.configuredModel}
              </SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model.slug} value={model.slug}>
                {model.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {!controls.modelAvailable ? (
          <p className="text-muted-foreground text-xs">
            Unavailable here; new sessions will use {controls.resolvedModel}.
          </p>
        ) : null}
      </div>

      {controls.effortDescriptor ? (
        <div className="min-w-0 space-y-1">
          <label className="text-sm font-medium" htmlFor={effortId}>
            Default effort
          </label>
          <Select
            disabled={disabled}
            value={controls.effort ?? undefined}
            onValueChange={(next) => {
              if (next) change({ type: "effort", value: next });
            }}
          >
            <SelectTrigger aria-label="Default effort" id={effortId}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {controls.effortDescriptor.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}

      {controls.fastModeSupported ? (
        <div className="flex min-h-9 items-center gap-2 sm:pb-0.5">
          <label className="text-sm font-medium" htmlFor={fastModeId}>
            Fast by default
          </label>
          <Switch
            aria-label="Fast by default"
            checked={controls.fastMode ?? false}
            disabled={disabled}
            id={fastModeId}
            onCheckedChange={(next) => change({ type: "fastMode", value: Boolean(next) })}
          />
        </div>
      ) : null}
    </div>
  );
}

export type { ProviderSessionDefaultsControlsProps };
