# Manual-Only Nightly Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove scheduled nightly release runs while preserving manually dispatched nightly releases.

**Architecture:** A repository-level contract test will read the release workflow and guard both sides of the policy: scheduled execution must be absent, while the manual nightly channel and metadata resolver must remain. The workflow will then be simplified by removing its scheduled trigger, scheduled-only change detector, and scheduled-event branches; release metadata generation and publishing remain otherwise unchanged.

**Tech Stack:** GitHub Actions YAML, TypeScript, Vite+ Test, Effect Vitest assertions, Markdown.

## Global Constraints

- A pushed version tag matching `v*.*.*`, excluding `v*-nightly.*`, remains a release trigger.
- Manual `workflow_dispatch` keeps both `stable` and `nightly` channel choices.
- `scripts/resolve-nightly-release.ts`, its unit tests, release smoke coverage, and historical nightly-tag handling remain.
- Stable, stable-prerelease, artifact, signing, publishing, and deployment behavior remain unchanged.
- `vp check` and `vp run typecheck` must pass before completion.
- The unrelated modification in `apps/desktop/src-tauri/src/bridge.rs` must not be staged or changed.

---

### Task 1: Enforce Manual-Only Nightly Workflow Execution

**Files:**
- Create: `scripts/release-workflow.test.ts`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the release workflow text at `.github/workflows/release.yml`.
- Produces: a repository contract test that rejects scheduled nightly execution and protects the manual nightly path.

- [ ] **Step 1: Write the failing workflow contract test**

Create `scripts/release-workflow.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
./node_modules/.bin/vp test run scripts/release-workflow.test.ts
```

Expected: FAIL with `release workflow must not declare a schedule trigger`.

- [ ] **Step 3: Remove scheduled execution from the release workflow**

Change the top-level triggers and `jobs` opening in `.github/workflows/release.yml` to this structure:

```yaml
on:
  push:
    tags:
      - "v*.*.*"
      - "!v*-nightly.*"
  workflow_dispatch:
    inputs:
      channel:
        description: "Release channel"
        required: false
        default: stable
        type: choice
        options:
          - stable
          - nightly
      version:
        description: "Release version (for example 1.2.3 or v1.2.3)"
        required: false
        type: string

permissions:
  contents: read
  id-token: none

jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-24.04
```

This removes the complete `schedule` trigger, the complete `check_changes` job,
and the `preflight.needs` and `preflight.if` fields that only coordinated
scheduled runs.

Replace the release metadata condition with:

```bash
if [[ "${GITHUB_EVENT_NAME}" == "workflow_dispatch" && "${DISPATCH_CHANNEL:-stable}" == "nightly" ]]; then
```

Keep the body of the nightly and stable branches unchanged.

- [ ] **Step 4: Run the contract test and verify the green state**

Run:

```bash
./node_modules/.bin/vp test run scripts/release-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify manual nightly metadata remains operational**

Run:

```bash
./node_modules/.bin/vp run release:smoke
```

Expected: exit code 0 and `Release smoke checks passed.`. This confirms the
manual nightly resolver and its expected metadata remain intact.

- [ ] **Step 6: Commit the workflow behavior**

```bash
git add scripts/release-workflow.test.ts .github/workflows/release.yml
git commit -m "ci: make nightly releases manual only"
```

### Task 2: Align Release Documentation and Run Repository Gates

**Files:**
- Modify: `scripts/release-workflow.test.ts`
- Modify: `docs/operations/release.md`

**Interfaces:**
- Consumes: the release operator documentation at `docs/operations/release.md`.
- Produces: documentation and a contract assertion that consistently describe manual-only nightly releases.

- [ ] **Step 1: Add the failing documentation contract**

Add this constant beside `releaseWorkflow`:

```ts
const releaseDocumentation = NodeFS.readFileSync(
  NodePath.join(repoRoot, "docs", "operations", "release.md"),
  "utf8",
);
```

Add this test:

```ts
it("documents nightly releases as manual-only", () => {
  assert.notInclude(releaseDocumentation, "scheduled nightly");
  assert.notInclude(releaseDocumentation, "every three hours");
  assert.include(releaseDocumentation, "manual stable or nightly releases");
  assert.include(releaseDocumentation, "Manual nightly releases are GitHub prereleases");
});
```

- [ ] **Step 2: Run the documentation contract and verify the red state**

Run:

```bash
./node_modules/.bin/vp test run scripts/release-workflow.test.ts
```

Expected: FAIL because the current release guide still contains `scheduled
nightly` and `every three hours`.

- [ ] **Step 3: Update the release guide**

Change the supported workflow list in `docs/operations/release.md` to:

```markdown
`.github/workflows/release.yml` supports:

- stable releases from tags matching `v*.*.*`; and
- manual stable or nightly releases through `workflow_dispatch`.
```

Change the release classification paragraph to:

```markdown
Stable semantic versions are marked latest. Stable prerelease versions and
manual nightly releases are GitHub prereleases and are never marked latest.
Nightly releases run only when a maintainer explicitly selects the `nightly`
channel in a manual workflow dispatch.
```

Change release-check step 3 to:

```markdown
3. Create and push `vX.Y.Z`, dispatch `stable` with an explicit version, or
   dispatch the `nightly` channel.
```

- [ ] **Step 4: Run the contract and release smoke checks**

Run:

```bash
./node_modules/.bin/vp test run scripts/release-workflow.test.ts
./node_modules/.bin/vp run release:smoke
```

Expected: both commands exit 0.

- [ ] **Step 5: Run the required repository gates**

Run:

```bash
./node_modules/.bin/vp check
./node_modules/.bin/vp run typecheck
./node_modules/.bin/vp test
```

Expected: all commands exit 0.

- [ ] **Step 6: Confirm the final diff is scoped**

Run:

```bash
git status --short
git diff --check
git diff -- .github/workflows/release.yml scripts/release-workflow.test.ts docs/operations/release.md
```

Expected: only the planned CI/CD and documentation changes are present in the
task diff; the pre-existing `apps/desktop/src-tauri/src/bridge.rs` modification
remains unstaged and unchanged.

- [ ] **Step 7: Commit the documentation and final contract**

```bash
git add scripts/release-workflow.test.ts docs/operations/release.md
git commit -m "docs: document manual nightly releases"
```
