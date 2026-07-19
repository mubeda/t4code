import type {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryResult,
} from "@t4code/contracts";
import { CpuIcon, MemoryStickIcon, TerminalIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  buildResourceSummaryViewModel,
  buildResourceTopProcessViewModel,
} from "./statusBarPresentation";

export function ResourceUsageSegment({
  diagnostics,
  resourceHistory,
  terminalCount,
  iconOnly,
}: {
  diagnostics: ServerProcessDiagnosticsResult | null;
  resourceHistory: ServerProcessResourceHistoryResult | null;
  terminalCount: number;
  iconOnly: boolean;
}) {
  const summary = buildResourceSummaryViewModel({ diagnostics, resourceHistory, terminalCount });
  const label = `T4Code native process resources, ${summary.memoryLabel}, ${summary.terminalCountLabel} terminals`;
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-5 items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={label}
        title={`${summary.memoryLabel} · ${summary.terminalCountLabel} terminals`}
      >
        <MemoryStickIcon className="size-3" />
        {!iconOnly ? (
          <>
            <span className="font-mono tabular-nums">{summary.memoryLabel}</span>
            <span className="text-muted-foreground/50">·</span>
            <TerminalIcon className="size-3" />
          </>
        ) : null}
        <span className="font-mono tabular-nums">{summary.terminalCountLabel}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6}>
        <div className="w-80 space-y-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <MemoryStickIcon className="size-3 text-muted-foreground" />
            <span>Resource Manager</span>
          </div>
          <p className="text-muted-foreground">
            T4Code native host and supervised child processes. Browser and WebView processes outside
            this tree are not included.
          </p>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <div className="text-muted-foreground">Memory</div>
              <div className="font-mono tabular-nums">{summary.memoryLabel}</div>
            </div>
            <div>
              <div className="text-muted-foreground">CPU</div>
              <div className="font-mono tabular-nums">{summary.cpuLabel}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Processes</div>
              <div className="font-mono tabular-nums">{summary.processCountLabel}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Terminals</div>
              <div className="font-mono tabular-nums">{summary.terminalCountLabel}</div>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-muted-foreground">
              <CpuIcon className="size-3" />
              <span>Top processes</span>
            </div>
            {(resourceHistory?.processes ?? []).slice(0, 5).map((process) => {
              const processView = buildResourceTopProcessViewModel(process);
              return (
                <div
                  key={processView.processKey}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{processView.command}</span>
                  <span className="shrink-0 font-mono tabular-nums">{processView.detailLabel}</span>
                </div>
              );
            })}
            {resourceHistory && resourceHistory.processes.length === 0 ? (
              <div className="text-muted-foreground">No process samples yet.</div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
