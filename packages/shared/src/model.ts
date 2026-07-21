import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t4code/contracts";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");
const CODEX_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");
const SERVICE_TIER_OPTION_ID = "serviceTier";
const DEFAULT_SERVICE_TIER_VALUE = "default";
const FAST_SERVICE_TIER_VALUE = "fast";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);
  return selection?.value;
}

export function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | boolean | undefined {
  return getProviderOptionSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
  preservePromptInjectedSelections: boolean,
): string | undefined {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.length === 0) {
    return trimmed;
  }
  if (
    !preservePromptInjectedSelections &&
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function codexServiceTierDescriptor(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionDescriptor {
  const selectedTier = getProviderOptionStringSelectionValue(selections, SERVICE_TIER_OPTION_ID);
  return {
    id: SERVICE_TIER_OPTION_ID,
    label: "Service Tier",
    type: "select",
    options: [
      { id: DEFAULT_SERVICE_TIER_VALUE, label: "Standard", isDefault: true },
      { id: FAST_SERVICE_TIER_VALUE, label: "Fast" },
    ],
    currentValue:
      selectedTier === FAST_SERVICE_TIER_VALUE
        ? FAST_SERVICE_TIER_VALUE
        : DEFAULT_SERVICE_TIER_VALUE,
  };
}

function withCodexServiceTierInvariant(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  const descriptorIndex = descriptors.findIndex(
    (descriptor) => descriptor.id === SERVICE_TIER_OPTION_ID,
  );
  if (descriptorIndex === -1) {
    return [...descriptors, codexServiceTierDescriptor(selections)];
  }

  const descriptor = descriptors[descriptorIndex]!;
  if (descriptor.type !== "select") {
    const invariantDescriptor = codexServiceTierDescriptor(selections);
    return descriptors.map((candidate, index) =>
      index === descriptorIndex
        ? {
            ...invariantDescriptor,
            label: descriptor.label,
            ...(descriptor.description ? { description: descriptor.description } : {}),
          }
        : candidate,
    );
  }

  const seen = new Set<string>();
  const uniqueOptions = descriptor.options.filter((option) => {
    if (seen.has(option.id)) {
      return false;
    }
    seen.add(option.id);
    return true;
  });
  const hasCurrentOrDefault =
    descriptor.currentValue !== undefined || uniqueOptions.some((option) => option.isDefault);
  const hasDefault = seen.has(DEFAULT_SERVICE_TIER_VALUE);
  const hasFast = seen.has(FAST_SERVICE_TIER_VALUE);
  const options = [
    ...(hasDefault
      ? uniqueOptions
      : [
          {
            id: DEFAULT_SERVICE_TIER_VALUE,
            label: "Standard",
            ...(!hasCurrentOrDefault ? { isDefault: true } : {}),
          },
          ...uniqueOptions,
        ]),
    ...(hasFast ? [] : [{ id: FAST_SERVICE_TIER_VALUE, label: "Fast" }]),
  ];

  return descriptors.map((candidate, index) =>
    index === descriptorIndex ? { ...descriptor, options } : candidate,
  );
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
  preservePromptInjectedSelections: boolean,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (typeof rawCurrentValue === "boolean") {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }
    return descriptor;
  }
  const currentValue =
    typeof rawCurrentValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue, preservePromptInjectedSelections)
      : resolveDescriptorChoiceValue(
          descriptor,
          descriptor.currentValue,
          preservePromptInjectedSelections,
        );
  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;
    return rest;
  }
  return {
    ...descriptor,
    currentValue,
  };
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  preservePromptInjectedSelections?: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections, preservePromptInjectedSelections = false } = input;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
      preservePromptInjectedSelections,
    ),
  );
}

export function getProviderCapabilityDescriptors(input: {
  provider: ProviderDriverKind;
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  preservePromptInjectedSelections?: boolean;
  enforceCodexServiceTier?: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const {
    provider,
    caps,
    selections,
    preservePromptInjectedSelections = false,
    enforceCodexServiceTier = false,
  } = input;
  const liveDescriptors = caps.optionDescriptors ?? [];
  const shouldEnforceCodexServiceTiers =
    provider === CODEX_PROVIDER_DRIVER_KIND &&
    (enforceCodexServiceTier || liveDescriptors.length > 0 || (selections?.length ?? 0) > 0);
  const optionDescriptors = shouldEnforceCodexServiceTiers
    ? withCodexServiceTierInvariant(liveDescriptors, selections)
    : liveDescriptors;
  return getProviderOptionDescriptors({
    caps: { ...caps, optionDescriptors },
    selections,
    preservePromptInjectedSelections,
  });
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof descriptor.currentValue === "boolean"
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  if (typeof currentValue !== "string") {
    return undefined;
  }
  return descriptor.options.find((option) => option.id === currentValue)?.label;
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function getModelSelectionOptionDescriptors(
  modelSelection: ModelSelection | null | undefined,
  caps?: ModelCapabilities | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!modelSelection) {
    return [];
  }
  if (!caps) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps,
    selections: modelSelection.options,
  });
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

function resolveModelSlug(model: string | null | undefined, provider: ProviderDriverKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderDriverKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];
  const base: ModelSelection = {
    instanceId,
    model,
  };
  return selections.length > 0 ? { ...base, options: selections } : base;
}

/**
 * Returns the effort value if it is a prompt-injected value according to
 * any select descriptor in the given capabilities, or null otherwise.
 *
 * Unlike a single `find`, this checks every descriptor so that the
 * correct descriptor's `promptInjectedValues` list is consulted even when
 * multiple select descriptors exist.
 */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);
  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });
  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
