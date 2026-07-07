import type { ProviderUsageViewModel } from "./statusBarPresentation";

export function ProviderUsagePopover({ viewModel }: { viewModel: ProviderUsageViewModel }) {
  return (
    <div className="w-64 space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium capitalize text-foreground">{viewModel.provider}</span>
        <span className="text-muted-foreground">{viewModel.status}</span>
      </div>
      {viewModel.error ? <p className="text-destructive">{viewModel.error}</p> : null}
      <div className="space-y-2">
        {viewModel.windows.map((window) => (
          <div key={window.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{window.label}</span>
              <span className="font-mono tabular-nums">{window.remainingLabel} left</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
              <div
                className={window.barColorClass}
                style={{ width: `${Math.max(0, Math.min(100, 100 - window.usedPercent))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {viewModel.windows.length === 0 ? (
        <p className="text-muted-foreground">Usage windows are unavailable.</p>
      ) : null}
    </div>
  );
}
