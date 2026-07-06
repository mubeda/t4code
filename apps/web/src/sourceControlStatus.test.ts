import { describe, expect, it } from "vite-plus/test";

import { workingTreeStatusBadge } from "./sourceControlStatus";

describe("workingTreeStatusBadge", () => {
  it("maps each status to its letter", () => {
    expect(workingTreeStatusBadge("untracked").letter).toBe("U");
    expect(workingTreeStatusBadge("modified").letter).toBe("M");
    expect(workingTreeStatusBadge("added").letter).toBe("A");
    expect(workingTreeStatusBadge("deleted").letter).toBe("D");
    expect(workingTreeStatusBadge("renamed").letter).toBe("R");
    expect(workingTreeStatusBadge("copied").letter).toBe("C");
  });

  it("defaults a missing status to modified", () => {
    expect(workingTreeStatusBadge(undefined).letter).toBe("M");
  });
});
