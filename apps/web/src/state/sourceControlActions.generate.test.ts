import { describe, expect, it } from "vite-plus/test";

import { useVcsGenerateCommitMessageAction } from "./sourceControlActions";

describe("useVcsGenerateCommitMessageAction", () => {
  it("is exported", () => {
    expect(typeof useVcsGenerateCommitMessageAction).toBe("function");
  });
});
