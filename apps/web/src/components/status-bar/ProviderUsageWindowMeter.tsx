import { cn } from "../../lib/utils";
import type { UsageWindowViewModel } from "./providerUsagePresentation";

export type ProviderUsageWindowMeterVariant = "detail" | "footer";

type UsageTone = "neutral" | "warning" | "destructive";

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usageTone(consumedPercent: number): UsageTone {
  const consumed = clampPercentage(consumedPercent);
  if (consumed >= 80) return "destructive";
  if (consumed >= 60) return "warning";
  return "neutral";
}

function toneLabel(tone: UsageTone): string {
  switch (tone) {
    case "warning":
      return "Caution";
    case "destructive":
      return "Critical";
    default:
      return "Normal";
  }
}

function footerPercentageLabel(label: string): string {
  return label.endsWith("% remaining") ? `${label.slice(0, -"remaining".length)}left` : label;
}

const DETAIL_FILL_CLASS: Record<UsageTone, string> = {
  neutral: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const DETAIL_TEXT_CLASS: Record<UsageTone, string> = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function ProviderUsageWindowMeter({
  variant,
  window,
}: {
  readonly variant: ProviderUsageWindowMeterVariant;
  readonly window: UsageWindowViewModel;
}) {
  const tone = usageTone(window.consumedPercent);
  const label = toneLabel(tone);
  const fillPercent = clampPercentage(window.fillPercent);
  const meterLabel = `${window.label}: ${window.percentageLabel}${
    window.resetLabel === null ? "" : `; ${window.resetLabel}`
  }; ${label}`;
  const fillClassName = variant === "footer" ? "bg-foreground" : DETAIL_FILL_CLASS[tone];

  if (variant === "footer") {
    const percentageLabel = footerPercentageLabel(window.percentageLabel);
    return (
      <span
        aria-label={meterLabel}
        className="inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap"
        role="group"
      >
        <span className="text-muted-foreground">{window.label}</span>
        <span
          aria-label={meterLabel}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={fillPercent}
          className="h-1 w-6 overflow-hidden rounded-sm bg-muted"
          role="progressbar"
        >
          <span
            className={cn("block h-full rounded-sm", fillClassName)}
            style={{ width: `${fillPercent}%` }}
          />
        </span>
        <span className="font-mono tabular-nums text-foreground">{percentageLabel}</span>
        <span className="sr-only">
          {window.resetLabel ?? "Reset time unavailable"}; {label}
        </span>
      </span>
    );
  }

  return (
    <div className="min-w-0 space-y-1" aria-label={meterLabel} role="group">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span className="shrink-0 font-mono tabular-nums text-foreground">
          {window.percentageLabel}
        </span>
      </div>
      <div
        aria-label={meterLabel}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={fillPercent}
        className="h-1.5 overflow-hidden rounded-sm bg-muted"
        role="progressbar"
      >
        <div
          className={cn("h-full rounded-sm", fillClassName)}
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">
          {window.resetLabel ?? "Reset time unavailable"}
        </span>
        <span className={cn("shrink-0 font-medium", DETAIL_TEXT_CLASS[tone])}>{label}</span>
      </div>
    </div>
  );
}
