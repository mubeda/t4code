import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatRemainingPercent(usedPercent: number): string {
  return `${Math.round(100 - clampPercent(usedPercent))}%`;
}

export function formatProviderWindowLabel(
  window: Pick<ServerProviderUsageWindow, "windowMinutes">,
): string {
  if (window.windowMinutes === 300) return "5h";
  if (window.windowMinutes === 10080) return "wk";
  if (window.windowMinutes >= 43200 && window.windowMinutes <= 44640) return "mo";
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}

export function providerUsageBarColorClass(usedPercent: number): string {
  const remaining = 100 - clampPercent(usedPercent);
  if (remaining > 40) return "bg-emerald-500";
  if (remaining > 20) return "bg-yellow-500";
  return "bg-red-500";
}

export function formatMemoryBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes >= 1024 ** 3) {
    return `${NUMBER_FORMAT.format(safeBytes / 1024 ** 3)} GB`;
  }
  if (safeBytes >= 1024 ** 2) {
    return `${NUMBER_FORMAT.format(safeBytes / 1024 ** 2)} MB`;
  }
  if (safeBytes >= 1024) {
    return `${NUMBER_FORMAT.format(safeBytes / 1024)} KB`;
  }
  return `${Math.round(safeBytes)} B`;
}

export function formatCpuPercent(percent: number): string {
  return `${NUMBER_FORMAT.format(Math.max(0, percent))}%`;
}
