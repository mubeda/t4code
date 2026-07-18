# Direct Dependency and Toolchain Modernization Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to
> implement this plan task-by-task. Use `superpowers:test-driven-development`
> for every behavior-changing migration, `superpowers:systematic-debugging` for
> any unexpected failure, and `superpowers:verification-before-completion`
> before claiming a phase or the modernization complete.

**Goal:** Upgrade every direct dependency, toolchain, and GitHub Action to the
newest appropriate release while keeping all tests green and proving packaged
T4Code compatibility on Windows, macOS, and Linux.

**Architecture:** First synchronize the isolated execution branch with the
latest remote `main` and prove the resulting baseline with the complete test
suite. Then execute independently revertible, risk-based cohorts. Build the
cross-platform CI, ledger, and packaged UI harness before changing toolchains.
Each cohort updates one coupled ecosystem, repairs only the compatibility
failures caused by that ecosystem, runs its focused tests, and then runs the
repository gates. The final phase requeries authoritative sources, closes the
ledger, builds production-equivalent artifacts, and runs the UI smoke suite on
all three operating systems.

**Tech stack:** Node.js 26.5.0, pnpm 11.15.0, Vite+ 0.2.5, TypeScript 7.0.2,
React 19, Effect 4 beta, Rust 1.97.1, Cargo, Tauri 2, WebdriverIO,
`@wdio/tauri-service`, GitHub Actions, Ubuntu, macOS, and Windows.

**Approved design:**
`docs/superpowers/specs/2026-07-17-direct-dependency-modernization-design.md`

---

## Execution Rules

- Start implementation in a clean isolated worktree with
  `superpowers:using-git-worktrees`. Do not copy or commit the unrelated dirty
  change in `apps/desktop/src-tauri/src/bridge.rs`.
- Complete Phase -1 before editing a manifest, lockfile, workflow, source file,
  test, patch, vendored reference, or upgrade ledger. The execution branch must
  contain the latest `origin/main`, and the complete synchronized baseline must
  be green.
- Requery the package registries at the start of each task. When a newer
  release exists than the audited target in this plan, update the ledger and
  use the newer release if it still satisfies the approved stable/preview
  policy.
- Keep one commit per task unless a task explicitly calls for an intermediate
  red-test commit.
- Do not update `.repos/` except through the documented Effect synchronization
  command.
- Do not suppress type errors, skip tests, weaken assertions, broadly ignore
  peer dependencies, or add platform skips to obtain a green result.
- A version-only update may use a green-before/green-after check. Any source
  migration must begin with a focused failing regression or compatibility
  test.
- After each phase, run:

```bash
vp check
vp run typecheck
vp test
vp run test
cargo test --workspace --all-targets -j 2
```

Expected: all commands exit 0. If `vp test` and `vp run test` exercise
overlapping suites, still run both because the repository defines both gates.

---

## Phase -1: Synchronize Main and Prove the Baseline

### Task 0: Retrieve the latest remote main and run the complete test baseline

**Files:**

- Do not modify repository files
- Record the synchronized `origin/main` commit and command results in the
  upgrade ledger when Task 1 creates it

**Step 1: Create or enter the clean isolated execution worktree**

Use `superpowers:using-git-worktrees`. The implementation worktree must contain
the two approved planning commits but must not contain the unrelated dirty
`apps/desktop/src-tauri/src/bridge.rs` change from the planning worktree.

Run:

```bash
git status --porcelain
git branch --show-current
```

Expected: `git status --porcelain` prints nothing and the branch is an
implementation branch using the repository's `codex/` prefix.

**Step 2: Retrieve all remote main changes**

Run:

```bash
git fetch --prune origin main
git log -1 --oneline origin/main
git rev-list --left-right --count HEAD...origin/main
```

Inspect the divergence before changing history. Then replay the implementation
branch on the latest remote main:

```bash
git rebase origin/main
```

Expected: the rebase succeeds without dropping either planning commit. If
there is a conflict, stop normal execution, resolve it deliberately with
`superpowers:systematic-debugging`, and review the resulting diff before
continuing. Never discard main's changes or use a destructive reset.

**Step 3: Prove the branch contains the retrieved main**

Run:

```bash
git merge-base --is-ancestor origin/main HEAD
git rev-parse origin/main
git rev-parse HEAD
git status --porcelain
```

Expected: the ancestor check exits 0, both commit IDs are recorded for Task 1,
and the worktree remains clean.

**Step 4: Restore the synchronized branch's locked dependencies**

Activate the package-manager version declared by the synchronized
`package.json`, then install without updating lockfiles:

```bash
corepack enable
PACKAGE_MANAGER="$(node -p "require('./package.json').packageManager")"
corepack prepare "$PACKAGE_MANAGER" --activate
pnpm install --frozen-lockfile
cargo fetch --locked
```

Expected: both installs succeed and neither lockfile changes. If `corepack` is
not present in the selected Node distribution, use the repository-supported
package-manager bootstrap to install the exact declared pnpm version; do not
fall back to an arbitrary global pnpm.

**Step 5: Run the complete synchronized unit-test baseline**

Run:

```bash
vp check
vp run typecheck
vp test
vp run test
cargo test --workspace --all-targets -j 2
```

Expected: every command exits 0. This gate occurs before the first dependency
or validation-harness edit.

If any command fails:

1. confirm the same failure exists on the synchronized, otherwise-unmodified
   baseline;
2. diagnose it with `superpowers:systematic-debugging`;
3. stop dependency implementation until the baseline is repaired in a
   separate, reviewable commit or the user explicitly approves a documented
   pre-existing exception; and
4. rerun all five commands after the repair.

Do not label a baseline failure as an upgrade regression, and do not weaken or
skip the failing test to continue.

**Step 6: Prove tests did not mutate tracked inputs**

Run:

```bash
git status --porcelain
git diff --exit-code -- package.json pnpm-workspace.yaml pnpm-lock.yaml \
  Cargo.toml Cargo.lock
```

Expected: the worktree is clean and manifests/lockfiles are unchanged. Record
the remote-main SHA, implementation HEAD, tool versions, test commands,
durations, and results when Task 1 creates the ledger.

---

## Phase 0: Establish the Safety Net

### Task 1: Add the exhaustive upgrade ledger and validator

**Files:**

- Create: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Create: `scripts/check-dependency-upgrade-ledger.ts`
- Create: `scripts/check-dependency-upgrade-ledger.test.ts`
- Modify: `scripts/package.json`
- Modify: `package.json`

**Step 1: Import the synchronized baseline evidence**

Initialize the ledger metadata with the `origin/main` SHA, rebased
implementation HEAD, tool versions, test commands, durations, results, and any
existing non-fatal warnings recorded in Task 0. Assert that all five Task 0
baseline commands passed before the first ledger row may move from `pending`.
Do not treat warnings introduced later as pre-existing.

**Step 2: Write the failing ledger tests**

Create `scripts/check-dependency-upgrade-ledger.test.ts` with fixtures and
repository-level assertions that:

- discover all external direct dependencies from every workspace
  `package.json`;
- distinguish workspace links from external dependencies;
- discover all registry crates and the local path crate from the root, child,
  and fixture `Cargo.toml` files;
- discover every non-local `uses:` declaration in `.github/workflows`;
- discover Node, pnpm, Rust, Vite+, Tauri CLI, and devcontainer toolchain pins;
- reject duplicate ledger keys;
- reject missing `current`, `target`, `channel`, `source`, `cohort`,
  `platforms`, or `status` fields;
- reject a manifest dependency that is absent from the ledger;
- reject a ledger dependency that is no longer declared unless its status is
  `removed`; and
- require every target to be `pending`, `green`, `blocked`, `current`, or
  `removed`.

Use repository-relative identifiers such as
`js:apps/web:@base-ui/react`, `rust:workspace:zip`, and
`action:actions/checkout`.

**Step 3: Prove the test fails**

Run:

```bash
vp test run scripts/check-dependency-upgrade-ledger.test.ts
```

Expected: FAIL because the validator and ledger do not exist.

**Step 4: Implement the validator and ledger**

Implement `scripts/check-dependency-upgrade-ledger.ts` using the existing
`smol-toml` and `yaml` dependencies from `scripts/package.json`. Keep registry
lookups outside the unit-test path; the validator compares checked-in manifests
with checked-in evidence deterministically.

Populate the ledger with all 69 JavaScript dependencies, all 49 registry Rust
crates plus the local path crate, all GitHub Actions, and every toolchain
identified by the approved design. Include all already-current dependencies as
`current`, not just outdated rows.

Add:

```json
"check:dependency-ledger": "node scripts/check-dependency-upgrade-ledger.ts"
```

to the root scripts and include it in the normal `check` path if Vite+ permits
repository script composition without duplicating `vp check`.

**Step 5: Make the test green**

Run:

```bash
vp test run scripts/check-dependency-upgrade-ledger.test.ts
vp run check:dependency-ledger
```

Expected: PASS and a summary reporting every audited category with zero
unaccounted entries.

**Step 6: Commit**

```bash
git add package.json scripts/package.json \
  scripts/check-dependency-upgrade-ledger.ts \
  scripts/check-dependency-upgrade-ledger.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "test: track dependency modernization ledger"
```

### Task 2: Add cross-platform workflow contract tests and native compile jobs

**Files:**

- Create: `scripts/ci-platform-contract.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `scripts/tauri-hardening.test.ts`
- Modify: `docs/operations/release.md`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Step 1: Write the failing platform contract**

Add tests that parse workflow YAML and assert:

- portable checks remain on Ubuntu 24.04;
- native compile/bundle legs exist for Ubuntu 22.04 x64, Windows Server 2025
  x64, macOS 26 arm64, and macOS 26 Intel;
- each native leg performs a frozen clean install, web build, desktop Rust
  tests, and no-publish bundle build;
- the release AppImage leg uses Ubuntu 22.04;
- Linux setup installs the full official Tauri prerequisite list plus
  `patchelf`, using `libayatana-appindicator3-dev`;
- no scheduled nightly trigger is introduced;
- the macOS bundle declares `minimumSystemVersion: "11.0"`; and
- Windows ARM remains disabled until its MSVC wrapper becomes
  architecture-aware.

Extend `scripts/tauri-hardening.test.ts` to assert the macOS minimum.

**Step 2: Prove the contract fails**

Run:

```bash
vp test run scripts/ci-platform-contract.test.ts scripts/tauri-hardening.test.ts
```

Expected: FAIL because CI is Linux-only, the release AppImage uses Ubuntu
24.04, and no macOS minimum is declared.

**Step 3: Implement native compile coverage**

In `.github/workflows/ci.yml`, retain the fast portable jobs and add a
fail-fast-false native matrix:

- `ubuntu-22.04`, x64;
- `windows-2025`, x64;
- `macos-26`, arm64; and
- `macos-26-intel`, x64.

Use the repository's build scripts rather than duplicating Tauri CLI command
construction. Install native Linux packages only on Linux. Have every leg
assert `node --version`, `pnpm --version`, and `rustc --version`; the exact
values will become green after Task 4.

Change the Linux release runner to Ubuntu 22.04 and install:

```text
build-essential curl wget file libxdo-dev libssl-dev
libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
librsvg2-dev patchelf
```

Add:

```json
"macOS": {
  "minimumSystemVersion": "11.0"
}
```

under the Tauri bundle configuration and document macOS 11+, Windows 10/11,
and the tested Linux distributions in `docs/operations/release.md`.

**Step 4: Make the contract green**

Run:

```bash
vp test run scripts/ci-platform-contract.test.ts scripts/tauri-hardening.test.ts
vp run release:smoke
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml \
  apps/desktop/src-tauri/tauri.conf.json \
  scripts/ci-platform-contract.test.ts scripts/tauri-hardening.test.ts \
  docs/operations/release.md \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "ci: add native cross-platform compile gates"
```

### Task 3: Add packaged desktop UI automation

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Create: `apps/desktop/e2e/wdio.conf.ts`
- Create: `apps/desktop/e2e/support/app-path.ts`
- Create: `apps/desktop/e2e/support/app-path.test.ts`
- Create: `apps/desktop/e2e/support/native-folder-dialog.ts`
- Create: `apps/desktop/e2e/support/native-folder-dialog.test.ts`
- Create: `apps/desktop/e2e/support/test-project.ts`
- Create: `apps/desktop/e2e/specs/main-window.e2e.ts`
- Create: `apps/desktop/e2e/specs/project-session-terminal.e2e.ts`
- Create: `apps/desktop/e2e/specs/platform-capabilities.e2e.ts`
- Create: `.github/workflows/desktop-ui-smoke.yml`
- Modify: `scripts/ci-platform-contract.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Step 1: Query and record the latest UI test dependencies**

Run:

```bash
pnpm view webdriverio version
pnpm view @wdio/cli version
pnpm view @wdio/local-runner version
pnpm view @wdio/mocha-framework version
pnpm view @wdio/spec-reporter version
pnpm view @wdio/tauri-service version
```

Record the exact stable releases and official package URLs in the ledger.

**Step 2: Write failing pure tests for artifact and native-dialog planning**

`app-path.test.ts` must cover DMG/app, AppImage, and NSIS-installed executable
path resolution from `T4CODE_E2E_APP_PATH`.

`native-folder-dialog.test.ts` must cover bounded command plans for:

- macOS System Events/AppleScript;
- Windows PowerShell UI Automation;
- Linux keyboard automation under Xvfb;
- paths containing spaces;
- timeout, missing automation tool, and non-zero exit errors; and
- cleanup of the temporary project on failure.

Keep command planning pure and inject process spawning so unit tests never open
a real dialog.

**Step 3: Prove the tests fail**

Run:

```bash
vp test run \
  apps/desktop/e2e/support/app-path.test.ts \
  apps/desktop/e2e/support/native-folder-dialog.test.ts
```

Expected: FAIL because the support modules do not exist.

**Step 4: Add the latest WebdriverIO/Tauri dependencies and harness**

Add the exact versions queried in Step 1 to
`apps/desktop/package.json`. Configure `@wdio/tauri-service` to launch an
already-built application supplied through `T4CODE_E2E_APP_PATH`. Add root and
desktop scripts:

```text
test:ui:desktop
test:ui:desktop:build
```

Implement bounded native-dialog automation as a separate adapter. Do not
replace the production folder picker with a test-only picker.

The smoke specs must:

1. open a usable main window;
2. browse for and add a temporary Git project through the real native dialog;
3. verify project selection and persistence after restart;
4. open a session and verify deterministic streamed fixture rendering and
   reconnect;
5. open a terminal, enter text, resize, and close it;
6. exercise a preference, dialog, and opener;
7. confirm the updater-disabled state;
8. verify provider discovery using temporary executable shims;
9. verify actionable missing WSL/SSH/Tailscale capability errors as applicable;
10. run at minimum window size and save a screenshot; and
11. close cleanly with no orphan server process.

Use test-owned temporary state directories and bounded fixture providers. Never
use the developer's real T4Code state or authenticated provider sessions.

**Step 5: Add a manual/reusable three-OS UI workflow**

Create `.github/workflows/desktop-ui-smoke.yml` with
`workflow_dispatch` and `workflow_call`, but no schedule. Use a matrix for:

- Ubuntu 22.04 under Xvfb;
- Windows Server 2025;
- macOS 26 arm64; and
- macOS 26 Intel.

Build the packaged artifact first, run the matching smoke suite, and upload
screenshots plus bounded logs even on failure. Do not publish releases.

**Step 6: Make unit and local macOS smoke tests green**

Run:

```bash
vp test run \
  apps/desktop/e2e/support/app-path.test.ts \
  apps/desktop/e2e/support/native-folder-dialog.test.ts
vp run dist:desktop:dmg:arm64
vp run test:ui:desktop -- --platform mac
```

Expected: unit tests PASS; the packaged arm64 macOS app completes the smoke
flow and writes a screenshot/log bundle. If macOS automation permission is
required, grant it to the test runner and document the one-time setup rather
than bypassing the native dialog.

**Step 7: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/e2e \
  .github/workflows/desktop-ui-smoke.yml \
  scripts/ci-platform-contract.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json pnpm-lock.yaml
git commit -m "test: add packaged desktop UI smoke suite"
```

---

## Phase 1: Upgrade Toolchains and CI Dependencies

### Task 4: Pin Node 26.5.0, pnpm 11.15.0, Rust 1.97.1, Vite+ 0.2.5, and Tauri CLI

**Files:**

- Create: `rust-toolchain.toml`
- Create: `scripts/toolchain-contract.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `.devcontainer/devcontainer.json`
- Modify: `apps/desktop/package.json`
- Modify: `scripts/rust-workspace.test.ts`
- Modify: `scripts/tauri-hardening.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Step 1: Write the failing toolchain contract**

Assert:

- `engines.node` is exactly `26.5.0`;
- `packageManager` is exactly `pnpm@11.15.0`;
- the catalog pins Node types to 26.1.1 unless a newer Node 26-compatible patch
  exists at execution time;
- both Vite+ declarations are exactly 0.2.5;
- `rust-toolchain.toml` pins 1.97.1 with `rustfmt` and `clippy`;
- workspace `rust-version` is 1.97.1;
- CI and release use the pinned toolchain instead of `stable` or 1.88;
- the devcontainer uses Node 26.5.0, contains no Bun feature, and installs with
  frozen pnpm;
- Tauri CLI 2.11.4 is a locked workspace dependency; and
- desktop scripts use `pnpm exec tauri`, not `pnpm dlx`.

Update the existing exact 1.88 and `dlx` assertions in
`scripts/rust-workspace.test.ts` and `scripts/tauri-hardening.test.ts`.

**Step 2: Prove the tests fail**

Run:

```bash
vp test run \
  scripts/toolchain-contract.test.ts \
  scripts/rust-workspace.test.ts \
  scripts/tauri-hardening.test.ts
```

Expected: FAIL on the old pins.

**Step 3: Update the toolchain declarations**

Set the exact versions above. Replace the devcontainer's Bun post-create path
with Corepack/pnpm:

```text
npm install --global corepack@0.35.0 &&
corepack enable && corepack prepare pnpm@11.15.0 --activate &&
pnpm install --frozen-lockfile
```

Use a pinned base-image digest and pinned feature versions while touching the
devcontainer.

Add `@tauri-apps/cli` 2.11.4 to the desktop development dependencies and
replace both `pnpm dlx` invocations with locked `pnpm exec tauri` commands.

Regenerate lockfiles with:

```bash
npm install --global corepack@0.35.0
corepack enable
corepack prepare pnpm@11.15.0 --activate
pnpm install
rustup toolchain install 1.97.1 --component rustfmt --component clippy
rustup override set 1.97.1
cargo update
```

**Step 4: Validate clean installs and exact versions**

Run:

```bash
node --version
pnpm --version
rustc --version
vp install --frozen-lockfile
vp test run \
  scripts/toolchain-contract.test.ts \
  scripts/rust-workspace.test.ts \
  scripts/tauri-hardening.test.ts
git diff --exit-code -- package.json pnpm-workspace.yaml pnpm-lock.yaml \
  Cargo.toml Cargo.lock
```

Expected versions: Node v26.5.0, pnpm 11.15.0, Rust 1.97.1. The final diff
command is run after staging the intentional manifest/lockfile changes or
against a saved pre-install diff; it must prove the frozen install itself adds
no new changes.

**Step 5: Run the phase gate**

Run the five commands in **Execution Rules**, then:

```bash
vp run build:desktop
```

Expected: PASS on the new toolchains.

**Step 6: Commit**

```bash
git add rust-toolchain.toml package.json pnpm-workspace.yaml pnpm-lock.yaml \
  Cargo.toml Cargo.lock .devcontainer/devcontainer.json \
  apps/desktop/package.json scripts/toolchain-contract.test.ts \
  scripts/rust-workspace.test.ts scripts/tauri-hardening.test.ts \
  .github/workflows/ci.yml .github/workflows/release.yml \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Node pnpm Rust and Vite+"
```

### Task 5: Upgrade and immutable-pin every GitHub Action

**Files:**

- Create: `scripts/workflow-dependencies.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/deploy-relay.yml`
- Modify: `.github/workflows/issue-labels.yml`
- Modify: `.github/workflows/pr-size.yml`
- Modify: `.github/workflows/pr-vouch.yml`
- Modify: `.github/workflows/desktop-ui-smoke.yml`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Step 1: Resolve authoritative tag SHAs**

For each audited tag, run the equivalent of:

```bash
gh api repos/actions/checkout/commits/v7.0.0 --jq .sha
```

Resolve and record full commit SHAs for:

- `actions/checkout` 7.0.0;
- `actions/github-script` 9.0.0;
- `voidzero-dev/setup-vp` 1.15.0;
- `dtolnay/rust-toolchain` at the selected immutable revision;
- `Swatinem/rust-cache` 2.9.1;
- `actions/upload-artifact` 7.0.1;
- `actions/download-artifact` 8.0.1;
- `softprops/action-gh-release` 3.0.2; and
- `mitchellh/vouch/action/check-user` 1.5.0.

Requery releases first and substitute a newer stable tag if one now exists.

**Step 2: Write the failing workflow dependency tests**

Parse every workflow and assert that:

- every external `uses:` reference ends with a 40-character lowercase commit
  SHA;
- every pinned Action has a nearby human-readable version comment;
- the ledger SHA matches the workflow SHA;
- checkout v7 is used consistently;
- GitHub Script v9 is used consistently;
- release artifact upload/download and release publishing use their audited
  major versions; and
- local `./.github/actions/...` references remain allowed.

**Step 3: Prove the tests fail**

Run:

```bash
vp test run scripts/workflow-dependencies.test.ts
```

Expected: FAIL on movable `@vN` references.

**Step 4: Replace every workflow reference**

Pin each Action to the resolved SHA and add a comment such as:

```yaml
uses: actions/checkout@<40-character-sha> # v7.0.0
```

Do not change workflow permissions or event trust boundaries while performing
this mechanical update.

**Step 5: Validate workflow behavior**

Run:

```bash
vp test run \
  scripts/workflow-dependencies.test.ts \
  scripts/ci-platform-contract.test.ts \
  scripts/release-workflow.test.ts
vp run release:smoke
```

Then validate GitHub-specific behavior on a disposable branch:

- open a fork PR to exercise checkout v7 in `pull_request_target`;
- replay issue-label, PR-label/comment, and vouch fixtures for GitHub Script v9;
- publish and delete a disposable draft/prerelease with Softprops v3.

Expected: all workflow tests and disposable events succeed without expanded
permissions.

**Step 6: Commit**

```bash
git add .github/workflows scripts/workflow-dependencies.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "ci: upgrade and pin GitHub Actions"
```

---

## Phase 2: Compatible Stable Upgrades

### Task 6: Upgrade low-risk JavaScript tooling and utilities

**Files:**

- Modify: `package.json`
- Modify: `apps/marketing/package.json`
- Modify: `apps/web/package.json`
- Modify: `infra/relay/package.json`
- Modify: `oxlint-plugin-t4code/package.json`
- Modify: `packages/contracts/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Target cohort:**

- `@cloudflare/workers-types` 5.20260717.1;
- `@effect/tsgo` 0.24.1;
- `@oxlint/plugins` 1.74.0;
- `@vercel/config` 0.5.5;
- `@vitejs/plugin-react` 6.0.3;
- `@vitest/coverage-v8` 4.1.10;
- `astro` 7.1.1;
- `fast-check` 4.9.0;
- `jose` 6.2.3; and
- `msw` 2.15.0.

Use newer stable patches if the phase-start requery finds them.

**Step 1: Establish focused green tests**

Run:

```bash
vp run --filter @t4code/marketing typecheck
vp run --filter @t4code/web test
vp run --filter @t4code/contracts test
vp run --filter t4code-relay test
vp run --filter @t4code/oxlint-plugin-t4code test
```

Expected: PASS before version changes.

**Step 2: Update declarations and lockfile**

Update only the target cohort. Use:

```bash
pnpm install
vp run check:dependency-ledger
```

Review the lockfile diff for unrelated major changes or duplicate toolchains.

**Step 3: Repair only demonstrated compatibility failures**

If a package changes public behavior, first add a focused failing test beside
the affected module. Do not edit application code preemptively.

**Step 4: Validate**

Rerun the focused commands from Step 1 and the phase gate.

**Step 5: Commit**

```bash
git add package.json apps/marketing/package.json apps/web/package.json \
  infra/relay/package.json oxlint-plugin-t4code/package.json \
  packages/contracts/package.json pnpm-workspace.yaml pnpm-lock.yaml \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade stable JavaScript tooling"
```

### Task 7: Upgrade compatible Rust dependencies

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Modify source/tests only if the compiler demonstrates a migration is needed

**Target cohort:**

- `clap` 4.6.2;
- `open` 5.4.0;
- `tokio` 1.53.0; and
- `uuid` 1.24.0.

**Step 1: Establish focused green tests**

Run:

```bash
cargo test -p t4code-server --test cli_smoke
cargo test -p t4code-server --test server_runtime
cargo test --workspace --all-targets -j 2
```

Expected: PASS.

**Step 2: Update the four workspace constraints**

Edit `Cargo.toml`, then run:

```bash
cargo update -p clap -p open -p tokio -p uuid
cargo check --workspace --all-targets
```

Expected: compilation succeeds. If it does not, add a focused regression before
changing source.

**Step 3: Validate and commit**

Run the phase gate, then:

```bash
git add Cargo.toml Cargo.lock \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade compatible Rust dependencies"
```

---

## Phase 3: Coupled Frontend Ecosystems

### Task 8: Upgrade the React and UI dependency cohort

**Files:**

- Modify: `apps/web/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify source under `apps/web/src/` only where a focused test proves a
  migration is required
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Target cohort:**

- React and React DOM 19.2.7;
- `@types/react` 19.2.17;
- `@base-ui/react` 1.6.0;
- `@formkit/auto-animate` 0.10.0;
- `@legendapp/list` 3.3.3;
- Lexical and `@lexical/react` 0.48.0;
- `lucide-react` 1.25.0;
- `@tanstack/react-pacer` 0.22.1;
- `@tanstack/react-router` 1.170.18;
- `@tanstack/router-plugin` 1.168.21;
- Tailwind CSS and `@tailwindcss/vite` 4.3.3.

**Step 1: Capture focused component baselines**

Run:

```bash
vp test run \
  apps/web/src/AppRoot.test.tsx \
  apps/web/src/components/ui/primitives.coverage.test.tsx \
  apps/web/src/components/ComposerPromptEditor.test.tsx \
  apps/web/src/components/BranchToolbarBranchSelector.test.tsx \
  apps/web/src/components/ChatView.test.tsx \
  apps/web/src/routes/__root.test.tsx \
  apps/web/src/uiStateStore.test.ts
```

Expected: PASS.

**Step 2: Upgrade the cohort atomically**

Update the manifest/catalog versions and install. Run:

```bash
pnpm install
vp run --filter @t4code/web typecheck
```

**Step 3: Migrate by failing behavior**

For every compile/runtime failure:

1. add the smallest failing test to the closest existing component test;
2. run that file and confirm RED;
3. migrate only the affected API;
4. rerun and confirm GREEN.

Pay particular attention to Lexical editor state, router generation/navigation,
Base UI controlled components, list virtualization, and Tailwind production
CSS.

**Step 4: Validate the web production bundle and tests**

Run:

```bash
vp run --filter @t4code/web test
vp run --filter @t4code/web build
vp run --filter @t4code/web typecheck
```

Then run the phase gate.

**Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src pnpm-workspace.yaml pnpm-lock.yaml \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade React and UI dependencies"
```

### Task 9: Move the Clerk snapshot train to the stable cohort

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify if required: `apps/web/src/cloud/managedAuth.tsx`
- Modify if required: `apps/web/src/components/clerk/`
- Modify if required: `infra/relay/src/http/Api.ts`
- Modify adjacent Clerk tests
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `@clerk/backend` 3.11.7;
- `@clerk/react` 6.12.5;
- catalog-managed `@clerk/clerk-js` 6.25.5; and
- catalog-managed `@clerk/shared` 4.25.5.

**Step 1: Write or strengthen compatibility tests before migration**

Ensure the existing suites explicitly cover:

- managed sign-in and sign-out state;
- token acquisition and expiry;
- relay token verification;
- disabled cloud configuration; and
- the intentionally removed wallet-integration tree.

Run:

```bash
vp test run \
  apps/web/src/cloud/managedAuth.test.ts \
  apps/web/src/cloud/managedAuth.behavior.test.tsx \
  infra/relay/src/http/Api.test.ts
```

Expected: PASS before the update. Add missing assertions first.

**Step 2: Update the complete Clerk catalog atomically**

Keep existing wallet-removal overrides unless the stable Clerk dependency graph
proves they are no longer needed. If removing an override, first add a ledger
assertion showing the dependency no longer exists.

**Step 3: Repair only demonstrated Core 3 compatibility failures**

Follow red-green-refactor in the affected auth or relay test.

**Step 4: Validate and commit**

Run the focused tests, the web and relay full suites, then the phase gate.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml apps/web/src infra/relay/src \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Clerk stable cohort"
```

### Task 10: Upgrade Noble cryptography to version 2

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/shared/src/dpop.ts`
- Modify: `packages/shared/src/dpop.test.ts`
- Modify if required: `packages/shared/src/relaySigning.ts`
- Modify if required: `packages/shared/src/relaySigning.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `@noble/curves` 2.2.0;
- `@noble/hashes` 2.2.0.

**Step 1: Add fixed-vector compatibility tests**

Before changing imports, ensure tests pin:

- P-256 public-key derivation;
- deterministic DPoP proof verification inputs;
- SHA-256 bytes for a fixed payload; and
- persisted/public JWK serialization.

**Step 2: Prove the vectors pass on Noble 1**

Run:

```bash
vp test run \
  packages/shared/src/dpop.test.ts \
  packages/shared/src/relaySigning.test.ts
```

Expected: PASS and fixed expected bytes/strings.

**Step 3: Upgrade and migrate export paths**

Update the catalog and change Noble imports to the documented version 2 `.js`
subpaths, beginning with:

```text
@noble/curves/nist.js
@noble/hashes/sha2.js
```

Use the actual v2 exports; do not add compatibility wrappers for paths that no
longer exist.

**Step 4: Validate unchanged vectors**

Rerun the focused tests and `vp run --filter @t4code/shared test`, then the
phase gate.

**Step 5: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/shared/src \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Noble cryptography"
```

---

## Phase 4: Preview and Service Ecosystems

### Task 11: Upgrade Effect beta as one patched ecosystem

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Delete: `patches/@effect__vitest@4.0.0-beta.78.patch`
- Delete: `patches/effect@4.0.0-beta.78.patch`
- Create: version-matched replacement patches if still necessary
- Modify Effect consumers only where focused tests prove migration needs
- Update: `.repos/effect-smol/` via the repository sync command
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `effect`, `@effect/atom-react`, `@effect/platform-node`,
  `@effect/sql-pg`, and `@effect/vitest` beta.99;
- `@effect/tsgo` remains on the latest stable selected in Task 6.

**Step 1: Read the repository-required Effect guidance**

Read `.repos/effect-smol/LLMS.md` completely and inspect beta.99 APIs in the
vendored subtree before writing Effect code.

**Step 2: Capture focused green suites**

Run:

```bash
vp run --filter @t4code/contracts test
vp run --filter @t4code/shared test
vp run --filter @t4code/client-runtime test
vp run --filter @t4code/web test
vp run --filter t4code-relay test
vp run --filter @t4code/oxlint-plugin-t4code test
```

Expected: PASS.

**Step 3: Update the atomic catalog and rebase patches**

Update every Effect catalog row together. Remove old version-keyed patch
entries, regenerate only patches still required, and keep the intentional
`@effect/vitest`/Vite+ peer handling narrow.

Run:

```bash
pnpm install
vp run sync:repos -- --repo effect-smol
```

**Step 4: Migrate with focused failing tests**

For each changed stable or unstable Effect API:

- write a focused failing test in the owning package;
- follow examples from the synced `.repos/effect-smol/`;
- make the minimal idiomatic migration; and
- rerun the owning package before continuing.

Do not create local compatibility shims that duplicate Effect runtime logic.

**Step 5: Validate every Effect consumer**

Rerun Step 2, then the phase gate. Confirm `pnpm install --frozen-lockfile`
applies all patches cleanly from a clean store.

**Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml patches .repos/effect-smol \
  apps packages infra oxlint-plugin-t4code scripts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Effect beta ecosystem"
```

### Task 12: Upgrade Pierre diffs and trees previews

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Delete: `patches/@pierre%2Fdiffs@1.3.0-beta.5.patch`
- Create: a beta.10 replacement patch only if still required
- Modify if required: Pierre consumers in `apps/web/src/components/` and
  `apps/web/src/lib/diffRendering.ts`
- Modify adjacent Pierre tests
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `@pierre/diffs` beta.10;
- `@pierre/trees` beta.5.

**Step 1: Establish rendering and selection behavior**

Run:

```bash
vp test run \
  apps/web/src/components/diffs/AnnotatableCodeView.test.tsx \
  apps/web/src/components/files/FileBrowserPanel.test.tsx \
  apps/web/src/components/files/FilePreviewPanel.test.tsx \
  apps/web/src/components/chat/MessagesTimeline.test.tsx \
  apps/web/src/reviewCommentContext.test.ts
```

Expected: PASS.

**Step 2: Upgrade and rebase the patch**

Update both preview packages atomically. Inspect whether the old patch is still
needed; delete it if upstream contains the fix, otherwise regenerate it against
beta.10 with the smallest possible diff.

**Step 3: Migrate through focused failures**

Protect diff parsing, code selection, worker startup, editor rendering, and
file-tree navigation with the existing tests. Add a failing case before every
source migration.

**Step 4: Validate and commit**

Run the focused tests, the complete web suite/build, and the phase gate.

```bash
git add pnpm-workspace.yaml apps/web/package.json pnpm-lock.yaml patches \
  apps/web/src docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Pierre preview dependencies"
```

### Task 13: Upgrade relay preview dependencies and TypeScript native preview

**Files:**

- Modify: `infra/relay/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify if required: `infra/relay/src/`
- Modify if required: TypeScript build configuration files
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- custom-source Alchemy beta.63 or the newest matching custom-source beta;
- `drizzle-orm` and `drizzle-kit` rc.4;
- `@typescript/native-preview` audited development build
  `7.0.0-dev.20260707.2`.

**Step 1: Inspect Alchemy reference patterns**

Before editing Alchemy/Effect infrastructure, inspect
`.repos/alchemy-effect/` for the current idiomatic deployment and test
patterns. Preserve the custom package source rather than replacing it with an
unrelated registry release.

**Step 2: Establish relay persistence/deployment behavior**

Run:

```bash
vp test run \
  infra/relay/src/persistence/schema.test.ts \
  infra/relay/src/deploymentConfig.test.ts \
  infra/relay/src/http/Api.test.ts \
  infra/relay/scripts/deploy.test.ts
vp run --filter t4code-relay typecheck
```

Expected: PASS.

**Step 3: Upgrade the preview cohort**

Update Alchemy, Drizzle ORM/Kit, and native-preview versions, then install.
Keep Drizzle ORM and Kit on the same RC.

**Step 4: Apply red-green migrations**

Add a focused failing schema/deployment test before changing relay code. Do not
generate or apply a production database migration solely because the library
version changed; schema output must be reviewed and intentional.

**Step 5: Validate and commit**

Run the complete relay suite/typecheck, repository typecheck, and phase gate.

```bash
git add infra/relay pnpm-workspace.yaml pnpm-lock.yaml \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade relay preview dependencies"
```

---

## Phase 5: Rust Risk Cohorts

### Task 14: Upgrade Rust cryptography dependencies

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create or modify: `apps/server/tests/crypto_compat.rs`
- Modify if required: `apps/server/src/auth/dpop.rs`
- Modify if required: `apps/server/src/auth/token.rs`
- Modify if required: `apps/server/src/production/jwt.rs`
- Modify adjacent auth/relay tests
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `ed25519-dalek` 3.0.0;
- `getrandom` 0.4.3;
- `hmac` 0.13.0;
- `p256` 0.14.0;
- `sha2` 0.11.0.

**Step 1: Add fixed crypto compatibility vectors**

Before the upgrade, pin:

- Ed25519 signing and verification;
- P-256 DPoP verification;
- HMAC output;
- SHA-256 output;
- serialized public key/JWK compatibility; and
- rejection of malformed signatures.

Use fixed non-secret test keys and expected bytes. Confirm the new test passes
on the old cohort.

**Step 2: Upgrade the complete crypto cohort**

Edit workspace dependencies and run:

```bash
cargo update -p ed25519-dalek -p getrandom -p hmac -p p256 -p sha2
cargo check --workspace --all-targets
```

**Step 3: Migrate APIs without changing vectors**

For each compiler failure, make the smallest API migration. Do not regenerate
expected cryptographic outputs to make tests pass unless the old output is
proven incorrect and separately approved.

**Step 4: Validate**

Run:

```bash
cargo test -p t4code-server --test crypto_compat
cargo test -p t4code-server --test auth_http
cargo test -p t4code-server --test production_jwt
cargo test -p t4code-server --test production_relay
cargo test --workspace --all-targets -j 2
```

Then run the phase gate.

**Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock apps/server/src apps/server/tests \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Rust cryptography"
```

### Task 15: Upgrade Rust storage and protocol dependencies

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify if required: `apps/server/src/persistence/`
- Modify if required: `apps/server/src/http.rs`
- Modify if required: `apps/server/src/production/connect_mcp.rs`
- Modify adjacent persistence, RPC, and runtime tests
- Modify fixture manifests under `apps/server/tests/fixtures/` if they declare
  the upgraded crate directly
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `rusqlite` 0.40.1;
- `tokio-tungstenite` 0.30.0;
- `toml` 1.1.3 with TOML spec 1.1.0;
- `tower-http` 0.7.0.

**Step 1: Establish compatibility fixtures**

Run and strengthen as necessary:

```bash
cargo test -p t4code-server --test persistence_compat
cargo test -p t4code-server --test repositories
cargo test -p t4code-server --test rpc_wire
cargo test -p t4code-server --test server_runtime
```

Tests must open an existing database fixture, preserve repository semantics,
round-trip representative TOML, complete a WebSocket handshake/close, and
verify HTTP middleware behavior.

**Step 2: Upgrade one subcohort at a time**

Update in this order, running the focused tests after each:

1. `rusqlite`;
2. `toml`;
3. `tokio-tungstenite`; and
4. `tower-http`.

Keep all four changes in the task commit only after each subcohort is green.

**Step 3: Validate and commit**

Run `cargo test --workspace --all-targets -j 2` and the phase gate.

```bash
git add Cargo.toml Cargo.lock apps/server \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Rust storage and protocols"
```

### Task 16: Upgrade Rust platform and process dependencies

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify if required: `apps/server/src/diagnostics/native.rs`
- Modify if required: `apps/server/src/production/local_servers.rs`
- Modify if required: Windows junction call sites
- Modify adjacent platform tests
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Targets:**

- `sysinfo` 0.39.6;
- Windows-only `junction` 2.0.0.

**Step 1: Add platform behavior tests**

Before upgrading, protect:

- process CPU/memory sampling with absent/terminated processes;
- refresh behavior under repeated polling;
- junction create/read/remove behavior on Windows; and
- bounded, actionable errors when junction privileges are missing.

Use `#[cfg(windows)]` only for behavior that genuinely requires Windows; the
Windows CI leg must execute it.

**Step 2: Upgrade and migrate**

Run:

```bash
cargo update -p sysinfo -p junction
cargo check --workspace --all-targets
```

Apply minimal API migrations through red-green tests.

**Step 3: Validate on native platforms**

Run all Rust tests locally, then require the Ubuntu, Windows, and macOS native
CI legs to pass before merging this task.

**Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock apps/server \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Rust platform dependencies"
```

### Task 17: Isolate the Zip 8 migration

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `apps/server/src/diagnostic_bundle.rs`
- Modify: `apps/server/tests/diagnostic_bundle.rs`
- Create: `apps/server/tests/fixtures/diagnostic-bundle-v4.zip` if a committed
  legacy reader fixture is useful
- Modify: `scripts/release-smoke.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Target:** `zip` 8.6.0 stable. Do not take Zip 9 prerelease.

**Step 1: Capture archive compatibility before upgrading**

Add tests that:

- assert exact diagnostic bundle entry names and ordering;
- read an archive produced by the current Zip 4 implementation;
- verify redacted content and explanatory placeholders;
- reject path traversal entry names; and
- write an archive that system `unzip`/`tar` tools can list.

Run:

```bash
cargo test -p t4code-server --test diagnostic_bundle
```

Expected: PASS on Zip 4.

**Step 2: Upgrade only Zip**

Edit the workspace constraint and run:

```bash
cargo update -p zip
cargo check -p t4code-server --all-targets
```

**Step 3: Migrate the archive API**

Use the smallest Zip 8 API changes. Preserve compression, filenames, content,
and security checks demonstrated by Step 1.

**Step 4: Validate on all operating systems**

Run the Rust suite and have release smoke list the produced archive with:

- `unzip -t` on Linux/macOS; and
- `tar -tf` or PowerShell archive APIs on Windows.

Then run the phase gate.

**Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock apps/server/src/diagnostic_bundle.rs \
  apps/server/tests/diagnostic_bundle.rs apps/server/tests/fixtures \
  scripts/release-smoke.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade Zip archive support"
```

---

## Phase 6: Major Build Tools

### Task 18: Remove the unused direct Babel JSX plugin

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/check-dependency-upgrade-ledger.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Context:** `@babel/plugin-transform-react-jsx` is currently a direct root
dependency, but repository search and `pnpm why` show no consumer. Adding Babel
8 core solely to retain an unused plugin would increase the dependency surface.
The correct modernization is to prove it is unused and remove it. If a consumer
appears before execution, stop and replace this task with a tested Babel 8
cohort migration.

**Step 1: Write the failing unused-dependency assertion**

Add a test that scans source/config files and asserts the plugin has no import,
require, or string-config reference outside manifests, lockfiles, ledger, and
the test itself.

Run:

```bash
vp test run scripts/check-dependency-upgrade-ledger.test.ts
pnpm why @babel/plugin-transform-react-jsx --depth 4
```

Expected before removal: the source-usage assertion passes, while the ledger
still reports the declared unused dependency.

**Step 2: Remove the declaration**

Delete it from root dev dependencies, install, and mark the ledger row
`removed` with the evidence command.

**Step 3: Prove builds still invoke their owned Babel stack**

Run:

```bash
vp run --filter @t4code/web build
vp run --filter @t4code/web test
vp run check:dependency-ledger
```

Expected: PASS, and `pnpm why @babel/plugin-transform-react-jsx` shows no direct
root dependency.

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml \
  scripts/check-dependency-upgrade-ledger.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: remove unused Babel JSX plugin"
```

### Task 19: Upgrade TypeScript 7 and resolve the Astro checker boundary

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify if proven safe: package-manager peer metadata in
  `pnpm-workspace.yaml`
- Modify TypeScript source/config files only through focused failures
- Modify: `scripts/toolchain-contract.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Target:** TypeScript 7.0.2 or a newer stable TypeScript 7 release found at
phase start.

**Step 1: Requery the blocker**

Run:

```bash
pnpm view typescript version
pnpm view @astrojs/check version peerDependencies --json
pnpm view astro version
```

Update the ledger with the exact current peer range.

**Step 2: Demonstrate the peer conflict before overriding it**

Update the TypeScript catalog in a disposable working diff and run:

```bash
pnpm install --strict-peer-dependencies
```

Expected from the audit snapshot: FAIL because the latest
`@astrojs/check` peer range excludes TypeScript 7.

**Step 3: Determine whether the conflict is metadata-only**

Install the exact latest combination with a temporary, narrowly scoped package
extension for `@astrojs/check` only. Do not commit the override yet.

Run:

```bash
vp run --filter @t4code/marketing typecheck
vp run --filter @t4code/marketing build
vp run typecheck
vp run test
vp run build
```

Expected:

- if every command passes without checker/runtime warnings, commit the narrow
  package extension and document the evidence in the ledger;
- if any command fails because TypeScript 7 is actually unsupported, remove
  the temporary override, mark the row `blocked`, stop this task, and report
  the exact upstream blocker to the user.

Do not proceed to final completion while this row is blocked unless the user
explicitly accepts the exception.

**Step 4: Apply TypeScript 7 source migrations with TDD**

For each new compiler diagnostic:

1. add a focused type/runtime regression where behavior is at risk;
2. make the minimum type-safe change;
3. run the owning package's tests and typecheck; and
4. keep emitted/runtime behavior unchanged.

Do not replace errors with `any`, `@ts-ignore`, or disabled compiler options.

**Step 5: Validate and commit only if green**

Run the phase gate plus:

```bash
vp run --filter @t4code/marketing typecheck
vp run --filter @t4code/marketing build
vp run build
```

Then:

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml package.json apps packages infra \
  oxlint-plugin-t4code scripts/toolchain-contract.test.ts \
  docs/dependency-upgrades/2026-07-17-ledger.json
git commit -m "build: upgrade to TypeScript 7"
```

---

## Phase 7: Reaudit and Final Cross-Platform Validation

### Task 20: Requery every dependency and close the ledger

**Files:**

- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Create: `docs/dependency-upgrades/2026-07-17-final-report.md`
- Modify manifests/lockfiles only if the final requery finds a newer release

**Step 1: Requery JavaScript and toolchain releases**

Run:

```bash
pnpm outdated --recursive --format json
pnpm view pnpm version
pnpm view vite-plus version
node --version
pnpm --version
```

For each intentional preview/custom dependency, query its approved channel
rather than comparing it to an unrelated stable generation.

**Step 2: Requery Rust crates**

Query every direct registry crate through crates.io and compare it with
`Cargo.toml` and `Cargo.lock`. Also run:

```bash
cargo update --dry-run
cargo tree --workspace --duplicates
```

Review duplicates; do not force deduplication when distinct major versions are
required by upstream crates.

**Step 3: Requery GitHub Actions and official toolchains**

Verify every pinned SHA still corresponds to the latest approved stable tag.
Verify Node and Rust against their official release feeds. If a newer stable
Node or Rust release was published during implementation, open a final
toolchain subcohort and rerun all gates rather than silently changing the pin.

**Step 4: Close the ledger**

Run:

```bash
vp run check:dependency-ledger
```

Expected: zero `pending` or unapproved `blocked` rows. Record current/no-op,
upgraded, removed, preview, and platform-specific counts in the final report.

### Task 21: Run final source, lockfile, native build, and UI validation

**Files:**

- Modify: `docs/dependency-upgrades/2026-07-17-final-report.md`
- Modify: `docs/operations/release.md` only if final behavior differs from the
  documented validation procedure

**Step 1: Verify clean reproducible installs**

From a clean checkout/worktree with no `node_modules` or build output, run:

```bash
npm install --global corepack@0.35.0
corepack enable
corepack prepare pnpm@11.15.0 --activate
pnpm install --frozen-lockfile
cargo fetch --locked
git diff --exit-code -- package.json pnpm-workspace.yaml pnpm-lock.yaml \
  Cargo.toml Cargo.lock
```

Expected: PASS and no manifest/lockfile drift.

**Step 2: Run all repository gates**

Run:

```bash
vp check
vp run typecheck
vp test
vp run test
vp run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets -j 2
vp run release:smoke
vp run check:dependency-ledger
```

Expected: every command exits 0 with no newly introduced warnings.

**Step 3: Build and test the packaged macOS application locally**

On Apple Silicon:

```bash
vp run dist:desktop:dmg:arm64
vp run test:ui:desktop -- --platform mac
```

On Intel macOS, run the corresponding x64 build and smoke suite. Verify DMG
mount/copy/launch, architecture, app version, screenshot, clean restart, and
process teardown.

**Step 4: Run the remote three-OS native/UI matrix**

After obtaining authorization to push the execution branch:

```bash
git push -u origin <implementation-branch>
gh workflow run desktop-ui-smoke.yml --ref <implementation-branch>
gh run watch --exit-status
```

Expected:

- Ubuntu 22.04 AppImage builds and passes under Xvfb;
- the same AppImage launches on Ubuntu 24.04 and Debian 12 validation hosts;
- Windows Server 2025 builds/installs NSIS and passes the Windows smoke suite;
- Windows 10/11 clean/offline WebView2 cases are recorded;
- macOS arm64 and Intel DMGs mount, copy, launch, restart, and pass;
- every leg uploads screenshots and bounded logs; and
- no platform leg is skipped.

If the repository does not have persistent Windows 10/11 or Debian 12 runners,
use disposable VMs for those artifact-launch checks and attach their evidence
to the final report. Do not infer compatibility from build success.

**Step 5: Verify artifact metadata**

For each artifact, record:

- filename;
- embedded version;
- architecture;
- checksum;
- expected unsigned/signing state;
- installer mode; and
- originating workflow matrix leg.

Confirm updater UI remains intentionally disabled and no updater manifest is
published.

**Step 6: Run final review**

Invoke `superpowers:requesting-code-review`, resolve actionable findings with
`superpowers:receiving-code-review`, and rerun the affected phase plus all
final gates.

Then invoke `superpowers:verification-before-completion` and cite fresh command
outputs in the final report.

**Step 7: Commit the report**

```bash
git add docs/dependency-upgrades/2026-07-17-ledger.json \
  docs/dependency-upgrades/2026-07-17-final-report.md \
  docs/operations/release.md
git commit -m "docs: record dependency upgrade validation"
```

---

## Final Acceptance Checklist

- [ ] The execution branch was rebased onto the latest fetched `origin/main`
      before implementation began.
- [ ] `git merge-base --is-ancestor origin/main HEAD` passed at the
      synchronized baseline.
- [ ] The complete Phase -1 unit/type/lint/Rust baseline passed before the
      first dependency or harness change.
- [ ] All 69 audited direct JavaScript dependencies are current, deliberately
      removed, or explicitly recorded as already current.
- [ ] All 49 audited registry Rust crates are current under the stable-release
      policy; the local path crate remains local.
- [ ] Every GitHub Action is on the latest stable release and pinned to a full
      commit SHA.
- [ ] Node, Node types, pnpm, Rust, Vite+, Tauri CLI, and devcontainer pins
      match the latest targets selected by the user.
- [ ] Intentional Effect, Pierre, Alchemy, Drizzle, and native-preview packages
      are on their newest approved preview channel.
- [ ] Effect patches and `.repos/effect-smol/` match the installed beta.
- [ ] `pnpm install --frozen-lockfile` and `cargo fetch --locked` are
      reproducible and leave no diff.
- [ ] `vp check` passes.
- [ ] `vp run typecheck` passes.
- [ ] `vp test` and `vp run test` pass.
- [ ] All Rust workspace tests, formatting, and Clippy pass.
- [ ] Native release-mode builds pass on Windows, macOS Intel, macOS Apple
      Silicon, and Linux.
- [ ] Packaged UI smoke tests pass on Windows, macOS, and Linux, including the
      real native folder-dialog project import.
- [ ] AppImage launch compatibility is proven on Ubuntu 22.04, Ubuntu 24.04,
      and Debian 12.
- [ ] Windows 10/11 and macOS minimum-version expectations are documented and
      evidenced.
- [ ] Manual nightly releases remain available and no schedule is restored.
- [ ] The unrelated `apps/desktop/src-tauri/src/bridge.rs` change was never
      included in modernization commits.
