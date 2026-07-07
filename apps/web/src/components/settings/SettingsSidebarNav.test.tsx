import { describe, expect, it } from "@effect/vitest";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("does not include the connections settings section", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain("Connections");
  });
});
