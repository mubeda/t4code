import { describe, expect, it } from "vite-plus/test";

import {
  useVcsDiscardAction,
  useVcsStageAction,
  useVcsUnstageAction,
} from "./sourceControlActions";

describe("staging action hooks", () => {
  it("exports the three staging hooks", () => {
    expect(typeof useVcsStageAction).toBe("function");
    expect(typeof useVcsUnstageAction).toBe("function");
    expect(typeof useVcsDiscardAction).toBe("function");
  });
});
