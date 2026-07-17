import { describe, expect, it } from "vite-plus/test";

import { withLogicalId } from "./zone.ts";

describe("withLogicalId", () => {
  it("adds a virtual logical id while forwarding ordinary resource properties", () => {
    const resource = { name: "relay-zone", existing: true };
    const wrapped = withLogicalId(resource, "RelayApiZone") as typeof resource & {
      LogicalId: string;
    };

    expect("LogicalId" in wrapped).toBe(true);
    expect("name" in wrapped).toBe(true);
    expect("missing" in wrapped).toBe(false);
    expect(wrapped.LogicalId).toBe("RelayApiZone");
    expect(wrapped.name).toBe("relay-zone");
  });
});
