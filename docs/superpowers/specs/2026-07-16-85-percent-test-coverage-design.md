# 85 Percent Test Coverage Design

**Date:** 2026-07-16

## Goal

Raise repository-wide automated test coverage to at least 85% for every configured TypeScript and Rust metric while preserving the existing owned-source inventory and adding tests that exercise meaningful behavior, failure handling, and operational boundaries.

## Success Criteria

The work is complete only when all of the following are true in one fresh verification run:

- TypeScript statements, branches, functions, and lines are each at least 85% under the root Vite+ V8 coverage configuration.
- Rust regions, functions, and lines are each at least 85% under the workspace `cargo llvm-cov` configuration.
- The configured thresholds in `vite.config.shared.ts` and `scripts/check-rust-coverage.ts` are 85 for every existing metric.
- The root `test:coverage` script succeeds without narrowing the source inventory or suppressing owned code.
- `vp check` and `vp run typecheck` succeed, as required by `AGENTS.md`.

Coverage percentages are repository-wide aggregate percentages. The design does not introduce a per-file 85% requirement.

## Baseline

The baseline was measured from commit `4411bfb78` with the current coverage inventory.

| Suite | Metric | Covered / Total | Coverage | Additional covered items needed for 85% |
| --- | --- | ---: | ---: | ---: |
| TypeScript | Statements | 30,770 / 37,756 | 81.49% | 1,322 |
| TypeScript | Branches | 21,009 / 27,909 | 75.27% | 2,715 |
| TypeScript | Functions | 7,196 / 9,259 | 77.71% | 675 |
| TypeScript | Lines | 29,018 / 35,183 | 82.47% | 889 |
| Rust | Regions | 48,491 / 62,904 | 77.09% | 4,978 |
| Rust | Functions | 3,731 / 5,083 | 73.40% | 590 |
| Rust | Lines | 36,020 / 45,396 | 79.35% | 2,567 |

The TypeScript suite passed 5,065 tests across 365 test files. The instrumented Rust workspace tests passed, but the measured Rust function coverage is below even the currently configured 74% threshold. Raising the gate therefore requires substantive Rust test additions rather than only changing configuration.

## Design

### Behavioral hotspot strategy

Coverage work proceeds from machine-generated coverage reports rather than file count or intuition. Each iteration ranks files by uncovered branches, functions, regions, and lines, then selects tests that cover complete user-visible or operational behaviors. A test is valuable when it verifies a stable contract and naturally executes several related paths; raw invocation-only tests written solely to mark lines are not acceptable.

The preferred order within each language is:

1. Untested or lightly tested pure logic and state transitions with deterministic inputs.
2. Error, cancellation, retry, timeout, and fallback paths in already tested modules.
3. Component and service workflows whose existing tests cover the happy path but miss event and state variants.
4. Process, filesystem, network, platform, and framework adapters using bounded fakes or local fixtures.
5. Small testability extractions only where the platform boundary prevents reliable behavioral testing.

No production behavior is intentionally changed. If a test exposes an existing defect, that defect is handled as a separate red-green-refactor cycle and documented in the implementation change.

### TypeScript focus areas

The initial report identifies the largest aggregate opportunities in:

- `apps/web/src/components/ChatView.tsx`;
- `apps/web/src/components/ThreadTerminalDrawer.tsx`;
- `apps/web/src/components/Sidebar.tsx`;
- `apps/web/src/components/ChatMarkdown.tsx`;
- `apps/web/src/components/settings/ConnectionsSettings.tsx`;
- `infra/relay/src/http/Api.ts`;
- unexecuted web state, route, sidebar, chat, preview, and diff modules; and
- client-runtime connection, operation, and state modules with low function coverage.

Large UI files are tested through observable rendering, interaction, and state effects. Existing logic modules and stores remain the preferred seam when they already own a behavior. New logic extraction is permitted only when it creates a reusable boundary used by production code and materially reduces brittle component setup.

TypeScript tests continue using Vite+ and the repository's existing Node or DOM test environments. Tests use real reducers, stores, formatters, schemas, and request handlers where practical. Mocks are limited to true boundaries such as browser APIs, RPC transports, clocks, and native bridges.

### Rust focus areas

The initial report identifies the largest aggregate opportunities in:

- desktop backend, bridge, SSH, update, window, and configuration paths;
- `production::provider_runtime`, `production::git_vcs`, `production::runtime`, and `production::workspace_preview`;
- provider protocol and runtime modules for Codex, Cursor, Grok, and OpenCode;
- lifecycle, relay, source-control, terminal, and workspace service paths; and
- small zero-coverage dispatch or facade modules that are part of the owned runtime.

Rust coverage is improved with a mix of focused module tests and existing-style integration tests under `apps/server/tests`. Tests exercise typed errors, cleanup guarantees, cancellation, persistence, bounded output, and restart behavior as well as successful flows. Filesystem and Git behavior use temporary repositories and directories. Network behavior uses loopback listeners or injected transports. Provider behavior uses the existing language-neutral fixture corpus and controlled child-process fixtures.

Platform-only code that cannot execute on the current host is not silently removed from coverage. Where compile-time platform branches make a repository-wide metric misleading, any proposed inventory change must be separately justified as non-executable generated or foreign-platform bootstrap code and approved before use. The default expectation is to add a portable seam and test the shared behavior.

### Testability changes

Production refactoring is deliberately limited. Acceptable changes include:

- extracting a pure decision function from a component or native adapter;
- injecting a clock, process runner, filesystem operation, HTTP transport, or platform fact;
- splitting an oversized module along an existing responsibility boundary; and
- replacing implicit global state with an explicit existing service interface.

Every new production function or interface is introduced by a failing test, then implemented minimally and kept covered. Test-only production methods, conditional behavior compiled only for tests, and assertions against mock call trivia are prohibited.

### Iterative coverage control

Work is divided into coverage cohorts. A cohort is a coherent group of tests for one subsystem and ends with:

1. focused test execution;
2. the relevant full-language coverage run;
3. comparison of aggregate deltas against the previous report; and
4. removal or revision of tests that do not verify a stable behavior.

The TypeScript and Rust cohorts alternate when practical so one language does not reach 85% while the other remains far below its target. Reports remain local build artifacts and are not committed.

Because coverage of existing behavior does not necessarily begin with a failing assertion, the red step for test-only additions is an uncovered contract identified by the coverage report and a test that demonstrably increases execution of that contract. Any production change still follows strict failing-test-first TDD.

### Coverage policy

The existing source inventories remain authoritative:

- TypeScript continues using `coverageInclude`, `coverageExclude`, and the coverage-policy tests in `scripts/coverage-config.test.ts`.
- Rust continues covering the entire Cargo workspace with all targets and build scripts.

The implementation may correct an accidental mismatch between inventory and executable owned source, but it must not add exclusions, ignore pragmas, test-only branches, duplicate trivial files, or generated assertions to manufacture the target percentage.

After measured coverage is at least 85% in every metric, update all current thresholds from 74 to 85 and update their policy tests in the same change. The threshold change is the final coverage cohort, not the mechanism used to claim success.

## Reliability and Failure Handling

Tests must remain deterministic under load and on retries. They use bounded deadlines, explicit cancellation, temporary resources, and cleanup that runs even after assertion failures. They do not depend on public services, installed provider CLIs, user Git configuration, user credentials, fixed local ports, or execution order.

Coverage commands must report test failures separately from threshold failures. A cohort that raises coverage but introduces warnings, leaked tasks, unhandled rejections, orphan processes, or nondeterministic timing is not accepted.

## Verification

Focused commands are selected per cohort. Final verification uses the repository commands exactly:

```bash
vp run test:coverage
vp check
vp run typecheck
```

The completion audit reads the final TypeScript summary and Rust `TOTAL` row and confirms that every configured metric is at least 85%. It also inspects the coverage configuration and policy tests to confirm that the inventory was not narrowed and every threshold is exactly 85.

## Out of Scope

- Requiring every individual source file to reach 85%.
- Replacing Vite+ or `cargo llvm-cov` with another coverage system.
- Adding browser end-to-end infrastructure solely for this goal.
- Excluding owned source, adding ignore pragmas, or counting generated code to manipulate the aggregate.
- Unrelated feature work or broad architectural rewrites.
