import type { DesktopPreviewBridge } from "@t4code/contracts";

export type PreviewRuntimeCapability = "picker" | "recording" | "automation";

export interface PreviewRuntimeCapabilities {
  readonly picker: boolean;
  readonly recording: boolean;
  readonly automation: boolean;
}

const capabilitiesByBridge = new WeakMap<DesktopPreviewBridge, PreviewRuntimeCapabilities>();

export function registerPreviewRuntimeCapabilities(
  bridge: DesktopPreviewBridge,
  capabilities: PreviewRuntimeCapabilities,
): void {
  capabilitiesByBridge.set(bridge, capabilities);
}

export function supportsPreviewRuntimeCapability(
  bridge: DesktopPreviewBridge | null | undefined,
  capability: PreviewRuntimeCapability,
): boolean {
  if (!bridge) return false;
  return capabilitiesByBridge.get(bridge)?.[capability] ?? true;
}
