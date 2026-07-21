import { previewBridge } from "~/components/preview/previewBridge";

interface DesktopTabLease {
  references: number;
  closeTimer: number | null;
  ready: Promise<void>;
  createFailed: boolean;
}

const leases = new Map<string, DesktopTabLease>();

export interface AcquiredDesktopTab {
  readonly ready: Promise<void>;
  readonly navigate: (url: string, shouldNavigate?: () => boolean) => Promise<void>;
  readonly release: () => void;
}

function createTab(tabId: string, lease: DesktopTabLease): void {
  let ready: Promise<void>;
  try {
    ready = previewBridge?.createTab(tabId) ?? Promise.resolve();
  } catch (error) {
    ready = Promise.reject(error);
  }
  lease.ready = ready;
  lease.createFailed = false;
  void ready.then(undefined, () => {
    if (lease.ready === ready) lease.createFailed = true;
  });
}

export function acquireDesktopTab(tabId: string): AcquiredDesktopTab {
  let current = leases.get(tabId);
  if (!current) {
    current = {
      references: 0,
      closeTimer: null,
      ready: Promise.resolve(),
      createFailed: false,
    };
    createTab(tabId, current);
  } else if (current.createFailed) {
    createTab(tabId, current);
  }
  if (current.closeTimer !== null) window.clearTimeout(current.closeTimer);
  current.references += 1;
  current.closeTimer = null;
  leases.set(tabId, current);
  const ready = current.ready;
  let released = false;

  return {
    ready,
    navigate: async (url, shouldNavigate = () => true) => {
      await ready;
      if (!shouldNavigate()) return;
      await previewBridge?.navigate(tabId, url);
    },
    release: () => {
      if (released) return;
      released = true;
      const lease = leases.get(tabId);
      if (lease !== current) return;
      lease.references = Math.max(0, lease.references - 1);
      if (lease.references > 0) return;
      lease.closeTimer = window.setTimeout(() => {
        const latest = leases.get(tabId);
        if (latest !== current || latest.references > 0) return;
        leases.delete(tabId);
        try {
          void previewBridge?.closeTab(tabId).catch(() => undefined);
        } catch {
          // The tab is already absent from the registry, so a later acquire
          // can create a fresh lifecycle instead of inheriting this failure.
        }
      }, 0);
    },
  };
}

export async function navigateDesktopTab(
  tabId: string,
  url: string,
  shouldNavigate: () => boolean = () => true,
): Promise<void> {
  const lease = acquireDesktopTab(tabId);
  try {
    await lease.navigate(url, shouldNavigate);
  } finally {
    lease.release();
  }
}
