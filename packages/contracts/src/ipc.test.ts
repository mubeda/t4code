import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ContextMenuItemSchema, DesktopEnvironmentBootstrapSchema } from "./ipc.ts";
import { expectDecodeFailure, expectEncodeFailure } from "./test/schemaAssertions.ts";

const decodeContextMenuItem = Schema.decodeUnknownSync(ContextMenuItemSchema);
const encodeContextMenuItem = Schema.encodeSync(ContextMenuItemSchema);
const decodeDesktopEnvironmentBootstrap = Schema.decodeUnknownSync(
  DesktopEnvironmentBootstrapSchema,
);

describe("DesktopEnvironmentBootstrapSchema", () => {
  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("ContextMenuItemSchema", () => {
  it("round-trips nested menu items and optional presentation fields", () => {
    const input = {
      id: "git",
      label: "Git",
      header: true,
      children: [
        {
          id: "push",
          label: "Push",
          destructive: false,
          disabled: true,
          icon: "upload",
        },
      ],
    };
    const decoded = decodeContextMenuItem(input);

    expect(decoded.children?.[0]?.id).toBe("push");
    expect(encodeContextMenuItem(decoded)).toEqual(input);
  });

  it("reports invalid recursive children on decode and encode", () => {
    const invalid = { id: "git", label: "Git", children: [{ id: 1, label: "Push" }] };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["children", 0, "id"]],
      containsTag: "InvalidType" as const,
    };
    expectDecodeFailure(ContextMenuItemSchema, invalid, expected);
    expectEncodeFailure(ContextMenuItemSchema, invalid, expected);
  });
});
