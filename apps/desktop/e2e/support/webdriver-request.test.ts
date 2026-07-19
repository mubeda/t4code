import { describe, expect, it } from "vite-plus/test";

import { normalizeWebDriverRequest } from "./webdriver-request.ts";

describe("normalizeWebDriverRequest", () => {
  it("lets the active fetch runtime calculate content length without changing the request", () => {
    const originalHeaders = new Headers({
      Accept: "application/json",
      "Content-Length": "254",
      "Content-Type": "application/json; charset=utf-8",
    });
    const originalRequest: RequestInit = {
      body: '{"capabilities":{}}',
      headers: originalHeaders,
      method: "POST",
      redirect: "follow",
    };

    const normalized = normalizeWebDriverRequest(originalRequest);
    const normalizedHeaders = new Headers(normalized.headers);

    expect(normalized).not.toBe(originalRequest);
    expect(normalized.body).toBe(originalRequest.body);
    expect(normalized.method).toBe(originalRequest.method);
    expect(normalized.redirect).toBe(originalRequest.redirect);
    expect(normalizedHeaders.get("accept")).toBe("application/json");
    expect(normalizedHeaders.get("content-type")).toBe("application/json; charset=utf-8");
    expect(normalizedHeaders.has("content-length")).toBe(false);
    expect(originalHeaders.get("content-length")).toBe("254");
  });
});
