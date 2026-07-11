import { ProviderInstanceId } from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { buildPanelMenuModel } from "./ChatHeaderPanelMenu.logic";

function makeEntry(input: {
  instanceId: string;
  displayName?: string;
  enabled?: boolean;
  isAvailable?: boolean;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: "codex" as ProviderInstanceEntry["driverKind"],
    displayName: input.displayName ?? input.instanceId,
    accentColor: undefined,
    continuationGroupKey: undefined,
    enabled: input.enabled ?? true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: input.isAvailable ?? true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
  };
}

describe("buildPanelMenuModel", () => {
  it("keeps only settings-enabled instances and preserves order", () => {
    const model = buildPanelMenuModel([
      makeEntry({ instanceId: "codex", displayName: "Codex" }),
      makeEntry({ instanceId: "disabled", enabled: false }),
      makeEntry({ instanceId: "claude", displayName: "Claude" }),
    ]);
    expect(model.map((item) => item.entry.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claude"),
    ]);
  });

  it("keeps visible providers selectable even when their runtime status is not ready", () => {
    const [ready, notReady] = buildPanelMenuModel([
      makeEntry({ instanceId: "codex" }),
      makeEntry({ instanceId: "claude", isAvailable: false }),
    ]);
    expect(ready?.disabled).toBe(false);
    expect(ready?.disabledReason).toBeUndefined();
    expect(notReady?.disabled).toBe(false);
    expect(notReady?.disabledReason).toBeUndefined();
  });
});
