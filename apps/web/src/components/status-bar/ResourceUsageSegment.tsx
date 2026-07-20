import type { ServerProcessDiagnosticsResult } from "@t4code/contracts";
import { CpuIcon, MemoryStickIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  buildResourceSummaryViewModel,
  type LocalCoreResourceUsage,
  type ResourceTotalsPresentation,
} from "./statusBarPresentation";

function ResourceTotalsCard({
  title,
  totals,
}: {
  readonly title: string;
  readonly totals: ResourceTotalsPresentation | null;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-muted/20 p-2.5">
      <div className="font-medium text-foreground">{title}</div>
      {totals === null ? (
        <div className="mt-2 text-muted-foreground">Unavailable</div>
      ) : (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">Memory</div>
            <div className="truncate font-mono tabular-nums">{totals.memoryLabel}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">CPU</div>
            <div className="truncate font-mono tabular-nums">{totals.cpuLabel}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">Processes</div>
            <div className="truncate font-mono tabular-nums">{totals.processCountLabel}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ResourceUsageSegment({
  diagnostics,
  localCore,
  terminalCount,
  iconOnly,
}: {
  diagnostics: ServerProcessDiagnosticsResult | null;
  localCore: LocalCoreResourceUsage | null;
  terminalCount: number;
  iconOnly: boolean;
}) {
  const presentation = buildResourceSummaryViewModel({ diagnostics, localCore });
  const terminalCountLabel = String(Math.max(0, terminalCount));
  const headline = presentation.headline;
  const compactMemoryLabel = headline?.memoryLabel ?? "--";
  const compactCpuLabel = headline?.cpuLabel ?? "--";
  const accessibleLabel =
    headline === null
      ? `Combined monitored resources unavailable; ${terminalCountLabel} terminals`
      : `Combined monitored resources: ${headline.memoryLabel} memory, ${headline.cpuLabel} CPU, ${headline.processCountLabel} processes; ${terminalCountLabel} terminals`;
  const title =
    headline === null
      ? "Combined monitored resources unavailable"
      : `Combined monitored resources: ${headline.memoryLabel} memory · ${headline.cpuLabel} CPU · ${headline.processCountLabel} processes`;

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-5 items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={accessibleLabel}
        title={title}
      >
        <MemoryStickIcon className="size-3" />
        {!iconOnly ? (
          <>
            <span className="font-mono tabular-nums">{compactMemoryLabel}</span>
            <span className="text-muted-foreground/50">·</span>
            <CpuIcon className="size-3" />
            <span className="font-mono tabular-nums">{compactCpuLabel}</span>
            <span className="text-muted-foreground/50">·</span>
            <TerminalIcon className="size-3" />
          </>
        ) : null}
        <span className="font-mono tabular-nums">{terminalCountLabel}</span>
        {presentation.warning === null ? null : (
          <TriangleAlertIcon className="size-3 text-warning" aria-hidden="true" />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6}>
        <div className="w-96 space-y-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <MemoryStickIcon className="size-3 text-muted-foreground" />
            <span>Resource Manager</span>
          </div>
          <p className="text-muted-foreground">
            Combined monitored resources for the selected host, separated by ownership.
          </p>

          {presentation.warning === null ? null : (
            <div
              className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-warning-foreground"
              role="status"
            >
              <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{presentation.warning.message}</span>
            </div>
          )}

          <div className="rounded-md border border-border/70 p-2.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Combined
            </div>
            {headline === null ? (
              <div className="mt-1 font-medium text-muted-foreground">Unavailable</div>
            ) : (
              <div className="mt-1 grid grid-cols-3 gap-2">
                <div className="font-mono tabular-nums">{headline.memoryLabel} memory</div>
                <div className="font-mono tabular-nums">{headline.cpuLabel} CPU</div>
                <div className="font-mono tabular-nums">{headline.processCountLabel} processes</div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <ResourceTotalsCard title="T4Code Core" totals={presentation.core} />
            <ResourceTotalsCard title="External Tooling" totals={presentation.external} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-muted-foreground">
              <CpuIcon className="size-3" />
              <span>Highest consumers</span>
            </div>
            {presentation.consumers.map((consumer) => (
              <div
                key={consumer.processKey}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 py-0.5"
              >
                <span className="rounded-sm bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  {consumer.scopeLabel}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {consumer.label}
                  </span>
                  <span
                    className="block truncate text-[10px] text-muted-foreground"
                    title={consumer.command}
                  >
                    {consumer.command}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                  <span className="block">{consumer.memoryLabel}</span>
                  <span className="block text-muted-foreground">{consumer.cpuLabel} CPU</span>
                </span>
              </div>
            ))}
            {presentation.consumers.length === 0 ? (
              <div className="text-muted-foreground">
                {headline === null ? "Unavailable" : "No process samples yet."}
              </div>
            ) : null}
          </div>

          {presentation.localCore === null ? null : (
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">This device</div>
                  <div className="text-[10px] text-muted-foreground">
                    T4Code Core · {presentation.localCore.coverageLabel}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                  <div>{presentation.localCore.memoryLabel}</div>
                  <div className="text-muted-foreground">
                    {presentation.localCore.cpuLabel} CPU ·{" "}
                    {presentation.localCore.processCountLabel} processes
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
