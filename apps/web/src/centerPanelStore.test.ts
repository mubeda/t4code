import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  HOST_SURFACE_ID,
  migratePersistedCenterPanelState,
  selectActiveCenterSurface,
  selectThreadCenterPanelState,
  useCenterPanelStore,
} from "./centerPanelStore";

const HOST = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("host-1"));
const PANEL_A = ThreadId.make("panel-a");
const PANEL_B = ThreadId.make("panel-b");

const store = () => useCenterPanelStore.getState();
const stateOf = (ref = HOST) => selectThreadCenterPanelState(store().byThreadKey, ref);
const surfaceIds = (ref = HOST) => stateOf(ref).surfaces.map((surface) => surface.id);

describe("centerPanelStore", () => {
  beforeEach(() => useCenterPanelStore.setState({ byThreadKey: {} }));

  describe("default / host surface", () => {
    it("returns a host-only state for an unknown thread", () => {
      expect(stateOf()).toEqual({
        activeSurfaceId: HOST_SURFACE_ID,
        surfaces: [{ id: HOST_SURFACE_ID, kind: "chat-host" }],
      });
    });

    it("selectActiveCenterSurface falls back to the host surface", () => {
      expect(selectActiveCenterSurface(store().byThreadKey, HOST)).toEqual({
        id: HOST_SURFACE_ID,
        kind: "chat-host",
      });
    });

    it("does not persist a host-only entry", () => {
      // Activating the already-active host surface must not create a map entry.
      store().activateSurface(HOST, HOST_SURFACE_ID);
      expect(store().byThreadKey).toEqual({});
    });
  });

  describe("openChatPanel", () => {
    it("appends a chat surface after the host and activates it", () => {
      store().openChatPanel(HOST, PANEL_A, "Claude");
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
      expect(stateOf().surfaces[1]).toEqual({
        id: `chat:${PANEL_A}`,
        kind: "chat",
        threadId: PANEL_A,
        providerLabel: "Claude",
      });
    });

    it("keeps the host surface at index 0", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openTerminalPanel(HOST, "term-1");
      expect(surfaceIds()[0]).toBe(HOST_SURFACE_ID);
    });

    it("is idempotent by surface id and re-activates the existing surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      store().openChatPanel(HOST, PANEL_A);
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`, `chat:${PANEL_B}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("omits providerLabel when not supplied", () => {
      store().openChatPanel(HOST, PANEL_A);
      expect(stateOf().surfaces[1]).toEqual({
        id: `chat:${PANEL_A}`,
        kind: "chat",
        threadId: PANEL_A,
      });
    });
  });

  describe("openTerminalPanel", () => {
    it("appends a terminal surface and activates it", () => {
      store().openTerminalPanel(HOST, "term-1");
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, "terminal:term-1"]);
      expect(stateOf().surfaces[1]).toEqual({
        id: "terminal:term-1",
        kind: "terminal",
        terminalId: "term-1",
      });
    });
  });

  describe("activateSurface", () => {
    it("activates an existing surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openTerminalPanel(HOST, "term-1");
      store().activateSurface(HOST, `chat:${PANEL_A}`);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("ignores an unknown surface id", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().activateSurface(HOST, "terminal:nope");
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });
  });

  describe("closeSurface", () => {
    it("closes the host surface and falls back to the next surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().activateSurface(HOST, HOST_SURFACE_ID);
      store().closeSurface(HOST, HOST_SURFACE_ID);
      expect(surfaceIds()).toEqual([`chat:${PANEL_A}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("stores an explicit empty state when the only host surface closes", () => {
      store().closeSurface(HOST, HOST_SURFACE_ID);
      expect(surfaceIds()).toEqual([]);
      expect(stateOf().activeSurfaceId).toBeNull();
      expect(store().byThreadKey).toEqual({
        "environment-1:host-1": { surfaces: [], activeSurfaceId: null },
      });
    });

    it("removes a non-host surface and keeps the active selection when it was elsewhere", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openTerminalPanel(HOST, "term-1");
      store().activateSurface(HOST, `chat:${PANEL_A}`);
      store().closeSurface(HOST, "terminal:term-1");
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("falls back to the neighbor when closing the active surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openTerminalPanel(HOST, "term-1");
      // active is terminal (last opened); closing it falls back to chat:PANEL_A.
      store().closeSurface(HOST, "terminal:term-1");
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("falls back to the host when closing the only non-host surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().closeSurface(HOST, `chat:${PANEL_A}`);
      // Host-only again → entry pruned from the map.
      expect(store().byThreadKey).toEqual({});
      expect(stateOf().activeSurfaceId).toBe(HOST_SURFACE_ID);
    });
  });

  describe("closeOtherSurfaces (host survives)", () => {
    it("keeps the host and the target surface", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      store().openTerminalPanel(HOST, "term-1");
      store().closeOtherSurfaces(HOST, `chat:${PANEL_A}`);
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`]);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("collapses to the host when the host is the target", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      store().closeOtherSurfaces(HOST, HOST_SURFACE_ID);
      expect(store().byThreadKey).toEqual({});
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID]);
    });
  });

  describe("closeSurfacesToRight (host survives)", () => {
    it("drops surfaces after the target", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      store().openTerminalPanel(HOST, "term-1");
      store().closeSurfacesToRight(HOST, `chat:${PANEL_A}`);
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID, `chat:${PANEL_A}`]);
    });

    it("collapses to the host when closing to the right of the host", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      store().closeSurfacesToRight(HOST, HOST_SURFACE_ID);
      expect(surfaceIds()).toEqual([HOST_SURFACE_ID]);
    });

    it("reselects the target when the active surface was dropped", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openChatPanel(HOST, PANEL_B);
      // active is PANEL_B; closing to the right of PANEL_A drops PANEL_B.
      store().closeSurfacesToRight(HOST, `chat:${PANEL_A}`);
      expect(stateOf().activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });
  });

  describe("closeAllSurfaces", () => {
    it("closes every surface and keeps an explicit empty state", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().openTerminalPanel(HOST, "term-1");
      store().closeAllSurfaces(HOST);
      expect(surfaceIds()).toEqual([]);
      expect(stateOf().activeSurfaceId).toBeNull();
      expect(store().byThreadKey).toEqual({
        "environment-1:host-1": { surfaces: [], activeSurfaceId: null },
      });
    });
  });

  describe("removeThread", () => {
    it("clears the stored entry for the thread", () => {
      store().openChatPanel(HOST, PANEL_A);
      store().removeThread(HOST);
      expect(store().byThreadKey).toEqual({});
    });
  });

  describe("migratePersistedCenterPanelState", () => {
    it("returns an empty map for junk input", () => {
      expect(migratePersistedCenterPanelState(null)).toEqual({ byThreadKey: {} });
      expect(migratePersistedCenterPanelState(42)).toEqual({ byThreadKey: {} });
      expect(migratePersistedCenterPanelState({})).toEqual({ byThreadKey: {} });
    });

    it("prepends the host surface and drops invalid surfaces", () => {
      const migrated = migratePersistedCenterPanelState({
        byThreadKey: {
          "environment-1:host-1": {
            activeSurfaceId: `chat:${PANEL_A}`,
            surfaces: [
              { id: `chat:${PANEL_A}`, kind: "chat", threadId: PANEL_A },
              { id: "chat:bad", kind: "chat" }, // missing threadId → dropped
              { id: "terminal:term-1", kind: "terminal", terminalId: "term-1" },
            ],
          },
        },
      });
      const state = migrated.byThreadKey["environment-1:host-1"];
      expect(state?.surfaces.map((surface) => surface.id)).toEqual([
        HOST_SURFACE_ID,
        `chat:${PANEL_A}`,
        "terminal:term-1",
      ]);
      expect(state?.activeSurfaceId).toBe(`chat:${PANEL_A}`);
    });

    it("dedupes a persisted host copy and repairs a dangling active id", () => {
      const migrated = migratePersistedCenterPanelState({
        byThreadKey: {
          "environment-1:host-1": {
            activeSurfaceId: "chat:gone",
            surfaces: [
              { id: HOST_SURFACE_ID, kind: "chat-host" },
              { id: HOST_SURFACE_ID, kind: "chat-host" },
              { id: `chat:${PANEL_A}`, kind: "chat", threadId: PANEL_A },
            ],
          },
        },
      });
      const state = migrated.byThreadKey["environment-1:host-1"];
      expect(state?.surfaces.map((surface) => surface.id)).toEqual([
        HOST_SURFACE_ID,
        `chat:${PANEL_A}`,
      ]);
      expect(state?.activeSurfaceId).toBe(HOST_SURFACE_ID);
    });

    it("drops host-only entries", () => {
      const migrated = migratePersistedCenterPanelState({
        byThreadKey: {
          "environment-1:host-1": {
            activeSurfaceId: HOST_SURFACE_ID,
            surfaces: [{ id: HOST_SURFACE_ID, kind: "chat-host" }],
          },
        },
      });
      expect(migrated.byThreadKey).toEqual({});
    });
  });
});
