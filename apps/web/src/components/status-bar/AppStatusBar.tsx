import type {
  EnvironmentId,
  ServerProcessDiagnosticsResult,
  ServerProviderUsageResult,
} from "@t4code/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  usePrimaryEnvironment,
  usePrimaryLocalEnvironmentForSelected,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderUsageSegment } from "./ProviderUsageSegment";
import { ResourceUsageSegment } from "./ResourceUsageSegment";
import { buildProviderUsageViewModel, type LocalCoreResourceUsage } from "./statusBarPresentation";

export const STATUS_BAR_USAGE_REFRESH_INTERVAL_MS = 30_000;
export const STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS = 2_000;

type StatusBarUsageRefresh = () => void | Promise<unknown>;

function runStatusBarUsageRefresh(refresh: StatusBarUsageRefresh): void {
  void Promise.resolve(refresh()).catch(() => {
    // Manual refresh already reports through the command layer; background refresh
    // should not create an unhandled rejection if the environment disconnects.
  });
}

export function startStatusBarUsageAutoRefresh({
  refresh,
  intervalMs = STATUS_BAR_USAGE_REFRESH_INTERVAL_MS,
}: {
  readonly refresh: StatusBarUsageRefresh;
  readonly intervalMs?: number;
}): () => void {
  runStatusBarUsageRefresh(refresh);
  const intervalId = globalThis.setInterval(() => {
    runStatusBarUsageRefresh(refresh);
  }, intervalMs);
  return () => globalThis.clearInterval(intervalId);
}

export function createStatusBarRefreshHandler(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshProviderUsage: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly providers: readonly ["claude", "codex"] };
  }) => Promise<unknown>;
  readonly refreshUsageQuery: () => void;
  readonly refreshProcessDiagnostics: () => void;
  readonly refreshLocalProcessDiagnostics: (() => void) | null;
}) {
  return async () => {
    if (input.environmentId === null) return;
    const providerRefresh = input.refreshProviderUsage({
      environmentId: input.environmentId,
      input: { providers: ["claude", "codex"] },
    });
    input.refreshProcessDiagnostics();
    input.refreshLocalProcessDiagnostics?.();
    try {
      await providerRefresh;
    } finally {
      // Read only after the native fetch commits its snapshots. Reading before
      // this await leaves provider usage one refresh cycle behind.
      input.refreshUsageQuery();
    }
  };
}

export function createStatusBarResourceRefreshHandler(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshProcessDiagnostics: () => void;
  readonly refreshLocalProcessDiagnostics: (() => void) | null;
}) {
  return () => {
    if (input.environmentId === null) return;
    input.refreshProcessDiagnostics();
    input.refreshLocalProcessDiagnostics?.();
  };
}

export function AppStatusBarView({
  usage,
  diagnostics,
  localCore,
  terminalCount,
  isRefreshing = false,
  iconOnly = false,
  onRefresh,
}: {
  readonly usage: ServerProviderUsageResult | null;
  readonly diagnostics: ServerProcessDiagnosticsResult | null;
  readonly localCore: LocalCoreResourceUsage | null;
  readonly terminalCount: number;
  readonly isRefreshing?: boolean;
  readonly iconOnly?: boolean;
  readonly onRefresh: () => void;
}) {
  const providers = usage?.providers.map(buildProviderUsageViewModel) ?? [];
  return (
    <div
      className="relative z-20 flex h-6 min-h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs"
      data-testid="app-status-bar"
    >
      <div className="flex min-w-0 items-center gap-2">
        {providers.map((provider) => (
          <ProviderUsageSegment key={provider.provider} viewModel={provider} iconOnly={iconOnly} />
        ))}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5 rounded-sm p-0 text-muted-foreground"
                aria-label="Refresh status bar usage"
                onClick={onRefresh}
              >
                <RefreshCwIcon className={cn("size-3", isRefreshing && "animate-spin")} />
              </Button>
            }
          />
          <TooltipPopup>Refresh usage</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ResourceUsageSegment
          diagnostics={diagnostics}
          localCore={localCore}
          terminalCount={terminalCount}
          iconOnly={iconOnly}
        />
      </div>
    </div>
  );
}

export function AppStatusBar() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const primaryLocalEnvironment = usePrimaryLocalEnvironmentForSelected(environmentId);
  const primaryLocalEnvironmentId = primaryLocalEnvironment?.environmentId ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  const resourceRefreshRef = useRef<() => void>(() => undefined);
  const autoRefreshCleanupRef = useRef<(() => void) | null>(null);
  const autoRefreshEnvironmentRef = useRef<EnvironmentId | null>(null);
  const resourceAutoRefreshCleanupRef = useRef<(() => void) | null>(null);
  const resourceAutoRefreshEnvironmentRef = useRef<EnvironmentId | null>(null);
  const [iconOnly, setIconOnly] = useState(false);
  const usage = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.providerUsage({ environmentId, input: {} }),
  );
  const diagnostics = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const localDiagnostics = useEnvironmentQuery(
    primaryLocalEnvironmentId === null
      ? null
      : serverEnvironment.processDiagnostics({
          environmentId: primaryLocalEnvironmentId,
          input: {},
        }),
  );
  const terminalSessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const refreshProviderUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const refresh = useCallback(
    createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshUsageQuery: usage.refresh,
      refreshProcessDiagnostics: diagnostics.refresh,
      refreshLocalProcessDiagnostics:
        primaryLocalEnvironmentId === null ? null : localDiagnostics.refresh,
    }),
    [
      diagnostics.refresh,
      environmentId,
      localDiagnostics.refresh,
      primaryLocalEnvironmentId,
      refreshProviderUsage,
      usage.refresh,
    ],
  );
  const resourceRefresh = useCallback(
    createStatusBarResourceRefreshHandler({
      environmentId,
      refreshProcessDiagnostics: diagnostics.refresh,
      refreshLocalProcessDiagnostics:
        primaryLocalEnvironmentId === null ? null : localDiagnostics.refresh,
    }),
    [diagnostics.refresh, environmentId, localDiagnostics.refresh, primaryLocalEnvironmentId],
  );

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    resourceRefreshRef.current = resourceRefresh;
  }, [resourceRefresh]);

  useEffect(
    () => () => {
      autoRefreshCleanupRef.current?.();
      autoRefreshCleanupRef.current = null;
      autoRefreshEnvironmentRef.current = null;
      resourceAutoRefreshCleanupRef.current?.();
      resourceAutoRefreshCleanupRef.current = null;
      resourceAutoRefreshEnvironmentRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (environmentId === null) {
      autoRefreshCleanupRef.current?.();
      autoRefreshCleanupRef.current = null;
      autoRefreshEnvironmentRef.current = null;
      return;
    }
    if (usage.data === null || autoRefreshEnvironmentRef.current === environmentId) return;
    autoRefreshCleanupRef.current?.();
    autoRefreshEnvironmentRef.current = environmentId;
    autoRefreshCleanupRef.current = startStatusBarUsageAutoRefresh({
      refresh: () => refreshRef.current(),
    });
  }, [environmentId, usage.data]);

  useEffect(() => {
    if (environmentId === null) {
      resourceAutoRefreshCleanupRef.current?.();
      resourceAutoRefreshCleanupRef.current = null;
      resourceAutoRefreshEnvironmentRef.current = null;
      return;
    }
    if (resourceAutoRefreshEnvironmentRef.current === environmentId) return;
    resourceAutoRefreshCleanupRef.current?.();
    resourceAutoRefreshEnvironmentRef.current = environmentId;
    resourceAutoRefreshCleanupRef.current = startStatusBarUsageAutoRefresh({
      refresh: () => resourceRefreshRef.current(),
      intervalMs: STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS,
    });
  }, [environmentId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setIconOnly((entry?.contentRect.width ?? element.clientWidth) < 500);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef}>
      <AppStatusBarView
        usage={usage.data}
        diagnostics={diagnostics.data}
        localCore={
          localDiagnostics.data === null
            ? null
            : {
                totals: localDiagnostics.data.totals.core,
                uiCoverage: localDiagnostics.data.uiCoverage,
              }
        }
        terminalCount={terminalSessions.length}
        isRefreshing={usage.isPending}
        iconOnly={iconOnly}
        onRefresh={refresh}
      />
    </div>
  );
}
