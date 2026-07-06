import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceControlCommitRow } from "./SourceControlCommits";

describe("SourceControlCommitRow", () => {
  it("renders the short sha, subject and author", () => {
    const markup = renderToStaticMarkup(
      <SourceControlCommitRow
        commit={{
          sha: "abcdef1234",
          shortSha: "abcdef1",
          subject: "Fix the thing",
          authorName: "Ada",
          authoredAtMs: 1,
        }}
        nowMs={2}
      />,
    );
    expect(markup).toContain("abcdef1");
    expect(markup).toContain("Fix the thing");
    expect(markup).toContain("Ada");
  });
});
