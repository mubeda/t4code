import { describe, expect, it } from "vite-plus/test";

import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

const provider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertisedEndpoint", () => {
  it("normalizes HTTP-family URLs to origin roots", () => {
    expect(normalizeHttpBaseUrl("http://0.0.0.0:4100/path?query=yes#fragment")).toBe(
      "http://0.0.0.0:4100/",
    );
    expect(normalizeHttpBaseUrl("https://localhost:443/path")).toBe("https://localhost/");
    expect(normalizeHttpBaseUrl("ws://127.0.0.1:80/socket")).toBe("http://127.0.0.1/");
    expect(normalizeHttpBaseUrl("wss://[::1]:444/socket")).toBe("https://[::1]:444/");
  });

  it("rejects malformed and unsupported endpoint URLs", () => {
    expect(() => normalizeHttpBaseUrl("not a URL")).toThrow(TypeError);
    expect(() => normalizeHttpBaseUrl("ftp://example.com/path")).toThrow(
      "Endpoint must use HTTP or HTTPS. Received ftp:",
    );
  });

  it("derives websocket schemes for HTTP and HTTPS endpoints", () => {
    expect(deriveWsBaseUrl("http://192.168.1.5:4100/path")).toBe("ws://192.168.1.5:4100/");
    expect(deriveWsBaseUrl("https://[2001:db8::1]:4100/path")).toBe("wss://[2001:db8::1]:4100/");
  });

  it("classifies hosted HTTPS compatibility without leaking an impossible mixed-content fallback", () => {
    expect(classifyHostedHttpsCompatibility("http://localhost:4100")).toBe("mixed-content-blocked");
    expect(classifyHostedHttpsCompatibility("https://example.com")).toBe("unknown");
    expect(classifyHostedHttpsCompatibility("https://example.com", "compatible")).toBe(
      "compatible",
    );
    expect(classifyHostedHttpsCompatibility("https://example.com", "requires-configuration")).toBe(
      "requires-configuration",
    );
    expect(classifyHostedHttpsCompatibility("https://example.com", "mixed-content-blocked")).toBe(
      "unknown",
    );
  });

  it("creates a default endpoint with derived URLs and compatibility", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan",
        label: "LAN",
        provider,
        httpBaseUrl: "http://0.0.0.0:4100/internal?ignored=yes",
        reachability: "lan",
        source: "desktop-core",
      }),
    ).toEqual({
      id: "lan",
      label: "LAN",
      provider,
      httpBaseUrl: "http://0.0.0.0:4100/",
      wsBaseUrl: "ws://0.0.0.0:4100/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
    });
  });

  it("preserves explicit compatibility, status, and optional fields", () => {
    expect(
      createAdvertisedEndpoint({
        id: "public",
        label: "Public",
        provider,
        httpBaseUrl: "wss://public.example:8443/path",
        reachability: "public",
        hostedHttpsCompatibility: "requires-configuration",
        desktopCompatibility: "unknown",
        source: "user",
        status: "unknown",
        isDefault: false,
        description: "Public relay",
      }),
    ).toMatchObject({
      httpBaseUrl: "https://public.example:8443/",
      wsBaseUrl: "wss://public.example:8443/",
      compatibility: {
        hostedHttpsApp: "requires-configuration",
        desktopApp: "unknown",
      },
      status: "unknown",
      isDefault: false,
      description: "Public relay",
    });
  });
});
