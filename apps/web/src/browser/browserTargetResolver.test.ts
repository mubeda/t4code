import { EnvironmentId } from "@t4code/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it("maps environment ports onto a private network host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "http://192.168.1.25:5173/dashboard",
      resolutionKind: "direct-private-network",
      environmentId: "environment-1",
    });
  });

  it("refuses public relay hosts until the authenticated gateway exists", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toThrow(/authenticated preview gateway/);
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://localhost:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("preserves localhost server-picker values when the prepared base is 127.0.0.1", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173/app?x=1#top"),
    ).toBe("http://localhost:5173/app?x=1#top");
  });

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("supports private IPv6 environment hosts", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://[::1]:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }).resolvedUrl,
    ).toBe("http://[::1]:5173/app?mode=test");
  });

  it("leaves malformed input for the normal navigation error path", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "   ")).toBe("   ");
  });

  it("returns direct URL targets without reading connection state", async () => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "https://example.test/docs",
      }),
    ).toEqual({
      requestedUrl: "https://example.test/docs",
      resolvedUrl: "https://example.test/docs",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
    expect(readPreparedConnection).not.toHaveBeenCalled();
  });

  it("rejects disconnected environment ports", async () => {
    readPreparedConnection.mockReturnValue(null);
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 3000,
      }),
    ).toThrow("is not connected");
  });

  it.each([
    "http://localhost:4321",
    "http://machine.local:4321",
    "http://machine.ts.net:4321",
    "http://10.0.0.1:4321",
    "http://172.16.0.1:4321",
    "http://172.31.255.1:4321",
    "http://192.168.1.1:4321",
    "http://127.1.2.3:4321",
    "http://169.254.2.3:4321",
  ])("accepts private environment host %s", async (httpBaseUrl) => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const result = resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
      kind: "environment-port",
      port: 8443,
      protocol: "https",
      path: "health",
    });
    expect(result.resolvedUrl).toContain(":8443/health");
    expect(result.requestedUrl).toBe("https://localhost:8443/health");
  });

  it.each([
    "http://172.15.0.1:4321",
    "http://172.32.0.1:4321",
    "http://192.167.1.1:4321",
    "http://1.2.3:4321",
    "http://1.example.test:4321",
  ])("rejects non-private environment host %s", async (httpBaseUrl) => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 3000,
      }),
    ).toThrow(/authenticated preview gateway/);
  });

  it("maps wildcard HTTPS discovery and returns raw input when disconnected", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://10.0.0.2:4321" });
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "https://0.0.0.0/path"),
    ).toBe("https://10.0.0.2/path");
    readPreparedConnection.mockReturnValue(null);
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:3000/path"),
    ).toBe("localhost:3000/path");
  });
});
