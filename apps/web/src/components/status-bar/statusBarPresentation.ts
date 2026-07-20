import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceTotals,
  ServerProcessUiCoverage,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
} from "@t4code/contracts";
import * as Option from "effect/Option";

import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProviderWindowLabel,
  formatRemainingPercent,
  providerUsageBarColorClass,
} from "./statusBarFormat";

export interface ProviderUsageWindowViewModel {
  readonly key: "session" | "weekly";
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingLabel: string;
  readonly barColorClass: string;
  readonly resetsAt: ServerProviderUsageWindow["resetsAt"];
  readonly resetDescription: string | null;
}

export interface ProviderUsageViewModel {
  readonly provider: ServerProviderUsageSnapshot["provider"];
  readonly status: ServerProviderUsageSnapshot["status"];
  readonly compactLabel: string;
  readonly windows: ReadonlyArray<ProviderUsageWindowViewModel>;
  readonly error: string | null;
  readonly updatedAt: ServerProviderUsageSnapshot["updatedAt"];
}

function buildWindowViewModel(
  key: "session" | "weekly",
  window: ServerProviderUsageWindow | null,
): ProviderUsageWindowViewModel | null {
  if (!window) return null;
  return {
    key,
    label: formatProviderWindowLabel(window),
    usedPercent: window.usedPercent,
    remainingLabel: formatRemainingPercent(window.usedPercent),
    barColorClass: providerUsageBarColorClass(window.usedPercent),
    resetsAt: window.resetsAt,
    resetDescription: window.resetDescription,
  };
}

export function buildProviderUsageViewModel(
  snapshot: ServerProviderUsageSnapshot,
): ProviderUsageViewModel {
  const windows = [
    buildWindowViewModel("session", snapshot.session),
    buildWindowViewModel("weekly", snapshot.weekly),
  ].filter((window): window is ProviderUsageWindowViewModel => window !== null);

  return {
    provider: snapshot.provider,
    status: snapshot.status,
    compactLabel:
      windows.length === 0
        ? "--"
        : windows.map((window) => `${window.remainingLabel} ${window.label}`).join(" · "),
    windows,
    error: snapshot.error,
    updatedAt: snapshot.updatedAt,
  };
}

export interface ResourceTotalsPresentation {
  readonly memoryLabel: string;
  readonly cpuLabel: string;
  readonly processCountLabel: string;
  readonly coverageLabel: string | null;
}

export interface ResourceConsumerPresentation {
  readonly processKey: string;
  readonly scope: ServerProcessDiagnosticsEntry["scope"];
  readonly scopeLabel: "Core" | "External";
  readonly label: string;
  readonly command: string;
  readonly memoryLabel: string;
  readonly cpuLabel: string;
}

export interface ResourceWarningPresentation {
  readonly message: string;
}

export interface LocalCoreResourceUsage {
  readonly totals: ServerProcessResourceTotals;
  readonly uiCoverage: ServerProcessUiCoverage;
}

export interface ResourceUsagePresentation {
  readonly headline: ResourceTotalsPresentation | null;
  readonly core: ResourceTotalsPresentation | null;
  readonly external: ResourceTotalsPresentation | null;
  readonly consumers: ReadonlyArray<ResourceConsumerPresentation>;
  readonly uiCoverage: ServerProcessUiCoverage;
  readonly localCore: ResourceTotalsPresentation | null;
  readonly warning: ResourceWarningPresentation | null;
}

const UNAVAILABLE_UI_COVERAGE: ServerProcessUiCoverage = {
  status: "unavailable",
  message: Option.none(),
};

const HIGHEST_CONSUMER_LIMIT = 5;

function coverageLabel(coverage: ServerProcessUiCoverage): string {
  switch (coverage.status) {
    case "available":
      return "UI coverage available";
    case "partial":
      return "UI coverage partial";
    case "unavailable":
      return "UI unavailable";
    case "notApplicable":
      return "UI not applicable";
  }
}

function presentTotals(
  totals: ServerProcessResourceTotals,
  coverage: ServerProcessUiCoverage | null = null,
): ResourceTotalsPresentation {
  return {
    memoryLabel: formatMemoryBytes(totals.rssBytes),
    cpuLabel: formatCpuPercent(totals.cpuPercent),
    processCountLabel: String(totals.processCount),
    coverageLabel: coverage === null ? null : coverageLabel(coverage),
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function selectHighestConsumers(
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>,
): ReadonlyArray<ServerProcessDiagnosticsEntry> {
  return processes.toSorted(
    (left, right) =>
      right.rssBytes - left.rssBytes ||
      compareText(left.label, right.label) ||
      compareText(left.processKey, right.processKey),
  );
}

function presentConsumer(process: ServerProcessDiagnosticsEntry): ResourceConsumerPresentation {
  return {
    processKey: process.processKey,
    scope: process.scope,
    scopeLabel: process.scope === "core" ? "Core" : "External",
    label: process.label,
    command: process.command,
    memoryLabel: formatMemoryBytes(process.rssBytes),
    cpuLabel: formatCpuPercent(process.cpuPercent),
  };
}

function totalsReconcile(input: ServerProcessDiagnosticsResult["totals"]): boolean {
  const expectedCpuPercent = input.core.cpuPercent + input.external.cpuPercent;
  const cpuTolerance = Math.max(1, Math.abs(expectedCpuPercent)) * 1e-9;
  return (
    input.combined.rssBytes === input.core.rssBytes + input.external.rssBytes &&
    input.combined.processCount === input.core.processCount + input.external.processCount &&
    Math.abs(input.combined.cpuPercent - expectedCpuPercent) <= cpuTolerance
  );
}

function assertReconciledTotals(input: ServerProcessDiagnosticsResult["totals"]): void {
  if (!totalsReconcile(input)) {
    throw new Error("Combined resource totals must reconcile with Core plus External totals.");
  }
}

function coverageWarning(coverage: ServerProcessUiCoverage): string | null {
  if (coverage.status !== "partial" && coverage.status !== "unavailable") return null;
  return (
    Option.getOrNull(coverage.message) ??
    (coverage.status === "partial"
      ? "T4Code UI resource coverage is partial; Core and Combined totals may be incomplete."
      : "T4Code UI resource coverage is unavailable; unobserved UI usage is not included.")
  );
}

function diagnosticsWarning(
  diagnostics: ServerProcessDiagnosticsResult,
  hasGoodSample: boolean,
): string | null {
  const error = Option.getOrNull(diagnostics.error);
  if (error === null) return null;
  return hasGoodSample ? `Showing the last successful sample. ${error.message}` : error.message;
}

function isGoodSample(diagnostics: ServerProcessDiagnosticsResult): boolean {
  const hasError = Option.isSome(diagnostics.error);
  return !(
    hasError &&
    diagnostics.totals.combined.processCount === 0 &&
    diagnostics.processes.length === 0
  );
}

export function buildResourceSummaryViewModel(input: {
  readonly diagnostics: ServerProcessDiagnosticsResult | null;
  readonly localCore: LocalCoreResourceUsage | null;
}): ResourceUsagePresentation {
  const diagnostics = input.diagnostics;
  const uiCoverage = diagnostics?.uiCoverage ?? UNAVAILABLE_UI_COVERAGE;
  const hasGoodSample = diagnostics !== null && isGoodSample(diagnostics);

  if (diagnostics !== null) assertReconciledTotals(diagnostics.totals);

  const warningMessages =
    diagnostics === null
      ? []
      : [
          diagnosticsWarning(diagnostics, hasGoodSample),
          coverageWarning(diagnostics.uiCoverage),
        ].filter((message): message is string => message !== null);

  return {
    headline: hasGoodSample ? presentTotals(diagnostics.totals.combined) : null,
    core: hasGoodSample ? presentTotals(diagnostics.totals.core) : null,
    external: hasGoodSample ? presentTotals(diagnostics.totals.external) : null,
    consumers: hasGoodSample
      ? selectHighestConsumers(diagnostics.processes)
          .slice(0, HIGHEST_CONSUMER_LIMIT)
          .map(presentConsumer)
      : [],
    uiCoverage,
    localCore:
      input.localCore === null
        ? null
        : presentTotals(input.localCore.totals, input.localCore.uiCoverage),
    warning: warningMessages.length === 0 ? null : { message: warningMessages.join(" ") },
  };
}
