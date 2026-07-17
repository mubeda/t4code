// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const releaseWorkflow = NodeFS.readFileSync(
  NodePath.join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);

it("keeps nightly releases manual-only", () => {
  assert.equal(
    /^\s{2}schedule:/m.test(releaseWorkflow),
    false,
    "release workflow must not declare a schedule trigger",
  );
  assert.equal(
    /^\s{2}check_changes:/m.test(releaseWorkflow),
    false,
    "release workflow must not contain the scheduled-only change detector",
  );
  assert.notInclude(releaseWorkflow, "github.event_name == 'schedule'");
  assert.notInclude(releaseWorkflow, '"${GITHUB_EVENT_NAME}" == "schedule"');

  assert.equal(/^\s{2}workflow_dispatch:/m.test(releaseWorkflow), true);
  assert.include(releaseWorkflow, "channel:");
  assert.include(releaseWorkflow, "- nightly");
  assert.include(releaseWorkflow, "scripts/resolve-nightly-release.ts");
});
