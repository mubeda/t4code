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
  ) => ProviderSessionDefaultsSubmission;
  readonly reconcile: (authoritative: ProviderSessionDefaultsMap) => ProviderSessionDefaultsMap;
  readonly reject: (revision: ProviderSessionDefaultsRevision) => ProviderSessionDefaultsMap;
}

declare const providerSessionDefaultsRevisionBrand: unique symbol;

export type ProviderSessionDefaultsRevision = Readonly<{
  [providerSessionDefaultsRevisionBrand]: true;
}>;

export interface ProviderSessionDefaultsSubmission {
  readonly revision: ProviderSessionDefaultsRevision;
  readonly defaults: ProviderSessionDefaultsMap;
}

interface PendingProviderSessionDefaultsSubmission {
  readonly revision: ProviderSessionDefaultsRevision;
  readonly driver: ProviderDriverKind;
  readonly next: ProviderSessionDefault;
  snapshot: ProviderSessionDefaultsMap;
  acknowledged: boolean;
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

function cloneProviderSessionDefault(value: ProviderSessionDefault): ProviderSessionDefault {
  return {
    ...value,
    ...(value.options ? { options: value.options.map((selection) => ({ ...selection })) } : {}),
  };
}

function cloneProviderSessionDefaultsMap(
  input: ProviderSessionDefaultsMap,
): ProviderSessionDefaultsMap {
  return Object.fromEntries(
    Object.entries(input).map(([driver, value]) => [driver, cloneProviderSessionDefault(value)]),
  );
}

function matchesSubmittedSnapshot(
  authoritative: ProviderSessionDefaultsMap,
  submitted: ProviderSessionDefaultsMap,
): boolean {
  return Object.entries(submitted).every(([driver, value]) =>
    sameProviderSessionDefault(authoritative[driver as ProviderDriverKind], value),
  );
}

export function createProviderSessionDefaultsDraft(
  initial: ProviderSessionDefaultsMap,
): ProviderSessionDefaultsDraft {
  const submissions: Array<PendingProviderSessionDefaultsSubmission> = [];
  let latestAuthoritative = cloneProviderSessionDefaultsMap(initial);
  let current = cloneProviderSessionDefaultsMap(latestAuthoritative);

  const rebuildPendingState = (): ProviderSessionDefaultsMap => {
    current = cloneProviderSessionDefaultsMap(latestAuthoritative);
    let hasPending = false;
    for (const submission of submissions) {
      if (submission.acknowledged) continue;
      hasPending = true;
      current = {
        ...current,
        [submission.driver]: cloneProviderSessionDefault(submission.next),
      };
      submission.snapshot = cloneProviderSessionDefaultsMap(current);
    }
    if (!hasPending) {
      submissions.length = 0;
    }
    return cloneProviderSessionDefaultsMap(current);
  };

  return {
    submit(driver, next) {
      const clonedNext = cloneProviderSessionDefault(next);
      current = { ...current, [driver]: clonedNext };
      const revision = Object.freeze({}) as ProviderSessionDefaultsRevision;
      submissions.push({
        revision,
        driver,
        next: clonedNext,
        snapshot: cloneProviderSessionDefaultsMap(current),
        acknowledged: false,
      });
      return {
        revision,
        defaults: cloneProviderSessionDefaultsMap(current),
      };
    },
    reconcile(authoritative) {
      const authoritativeSnapshot = cloneProviderSessionDefaultsMap(authoritative);
      let acknowledgedIndex = -1;
      for (let index = submissions.length - 1; index >= 0; index -= 1) {
        const submission = submissions[index];
        if (submission && matchesSubmittedSnapshot(authoritativeSnapshot, submission.snapshot)) {
          acknowledgedIndex = index;
          break;
        }
      }

      if (acknowledgedIndex === -1) {
        submissions.length = 0;
        latestAuthoritative = authoritativeSnapshot;
        current = cloneProviderSessionDefaultsMap(authoritativeSnapshot);
        return cloneProviderSessionDefaultsMap(current);
      }

      latestAuthoritative = authoritativeSnapshot;
      for (let index = 0; index <= acknowledgedIndex; index += 1) {
        const submission = submissions[index];
        if (submission) submission.acknowledged = true;
      }
      return rebuildPendingState();
    },
    reject(revision) {
      const rejectedIndex = submissions.findIndex((submission) => submission.revision === revision);
      if (rejectedIndex === -1) {
        return cloneProviderSessionDefaultsMap(current);
      }
      submissions.splice(rejectedIndex, 1);
      return rebuildPendingState();
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
