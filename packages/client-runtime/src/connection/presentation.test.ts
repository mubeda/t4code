import { EnvironmentId } from "@t4code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionPhaseMessage,
  connectionStatusText,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("gives offline status precedence in global messaging", () => {
    expect(connectionPhaseMessage("connected", TARGET.label, "offline")).toBe("You are offline");
  });

  it("combines reconnect progress with the latest failure", () => {
    expect(
      connectionStatusText({
        phase: "reconnecting",
        error: "Relay request timed out.",
        traceId: "trace-retry",
      }),
    ).toBe("Failed to connect. Reconnecting... Reason: Relay request timed out.");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });

  it("presents blocked and backoff states with and without failure details", () => {
    expect(presentConnectionState(supervisorState({ phase: "backoff" }))).toEqual({
      phase: "reconnecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "blocked",
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Access blocked.",
            traceId: "trace-blocked",
          }),
        }),
      ),
    ).toEqual({ phase: "error", error: "Access blocked.", traceId: "trace-blocked" });
    expect(presentConnectionState(supervisorState({ phase: "blocked" }))).toEqual({
      phase: "error",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Previous failure.",
          }),
        }),
      ).phase,
    ).toBe("reconnecting");
  });

  it("formats every connection status with optional error details", () => {
    expect(connectionStatusText({ phase: "available", error: null, traceId: null })).toBe(
      "Available",
    );
    expect(connectionStatusText({ phase: "offline", error: null, traceId: null })).toBe("Offline");
    expect(connectionStatusText({ phase: "connecting", error: null, traceId: null })).toBe(
      "Connecting...",
    );
    expect(connectionStatusText({ phase: "reconnecting", error: null, traceId: null })).toBe(
      "Reconnecting...",
    );
    expect(connectionStatusText({ phase: "connected", error: null, traceId: null })).toBe(
      "Connected",
    );
    expect(connectionStatusText({ phase: "error", error: null, traceId: null })).toBe(
      "Connection failed",
    );
    expect(connectionStatusText({ phase: "error", error: "Denied", traceId: null })).toBe(
      "Connection failed. Reason: Denied",
    );
  });

  it("formats display URLs for every connection target and profile state", () => {
    const entry = (target: unknown, profile: Option.Option<unknown>) =>
      ({ target, profile }) as ConnectionCatalogEntry;
    expect(
      connectionCatalogDisplayUrl(
        entry(
          { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3000" },
          Option.none(),
        ),
      ),
    ).toBe("http://localhost:3000");
    expect(
      connectionCatalogDisplayUrl(entry({ _tag: "RelayConnectionTarget" }, Option.none())),
    ).toBeNull();
    expect(
      connectionCatalogDisplayUrl(
        entry(
          { _tag: "BearerConnectionTarget" },
          Option.some({ _tag: "BearerConnectionProfile", httpBaseUrl: "https://remote.test" }),
        ),
      ),
    ).toBe("https://remote.test");
    expect(
      connectionCatalogDisplayUrl(
        entry({ _tag: "BearerConnectionTarget" }, Option.some({ _tag: "SshConnectionProfile" })),
      ),
    ).toBeNull();
    expect(
      connectionCatalogDisplayUrl(
        entry(
          { _tag: "SshConnectionTarget" },
          Option.some({
            _tag: "SshConnectionProfile",
            target: { username: "dev", hostname: "host.test" },
          }),
        ),
      ),
    ).toBe("dev@host.test");
    expect(
      connectionCatalogDisplayUrl(entry({ _tag: "SshConnectionTarget" }, Option.none())),
    ).toBeNull();
  });

  it("formats every phase message and gives phase-level offline precedence", () => {
    expect(connectionPhaseMessage("connected", "Remote", "online")).toBe("Connected");
    expect(connectionPhaseMessage("available", "Remote", "online")).toBe("Available");
    expect(connectionPhaseMessage("connecting", "Remote", "online")).toBe(
      "Connecting to Remote...",
    );
    expect(connectionPhaseMessage("reconnecting", "Remote", "online")).toBe(
      "Reconnecting to Remote...",
    );
    expect(connectionPhaseMessage("error", "Remote", "online")).toBe("Connection failed");
    expect(connectionPhaseMessage("offline", "Remote", "online")).toBe("You are offline");
  });
});
