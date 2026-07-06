import { describe, expect, it } from "vite-plus/test";

import { formatCommitTimestamp } from "./SourceControlCommits.logic";

describe("formatCommitTimestamp", () => {
  const now = 1_000_000_000_000; // fixed reference passed in explicitly
  it("formats recent commits as relative", () => {
    expect(formatCommitTimestamp(now - 5_000, now)).toBe("just now");
    expect(formatCommitTimestamp(now - 3 * 60_000, now)).toBe("3m ago");
    expect(formatCommitTimestamp(now - 2 * 3_600_000, now)).toBe("2h ago");
  });
  it("formats older commits as days", () => {
    expect(formatCommitTimestamp(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});
