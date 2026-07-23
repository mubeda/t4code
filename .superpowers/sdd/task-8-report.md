# Task 8 Report

## Status

COMPLETE.

Implemented deterministic packaged-desktop provider fixtures, exact provider-input
logging, native composer-trigger coverage for all five providers, draft restoration
coverage, and Codex skill invocation normalization.

## Protocol resolution

The controller confirmed that fixture expectations must follow the production
native inventory paths:

- Codex exposes the built-in `goal` command and the fixture `refactor` skill.
  Production inventory now marks Codex skills as `invocation: "dollar"`.
- Claude exposes native `compact`, built-in `goal`/`loop`, and slash skill `docs`.
- Cursor exposes project command `review`, its production built-ins, and slash
  skill `frontend`.
- OpenCode exposes command `init`, mentionable subagent `reviewer`, mentionable
  all-mode agent `operator`, prose-only primary agent `writer`, and hidden agent
  `secret`.
- Grok exposes its production built-ins `loop`, `agents`, and `skills`.

No test capability environment override was added.

## RED evidence

- Baseline:
  `vp test run apps/desktop/e2e/support/test-project.test.ts`
  passed 4 existing tests before Task 8 changes.
- Fixture RED:
  `vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.test.ts`
  failed because the input-log module/profile did not exist, only Codex was
  enabled, and the native metadata/shims/log export were absent.
- Production RED:
  `cargo test -p t4code-server codex_inventory_marks_native_skills_as_dollar_invoked --lib`
  failed with `E0425` because `codex_skill_inventory` did not exist.

## GREEN and verification evidence

- `vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.test.ts`
  - PASS: 2 files, 9 tests.
- `cargo test -p t4code-server production::provider_inventory::tests --lib`
  - PASS: 20 tests.
- Direct generated-shim smoke using `vp node --input-type=module`
  - PASS: all five generated fixtures parsed their real stdin/HTTP protocols
    and wrote the exact expected JSONL provider/prompt pairs.
- `vp check`
  - PASS: all 1607 files formatted; no warnings or lint errors in 1223 files.
- `vp run typecheck`
  - PASS: all 11 recursive tasks, including
    `tsc --noEmit -p apps/desktop/e2e/tsconfig.json` and Rust desktop/server
    checks.
- Packaged WDIO runtime:
  - SKIPPED as required. `T4CODE_E2E_APP_PATH` is unset and no local packaged
    `.app` bundle exists. Task 9 owns rebuilding a compatible package.

## Files changed

- `apps/desktop/e2e/support/test-project.ts`
  - Enabled and pinned all five provider shims.
  - Added deterministic Codex, Claude, Cursor, Grok, and OpenCode protocols.
  - Added native project metadata, shared JSONL logging, artifact archival, and
    clean OpenCode SSE shutdown.
- `apps/desktop/e2e/support/test-project.test.ts`
  - Covers absolute enabled shims, actual normalized profiles, metadata,
    protocol fixtures, log export, and inline-inert hidden/prose agents.
- `apps/desktop/e2e/support/provider-input-log.ts`
- `apps/desktop/e2e/support/provider-input-log.test.ts`
  - Adds typed append/read behavior and JSONL ordering coverage.
- `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts`
  - Covers `:`, `/`, `$`, and `@` menus; keyboard and mouse selection; exact
    native sends; stale-menu closure; exact restored README/refactor/reviewer
    chips; and the four required screenshots.
- `apps/desktop/e2e/wdio.conf.ts`
  - Registers the spec in the default packaged suite.
- `apps/server/src/production/provider_inventory.rs`
  - Normalizes native Codex skills to dollar invocation with a focused unit
    test.

## Self-review

- Scoped composer interactions to the displayed form so hidden host composers
  cannot absorb E2E input after a sibling panel becomes active.
- Scoped the New panel trigger to a displayed, non-hidden ancestor and asserted
  restored chip identities, not only generic chip kinds.
- Closed OpenCode SSE clients before server shutdown to prevent fixture
  processes from lingering.
- Kept the profile expectations aligned to actual production normalization,
  including OpenCode's visible `all` mode and Grok's built-in-only inventory.
- Did not edit `.repos`, add a capability snapshot override, or stage the
  existing Task 7 report change.

## Remaining concern

The new WDIO spec has not run against a rebuilt packaged binary because none is
available in this worktree. Task 9 must build the package containing the Codex
inventory normalization and run the registered spec; the deterministic fixture
unit tests, direct protocol smoke, lint, and type checks are green.

## Formal review follow-up

Addressed every finding from the Task 8 formal review:

- The fixture now owns an empty, disposable user home under `runRoot`.
  macOS/Linux receive `HOME`; Windows receives both `USERPROFILE` and `HOME`.
  Cleanup still targets only `runRoot`.
- Slash and dollar menus exact-match the fixture command/skill inventories, so
  host-derived Cursor or user inventory fails the packaged test.
- The stale-menu test now opens the provider/model picker while `/goal` and its
  highlighted Codex item remain visible, changes to Claude in the same mounted
  composer, and checks the preserved draft, removed Codex menu/highlight,
  selected Claude inventory, and unchanged composer element. It then switches
  back to Codex through the same picker.
- Stable semantic selectors cover the T4Code, Commands, Skills, Files, and
  Agents containers and labels; the packaged spec asserts the exact applicable
  groups for each trigger.
- Provider-send assertions snapshot the JSONL length and accept exactly one new
  entry with the expected provider and prompt, with explicit malformed,
  truncation, mismatch, duplicate, and timeout diagnostics.
- Registered `.test.ts` coverage executes every generated native shim. OpenCode
  coverage starts the generated HTTP server and exercises health, provider,
  agent, command, session, prompt, JSONL, and SSE behavior.

### Follow-up RED evidence

- Fixture-home tests failed for macOS, Linux, and Windows because
  `fixtureUserHomePath` was absent.
- Provider-log tests failed because `waitForProviderInputLogEntry` was absent.
- The malformed-log regression then failed because its diagnostic omitted the
  raw invalid fixture content.
- Semantic-menu coverage failed because group/label selectors were absent.
- Draft picker coverage failed because `lockToActiveInstance` was still `true`
  before provider lock.
- Active-item coverage failed because `data-composer-item-active` was absent.

### Follow-up GREEN evidence

- `vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.test.ts apps/desktop/e2e/support/provider-shims.test.ts apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx`
  - PASS: 5 files, 129 tests.
- `cargo test -p t4code-server production::provider_inventory::tests --lib`
  - PASS: 20 tests.
- `vp exec tsc --noEmit -p apps/desktop/e2e/tsconfig.json`
  - PASS.
- `vp check`
  - PASS: all 1608 files formatted; no warnings or lint errors in 1224 files.
- `vp run typecheck`
  - PASS: all 11 recursive tasks.
- Packaged WDIO remains intentionally deferred to Task 9, which owns rebuilding
  and running the package.

## Re-review follow-up: configured Cursor home and native launchers

The Cursor capability probe now resolves its user inventory from the selected
provider instance environment before falling back to the process home. The
fixture pins that environment to its disposable user home with `HOME` on
macOS/Linux and `USERPROFILE` on Windows. This is a production seam shared with
the provider definition rather than a test-only capability override.

The shim integration tests now execute the exact host-native launcher paths
written to settings: POSIX wrappers on macOS/Linux and `.cmd` launchers through
`cmd.exe` on Windows. Every launcher lives under a path containing spaces.
Codex, Claude, Cursor, Grok, and OpenCode are invoked with their production-like
arguments, and OpenCode shuts down through its fixture HTTP endpoint so the
wrapper exits naturally.

### Re-review RED evidence

- `vp test run apps/desktop/e2e/support/test-project.test.ts -t "isolates provider user inventory"`
  - FAILED: all three platform fixtures lacked a Cursor provider-instance
    environment.
- `cargo test -p t4code-server cursor_discovers_only_the_configured_environment_home --lib`
  - FAILED with `E0425`: the environment-aware Cursor discovery seam did not
    exist.
- `vp test run apps/desktop/e2e/support/provider-shims.test.ts -t "executes configured host launchers"`
  - FAILED: the fixture run root did not contain spaces, so launcher quoting was
    not exercised.
- `vp test run apps/desktop/e2e/support/provider-shims.test.ts -t "serves OpenCode"`
  - FAILED: OpenCode lacked a graceful fixture shutdown endpoint.

### Re-review GREEN evidence

- `vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-shims.test.ts`
  - PASS: 2 files, 17 tests.
- `cargo test -p t4code-server production::provider_inventory::tests --lib`
  - PASS: 21 tests.
- `vp exec tsc --noEmit -p apps/desktop/e2e/tsconfig.json`
  - PASS.
- `vp check`
  - PASS: all 1608 files formatted; no warnings or lint errors in 1224 files.
- `vp run typecheck`
  - PASS: all 11 recursive tasks.
- `git diff --check`
  - PASS.

## Final re-review follow-up: OpenCode failure cleanup

OpenCode shutdown now runs from `finally`, so assertion failures still attempt
the fixture HTTP shutdown. Both the request and wrapper-exit wait are bounded.
If either fails, cleanup consumes a PID-specific termination plan derived from
the spawned, test-owned child: Windows executes the System32 `taskkill.exe`
with `/PID <pid> /T /F`, while POSIX sends `SIGTERM` and then `SIGKILL` only to
the spawned child. Exit detection also accounts for signal-terminated children.

### Cleanup RED evidence

- `vp test run apps/desktop/e2e/support/provider-shims.test.ts -t "fixture process cleanup"`
  - FAILED: 2 tests with `ReferenceError` because the explicit platform
    termination-plan helper did not exist.

### Cleanup GREEN evidence

- `vp test run apps/desktop/e2e/support/provider-shims.test.ts -t "fixture process cleanup"`
  - PASS: 2 tests.
- `vp test run apps/desktop/e2e/support/provider-shims.test.ts apps/desktop/e2e/support/test-project.test.ts`
  - PASS: 2 files, 19 tests.
- `vp exec tsc --noEmit -p apps/desktop/e2e/tsconfig.json`
  - PASS.
- `vp check`
  - PASS: all 1608 files formatted; no warnings or lint errors in 1224 files.
- `vp run typecheck`
  - PASS: all 11 recursive tasks.
- `git diff --check`
  - PASS.
