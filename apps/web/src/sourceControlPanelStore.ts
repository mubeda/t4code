import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface SourceControlDraft {
  message: string;
}

const DEFAULT_DRAFT: SourceControlDraft = { message: "" };

interface SourceControlPanelStoreState {
  byThreadKey: Record<string, SourceControlDraft>;
  setMessage: (ref: ScopedThreadRef, message: string) => void;
  clearDraft: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function updateDraft(
  state: SourceControlPanelStoreState,
  ref: ScopedThreadRef,
  updater: (draft: SourceControlDraft) => SourceControlDraft,
): { byThreadKey: Record<string, SourceControlDraft> } {
  const key = scopedThreadKey(ref);
  const previous = state.byThreadKey[key] ?? DEFAULT_DRAFT;
  return { byThreadKey: { ...state.byThreadKey, [key]: updater(previous) } };
}

export const useSourceControlPanelStore = create<SourceControlPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setMessage: (ref, message) =>
        set((state) => updateDraft(state, ref, (draft) => ({ ...draft, message }))),
      clearDraft: (ref) => set((state) => updateDraft(state, ref, () => ({ ...DEFAULT_DRAFT }))),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:source-control-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadSourceControlDraft(
  byThreadKey: Record<string, SourceControlDraft>,
  ref: ScopedThreadRef | null | undefined,
): SourceControlDraft {
  if (!ref) return DEFAULT_DRAFT;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_DRAFT;
}
