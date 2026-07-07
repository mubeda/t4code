/**
 * Pure model for the chat-header "+" panel menu.
 *
 * Given the already-derived provider instance entries (settings overlaid onto
 * the streamed snapshots), produce the ordered list of provider menu items.
 * Only settings-enabled instances are visible; each is selectable only when the
 * instance is picker-ready, otherwise it renders disabled with a reason.
 */
import { isProviderInstancePickerVisible, type ProviderInstanceEntry } from "~/providerInstances";

/** Reason shown on a visible-but-not-ready provider item. */
export const PROVIDER_NOT_READY_REASON =
  "This provider isn't ready yet — check its connection in Settings.";

export interface PanelMenuProviderItem {
  readonly entry: ProviderInstanceEntry;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/**
 * Build the ordered provider items for the "+" panel menu. Ordering follows
 * the incoming entry order (the server's cross-driver order); visibility and
 * readiness reuse the shared picker predicates so the menu matches every other
 * provider surface.
 */
export function buildPanelMenuModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<PanelMenuProviderItem> {
  return entries.filter(isProviderInstancePickerVisible).map(
    (entry) =>
      ({
        entry,
        disabled: false,
      }) satisfies PanelMenuProviderItem,
  );
}
