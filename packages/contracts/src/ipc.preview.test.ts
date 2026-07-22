import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DesktopPreviewBoundsSchema } from "./ipc.ts";

const decodeDesktopPreviewBounds = Schema.decodeUnknownSync(DesktopPreviewBoundsSchema);

describe("DesktopPreviewBoundsSchema", () => {
  it("round-trips a bounds rect", () => {
    const bounds = { x: 12, y: 34, width: 800, height: 600 };
    const decoded = decodeDesktopPreviewBounds(bounds);
    expect(decoded).toEqual(bounds);
  });

  it("rejects negative dimensions", () => {
    expect(() =>
      decodeDesktopPreviewBounds({
        x: 0,
        y: 0,
        width: -1,
        height: 10,
      }),
    ).toThrow();
  });
});
