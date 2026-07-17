import { describe, expect, it, vi } from "vite-plus/test";

import { stackedThreadToast } from "./toastHelpers";

describe("stackedThreadToast", () => {
  it("returns only required fields with helper-owned layout", () => {
    expect(stackedThreadToast({ type: "info", title: "Saved" })).toEqual({
      type: "info",
      title: "Saved",
      data: { actionLayout: "stacked-end" },
    });
  });

  it("preserves every optional field and forces stacked layout", () => {
    const onClick = vi.fn();
    expect(
      stackedThreadToast({
        type: "error",
        title: "Failed",
        description: "Try again",
        timeout: 5000,
        priority: "high",
        actionProps: { children: "Retry", onClick },
        actionVariant: "destructive",
        data: {
          actionLayout: "inline",
          copyText: "details",
        } as unknown as NonNullable<Parameters<typeof stackedThreadToast>[0]["data"]>,
      }),
    ).toMatchObject({
      type: "error",
      title: "Failed",
      description: "Try again",
      timeout: 5000,
      priority: "high",
      actionProps: { children: "Retry", onClick },
      data: {
        actionLayout: "stacked-end",
        actionVariant: "destructive",
        copyText: "details",
      },
    });
  });
});
