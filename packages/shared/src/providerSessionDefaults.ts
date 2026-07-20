import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ProviderSessionDefault,
  type SelectProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t4code/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  resolveSelectableModel,
} from "./model.ts";

export const PROVIDER_SESSION_EFFORT_OPTION_IDS = [
  "reasoningEffort",
  "effort",
  "reasoning",
] as const;

export type ProviderSessionDefaultFallbackReason =
  | "configured-model-unavailable"
  | "models-unavailable";

export interface ProviderSessionDefaultFallback {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly configuredModel: string;
  readonly resolvedModel: string;
  readonly reason: ProviderSessionDefaultFallbackReason;
}

export interface ResolvedProviderSessionDefault {
  readonly modelSelection: ModelSelection;
  readonly effort: string | null;
  readonly fastMode: boolean | null;
  readonly configuredModelAvailable: boolean;
  readonly fallback: ProviderSessionDefaultFallback | null;
}

export interface ProviderSessionDefaultControls {
  readonly configuredModel: string;
  readonly resolvedModel: string;
  readonly modelAvailable: boolean;
  readonly effortDescriptor: SelectProviderOptionDescriptor | null;
  readonly effort: string | null;
  readonly fastModeSupported: boolean;
  readonly fastMode: boolean | null;
}

export type ProviderSessionDefaultChange =
  | { readonly type: "model"; readonly value: string }
  | { readonly type: "effort"; readonly value: string }
  | { readonly type: "fastMode"; readonly value: boolean };

interface NormalizedProviderOptions {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly effortDescriptor: SelectProviderOptionDescriptor | null;
  readonly effort: string | null;
  readonly fastModeSupported: boolean;
  readonly fastMode: boolean | null;
}

const FAST_MODE_OPTION_ID = "fastMode";
const SERVICE_TIER_OPTION_ID = "serviceTier";
const FAST_SERVICE_TIER_VALUE = "fast";
const DEFAULT_SERVICE_TIER_VALUE = "default";

function selectableModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<{ readonly slug: string; readonly name: string }> {
  return models.map(({ slug, name }) => ({ slug, name }));
}

function getFallbackModel(models: ReadonlyArray<ServerProviderModel>): ServerProviderModel | null {
  return models.find((model) => !model.isCustom) ?? models[0] ?? null;
}

function getProviderDefaultModel(driver: ProviderDriverKind): string {
  return DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
}

function findSelectableModel(
  driver: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  value: string,
): ServerProviderModel | null {
  const slug = resolveSelectableModel(driver, value, selectableModels(models));
  if (!slug) {
    return null;
  }
  return models.find((model) => model.slug === slug) ?? null;
}

function findEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): SelectProviderOptionDescriptor | null {
  for (const id of PROVIDER_SESSION_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find(
      (candidate): candidate is SelectProviderOptionDescriptor =>
        candidate.id === id && candidate.type === "select",
    );
    if (descriptor) {
      return descriptor;
    }
  }
  return null;
}

function getFastModeDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ProviderOptionDescriptor | null {
  const booleanDescriptor = descriptors.find(
    (descriptor) => descriptor.id === FAST_MODE_OPTION_ID && descriptor.type === "boolean",
  );
  if (booleanDescriptor) {
    return booleanDescriptor;
  }

  return (
    descriptors.find(
      (descriptor) =>
        descriptor.id === SERVICE_TIER_OPTION_ID &&
        descriptor.type === "select" &&
        descriptor.options.some((option) => option.id === FAST_SERVICE_TIER_VALUE),
    ) ?? null
  );
}

function normalizeProviderOptions(
  model: ServerProviderModel | null,
  selections?: ReadonlyArray<ProviderOptionSelection> | null,
): NormalizedProviderOptions {
  if (!model?.capabilities) {
    return {
      descriptors: [],
      effortDescriptor: null,
      effort: null,
      fastModeSupported: false,
      fastMode: null,
    };
  }

  const descriptors = getProviderOptionDescriptors({
    caps: model.capabilities,
    selections,
  });
  const effortDescriptor = findEffortDescriptor(descriptors);
  const effortValue = getProviderOptionCurrentValue(effortDescriptor);
  const fastModeDescriptor = getFastModeDescriptor(descriptors);
  const fastModeValue = getProviderOptionCurrentValue(fastModeDescriptor);

  return {
    descriptors,
    effortDescriptor,
    effort: typeof effortValue === "string" ? effortValue : null,
    fastModeSupported: fastModeDescriptor !== null,
    fastMode:
      fastModeDescriptor?.type === "boolean"
        ? typeof fastModeValue === "boolean"
          ? fastModeValue
          : null
        : fastModeDescriptor?.type === "select"
          ? fastModeValue === FAST_SERVICE_TIER_VALUE
          : null,
  };
}

function getPreferredSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly projectSelection?: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
}): ModelSelection | null {
  if (input.explicitSelection?.instanceId === input.instanceId) {
    return input.explicitSelection;
  }
  if (input.projectSelection?.instanceId === input.instanceId) {
    return input.projectSelection;
  }
  return null;
}

export function resolveProviderSessionDefault(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredDefault?: ProviderSessionDefault | null;
  readonly projectSelection?: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
}): ResolvedProviderSessionDefault {
  const preferredSelection = getPreferredSelection(input);
  const fallbackModel = getFallbackModel(input.models);
  const configuredModel =
    preferredSelection?.model ??
    input.configuredDefault?.model ??
    fallbackModel?.slug ??
    getProviderDefaultModel(input.driver);
  const configuredServerModel = findSelectableModel(input.driver, input.models, configuredModel);
  const resolvedServerModel = configuredServerModel ?? fallbackModel;
  const resolvedModel =
    resolvedServerModel?.slug ??
    (input.models.length === 0 ? getProviderDefaultModel(input.driver) : configuredModel);
  const selections = preferredSelection
    ? preferredSelection.options
    : input.configuredDefault?.options;
  const normalizedOptions = normalizeProviderOptions(resolvedServerModel, selections);
  const fallbackReason: ProviderSessionDefaultFallbackReason | null = configuredServerModel
    ? null
    : input.models.length === 0
      ? "models-unavailable"
      : "configured-model-unavailable";

  return {
    modelSelection: createModelSelection(
      input.instanceId,
      resolvedModel,
      buildProviderOptionSelectionsFromDescriptors(normalizedOptions.descriptors),
    ),
    effort: normalizedOptions.effort,
    fastMode: normalizedOptions.fastMode,
    configuredModelAvailable: configuredServerModel !== null,
    fallback: fallbackReason
      ? {
          driver: input.driver,
          instanceId: input.instanceId,
          configuredModel,
          resolvedModel,
          reason: fallbackReason,
        }
      : null,
  };
}

export function getProviderSessionDefaultControls(input: {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredDefault?: ProviderSessionDefault | null;
}): ProviderSessionDefaultControls {
  const fallbackModel = getFallbackModel(input.models);
  const configuredModel =
    input.configuredDefault?.model ?? fallbackModel?.slug ?? getProviderDefaultModel(input.driver);
  const configuredServerModel = findSelectableModel(input.driver, input.models, configuredModel);
  const resolvedServerModel = configuredServerModel ?? fallbackModel;
  const resolvedModel =
    input.models.length === 0 ? configuredModel : (resolvedServerModel?.slug ?? configuredModel);
  const normalizedOptions = normalizeProviderOptions(
    resolvedServerModel,
    input.configuredDefault?.options,
  );

  return {
    configuredModel,
    resolvedModel,
    modelAvailable: configuredServerModel !== null,
    effortDescriptor: normalizedOptions.effortDescriptor,
    effort: normalizedOptions.effort,
    fastModeSupported: normalizedOptions.fastModeSupported,
    fastMode: normalizedOptions.fastMode,
  };
}

function replaceSelection(
  selections: ReadonlyArray<ProviderOptionSelection>,
  replacement: ProviderOptionSelection,
): Array<ProviderOptionSelection> {
  return [...selections.filter((selection) => selection.id !== replacement.id), replacement];
}

function buildPersistedSelections(
  normalizedOptions: NormalizedProviderOptions,
): Array<ProviderOptionSelection> | undefined {
  const selections: Array<ProviderOptionSelection> = [];
  const effortValue = getProviderOptionCurrentValue(normalizedOptions.effortDescriptor);
  if (normalizedOptions.effortDescriptor && typeof effortValue === "string") {
    selections.push({
      id: normalizedOptions.effortDescriptor.id,
      value: effortValue,
    });
  }

  const fastModeDescriptor = getFastModeDescriptor(normalizedOptions.descriptors);
  const fastModeValue = getProviderOptionCurrentValue(fastModeDescriptor);
  if (fastModeDescriptor?.type === "boolean" && typeof fastModeValue === "boolean") {
    selections.push({ id: fastModeDescriptor.id, value: fastModeValue });
  } else if (fastModeDescriptor?.type === "select" && typeof fastModeValue === "string") {
    selections.push({ id: fastModeDescriptor.id, value: fastModeValue });
  }

  return selections.length > 0 ? selections : undefined;
}

export function updateProviderSessionDefault(input: {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly current?: ProviderSessionDefault | null;
  readonly change: ProviderSessionDefaultChange;
}): ProviderSessionDefault {
  const fallbackModel = getFallbackModel(input.models);
  const currentModel =
    input.current?.model ?? fallbackModel?.slug ?? getProviderDefaultModel(input.driver);
  const requestedModel =
    input.change.type === "model" ? input.change.value.trim() || currentModel : currentModel;
  const configuredServerModel = findSelectableModel(input.driver, input.models, requestedModel);
  const selectedServerModel =
    configuredServerModel ?? (input.change.type === "model" ? null : fallbackModel);
  const persistedModel =
    input.change.type === "model" && configuredServerModel
      ? configuredServerModel.slug
      : requestedModel;

  if (!selectedServerModel) {
    return { model: persistedModel };
  }

  let selections = input.current?.options ? [...input.current.options] : [];
  let normalizedOptions = normalizeProviderOptions(selectedServerModel, selections);

  if (input.change.type === "effort" && normalizedOptions.effortDescriptor) {
    selections = replaceSelection(selections, {
      id: normalizedOptions.effortDescriptor.id,
      value: input.change.value,
    });
    normalizedOptions = normalizeProviderOptions(selectedServerModel, selections);
  } else if (input.change.type === "fastMode") {
    const fastModeDescriptor = getFastModeDescriptor(normalizedOptions.descriptors);
    if (fastModeDescriptor?.type === "boolean") {
      selections = replaceSelection(selections, {
        id: fastModeDescriptor.id,
        value: input.change.value,
      });
      normalizedOptions = normalizeProviderOptions(selectedServerModel, selections);
    } else if (fastModeDescriptor?.type === "select") {
      selections = replaceSelection(selections, {
        id: fastModeDescriptor.id,
        value: input.change.value ? FAST_SERVICE_TIER_VALUE : DEFAULT_SERVICE_TIER_VALUE,
      });
      normalizedOptions = normalizeProviderOptions(selectedServerModel, selections);
    }
  }

  const persistedSelections = buildPersistedSelections(normalizedOptions);
  return persistedSelections
    ? { model: persistedModel, options: persistedSelections }
    : { model: persistedModel };
}
