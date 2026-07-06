/**
 * Host-thread-scoped center-panel surface state.
 *
 * A "center panel" is a sibling THREAD sharing the host thread's worktree (see
 * .superpowers/multipanel/00-mp-plan.md). Each host thread owns an ordered set
 * of center surfaces: its own chat (the non-closable host surface, always
 * index 0), extra chat panels (kind:"panel" threads), and terminal panels.
 *
 * Concurrent writes to the shared worktree by parallel panels are BY DESIGN
 * (users want same-workspace parallel AIs); no locking in v1.
 *
 * Shape/persistence/migrate patterns are cloned from rightPanelStore.ts.
 *
 * NOTE: 00-mp-plan.md sketched the host surface as `{kind:"chat", host:true}`;
 * this implementation uses a distinct discriminant `kind:"chat-host"` (per the
 * Wave C task body) so exhaustive switches over the surface union stay clean.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const HOST_SURFACE_ID = "chat:host" as const;

export const CENTER_PANEL_KINDS = ["chat-host", "chat", "terminal"] as const;
export type CenterPanelKind = (typeof CENTER_PANEL_KINDS)[number];

export type CenterSurface =
  | { id: typeof HOST_SURFACE_ID; kind: "chat-host" }
  | { id: `chat:${string}`; kind: "chat"; threadId: ThreadId; providerLabel?: string }
  | { id: `terminal:${string}`; kind: "terminal"; terminalId: string };

const HOST_SURFACE: CenterSurface = { id: HOST_SURFACE_ID, kind: "chat-host" };

const CENTER_PANEL_STORAGE_KEY = "t3code:center-panel-state:v1";
const CENTER_PANEL_STORAGE_VERSION = 1;

export interface ThreadCenterPanelState {
  activeSurfaceId: string;
  surfaces: CenterSurface[];
}

interface CenterPanelStoreState {
  byThreadKey: Record<string, ThreadCenterPanelState>;
  openChatPanel: (ref: ScopedThreadRef, threadId: ThreadId, providerLabel?: string) => void;
  openTerminalPanel: (ref: ScopedThreadRef, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

// The host surface is always present and always index 0, so a fresh host thread
// already has exactly one surface — the center strip stays hidden until a second
// surface is opened, and activeSurfaceId is never null.
const EMPTY_THREAD_STATE: ThreadCenterPanelState = {
  activeSurfaceId: HOST_SURFACE_ID,
  surfaces: [HOST_SURFACE],
};

const chatSurface = (threadId: ThreadId, providerLabel?: string): CenterSurface => ({
  id: `chat:${threadId}`,
  kind: "chat",
  threadId,
  ...(providerLabel !== undefined ? { providerLabel } : {}),
});

const terminalSurface = (terminalId: string): CenterSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  terminalId,
});

// Guarantee the host surface sits at index 0 exactly once and drop duplicate
// ids. Runtime actions never move the host, but migrate() relies on this to
// repair arbitrary persisted arrays.
const normalizeSurfaces = (surfaces: readonly CenterSurface[]): CenterSurface[] => {
  const seen = new Set<string>();
  const rest: CenterSurface[] = [];
  for (const surface of surfaces) {
    if (surface.id === HOST_SURFACE_ID) continue;
    if (seen.has(surface.id)) continue;
    seen.add(surface.id);
    rest.push(surface);
  }
  return [HOST_SURFACE, ...rest];
};

const isHostOnly = (state: ThreadCenterPanelState): boolean =>
  state.surfaces.length === 1 && state.surfaces[0]?.id === HOST_SURFACE_ID;

const upsertSurface = (
  current: ThreadCenterPanelState,
  surface: CenterSurface,
): ThreadCenterPanelState => ({
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: surface.id,
});

const updateThread = (
  byThreadKey: Record<string, ThreadCenterPanelState>,
  threadKey: string,
  updater: (current: ThreadCenterPanelState) => ThreadCenterPanelState,
): Record<string, ThreadCenterPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (next === current) return byThreadKey;
  // Host-only state equals EMPTY_THREAD_STATE — drop the entry to keep the
  // persisted map lean (mirrors rightPanelStore's empty-thread pruning).
  if (isHostOnly(next)) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [threadKey]: next };
};

const sanitizeSurface = (surface: unknown): CenterSurface[] => {
  if (!surface || typeof surface !== "object") return [];
  const kind = (surface as { kind?: unknown }).kind;
  // The host surface is re-added by normalizeSurfaces; drop any persisted copy.
  if (kind === "chat-host") return [];
  if (kind === "chat") {
    const threadId = (surface as { threadId?: unknown }).threadId;
    if (typeof threadId !== "string") return [];
    const providerLabel = (surface as { providerLabel?: unknown }).providerLabel;
    return [
      chatSurface(
        threadId as ThreadId,
        typeof providerLabel === "string" ? providerLabel : undefined,
      ),
    ];
  }
  if (kind === "terminal") {
    const terminalId = (surface as { terminalId?: unknown }).terminalId;
    if (typeof terminalId !== "string") return [];
    return [terminalSurface(terminalId)];
  }
  return [];
};

export function migratePersistedCenterPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadCenterPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {} };
  }
  const raw =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? (persistedState.byThreadKey as Record<string, unknown>)
      : {};
  const byThreadKey: Record<string, ThreadCenterPanelState> = {};
  for (const [threadKey, value] of Object.entries(raw)) {
    const threadState =
      value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const rawSurfaces = Array.isArray(threadState?.surfaces) ? threadState.surfaces : [];
    const surfaces = normalizeSurfaces(rawSurfaces.flatMap<CenterSurface>(sanitizeSurface));
    // Host-only entries are identical to EMPTY_THREAD_STATE — no need to persist.
    if (surfaces.length === 1) continue;
    const activeCandidate =
      typeof threadState?.activeSurfaceId === "string"
        ? threadState.activeSurfaceId
        : HOST_SURFACE_ID;
    const activeSurfaceId = surfaces.some((surface) => surface.id === activeCandidate)
      ? activeCandidate
      : HOST_SURFACE_ID;
    byThreadKey[threadKey] = { surfaces, activeSurfaceId };
  }
  return { byThreadKey };
}

export const useCenterPanelStore = create<CenterPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      openChatPanel: (ref, threadId, providerLabel) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, chatSurface(threadId, providerLabel)),
          ),
        })),
      openTerminalPanel: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (surfaceId === HOST_SURFACE_ID) return current; // host chat is not closable
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, surfaces };
            }
            // Host sits at index 0, so a fallback always exists.
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? HOST_SURFACE;
            return { surfaces, activeSurfaceId: fallback.id };
          }),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface) return current;
            // Host always survives; keeping it also handles closeOthers(host) → [host].
            const surfaces =
              surface.id === HOST_SURFACE_ID ? [HOST_SURFACE] : [HOST_SURFACE, surface];
            return { surfaces, activeSurfaceId: surface.id };
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            // Host at index 0 is always inside slice(0, index + 1).
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            isHostOnly(current)
              ? current
              : { surfaces: [HOST_SURFACE], activeSurfaceId: HOST_SURFACE_ID },
          ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: CENTER_PANEL_STORAGE_KEY,
      version: CENTER_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedCenterPanelState,
    },
  ),
);

export function selectThreadCenterPanelState(
  byThreadKey: Record<string, ThreadCenterPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadCenterPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveCenterSurface(
  byThreadKey: Record<string, ThreadCenterPanelState>,
  ref: ScopedThreadRef | null | undefined,
): CenterSurface {
  const state = selectThreadCenterPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? HOST_SURFACE;
}
