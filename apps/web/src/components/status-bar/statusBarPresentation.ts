import type {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistorySummary,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
} from "@t4code/contracts";

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

export interface ResourceSummaryViewModel {
  readonly memoryLabel: string;
  readonly cpuLabel: string;
  readonly processCountLabel: string;
  readonly terminalCountLabel: string;
}

export function buildResourceSummaryViewModel(input: {
  readonly diagnostics: ServerProcessDiagnosticsResult | null;
  readonly terminalCount: number;
}): ResourceSummaryViewModel {
  return {
    memoryLabel: input.diagnostics ? formatMemoryBytes(input.diagnostics.totalRssBytes) : "--",
    cpuLabel: input.diagnostics ? formatCpuPercent(input.diagnostics.totalCpuPercent) : "--",
    processCountLabel: input.diagnostics ? String(input.diagnostics.processCount) : "0",
    terminalCountLabel: String(Math.max(0, input.terminalCount)),
  };
}

export interface ResourceTopProcessViewModel {
  readonly processKey: string;
  readonly command: string;
  readonly detailLabel: string;
}

export function buildResourceTopProcessViewModel(
  process: ServerProcessResourceHistorySummary,
): ResourceTopProcessViewModel {
  return {
    processKey: process.processKey,
    command: process.command,
    detailLabel: `${formatCpuPercent(process.currentCpuPercent)} · ${process.pid}`,
  };
}
