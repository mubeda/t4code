import { isTauri as isImportedTauri } from "@tauri-apps/api/core";

export const isTauri =
  typeof window !== "undefined" && (window.__TAURI__ !== undefined || isImportedTauri());

export const isDesktopHost =
  typeof window !== "undefined" && (isTauri || window.desktopBridge !== undefined);
