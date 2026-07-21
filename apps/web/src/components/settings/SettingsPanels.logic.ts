import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderSessionDefault,
  ServerSettings,
  UnifiedSettings,
} from "@t4code/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t4code/contracts/settings";

type ProviderSessionDefaultsMap = ServerSettings["providerSessionDefaults"];

export interface ProviderSessionDefaultsDraft {
  readonly submit: (
    driver: ProviderDriverKind,
    next: ProviderSessionDefault,
  ) => ProviderSessionDefaultsMap;
  readonly reconcile: (authoritative: ProviderSessionDefaultsMap) => ProviderSessionDefaultsMap;
}

function sameProviderSessionDefault(
  left: ProviderSessionDefault | undefined,
  right: ProviderSessionDefault | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.model !== right.model) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every(
      (selection, index) =>
        selection.id === rightOptions[index]?.id && selection.value === rightOptions[index]?.value,
    )
  );
}

export function createProviderSessionDefaultsDraft(
  initial: ProviderSessionDefaultsMap,
): ProviderSessionDefaultsDraft {
  const pending = new Map<ProviderDriverKind, ProviderSessionDefault>();
  let current = initial;

  return {
    submit(driver, next) {
      pending.set(driver, next);
      current = { ...current, [driver]: next };
      return current;
    },
    reconcile(authoritative) {
      for (const [driver, next] of pending) {
        if (sameProviderSessionDefault(authoritative[driver], next)) {
          pending.delete(driver);
        }
      }
      current = { ...authoritative };
      for (const [driver, next] of pending) {
        current = { ...current, [driver]: next };
      }
      return current;
    },
  };
}

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
