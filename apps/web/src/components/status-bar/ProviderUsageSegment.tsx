import { BotIcon, SparklesIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ProviderUsagePopover } from "./ProviderUsagePopover";
import type { ProviderUsageViewModel } from "./statusBarPresentation";

function ProviderIcon({ provider }: { provider: ProviderUsageViewModel["provider"] }) {
  return provider === "claude" ? (
    <SparklesIcon className="size-3 text-orange-500" />
  ) : (
    <BotIcon className="size-3 text-foreground" />
  );
}

function providerLabel(provider: ProviderUsageViewModel["provider"]): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function ProviderUsageSegment({
  viewModel,
  iconOnly,
}: {
  viewModel: ProviderUsageViewModel;
  iconOnly: boolean;
}) {
  const label = `${viewModel.provider} usage ${viewModel.compactLabel}`;
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-5 items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={label}
        title={label}
      >
        <ProviderIcon provider={viewModel.provider} />
        {!iconOnly ? (
          <>
            <span className="font-medium text-foreground">{providerLabel(viewModel.provider)}</span>
            <span className="font-mono tabular-nums">{viewModel.compactLabel}</span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6}>
        <ProviderUsagePopover viewModel={viewModel} />
      </PopoverContent>
    </Popover>
  );
}
