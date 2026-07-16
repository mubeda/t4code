import type { SlowRpcAckRequest } from "../rpc/requestLatencyState";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  requests: [] as SlowRpcAckRequest[],
  ref: { current: null as string | null },
  effects: [] as Array<() => void | (() => void)>,
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: () => harness.ref,
}));
vi.mock("../rpc/requestLatencyState", () => ({
  useSlowRpcAckRequests: () => harness.requests,
}));
vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (toast: unknown) => harness.add(toast),
    update: (id: unknown, toast: unknown) => harness.update(id, toast),
    close: (id: unknown) => harness.close(id),
  },
}));

import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";

beforeEach(() => {
  harness.requests = [];
  harness.ref.current = null;
  harness.effects.length = 0;
  harness.add.mockReset().mockReturnValue("toast-1");
  harness.update.mockReset();
  harness.close.mockReset();
});

function request(id: string, thresholdMs = 2500): SlowRpcAckRequest {
  return {
    requestId: id,
    tag: `RPC ${id}`,
    startedAt: "2026-07-16T12:00:00.000Z",
    startedAtMs: Date.parse("2026-07-16T12:00:00.000Z"),
    thresholdMs,
  };
}

function runEffects(): void {
  for (const effect of harness.effects) effect();
}

describe("SlowRpcRequestToastCoordinator", () => {
  it("does nothing for an empty initial request list", () => {
    expect(SlowRpcRequestToastCoordinator()).toBeNull();
    runEffects();
    const cleanup = harness.effects[1]?.();
    if (typeof cleanup === "function") cleanup();
    expect(harness.add).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("adds a singular toast and renders request detail", () => {
    harness.requests = [request("one")];
    SlowRpcRequestToastCoordinator();
    runEffects();

    expect(harness.add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 request waiting longer than 3s." }),
    );
    const toast = harness.add.mock.calls[0]?.[0] as {
      data: { expandableContent: React.ReactNode };
    };
    expect(renderToStaticMarkup(toast.data.expandableContent)).toContain("RPC one");
    expect(harness.ref.current).toBe("toast-1");
  });

  it("updates an existing toast and closes it when requests clear", () => {
    harness.ref.current = "toast-1";
    harness.requests = [request("one"), request("two")];
    SlowRpcRequestToastCoordinator();
    runEffects();
    expect(harness.update).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({ description: "2 requests waiting longer than 3s." }),
    );

    harness.effects.length = 0;
    harness.requests = [];
    SlowRpcRequestToastCoordinator();
    runEffects();
    expect(harness.close).toHaveBeenCalledWith("toast-1");
    expect(harness.ref.current).toBeNull();
  });

  it("closes an active toast during cleanup", () => {
    harness.ref.current = "toast-1";
    SlowRpcRequestToastCoordinator();
    const cleanup = harness.effects[1]?.();
    if (typeof cleanup === "function") cleanup();
    expect(harness.close).toHaveBeenCalledWith("toast-1");
  });
});
