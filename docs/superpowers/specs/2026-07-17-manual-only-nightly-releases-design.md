# Manual-Only Nightly Releases

## Goal

Stop T4Code from creating nightly releases automatically while retaining the
ability for a maintainer to create a nightly release explicitly from GitHub
Actions.

## Release Triggers

`.github/workflows/release.yml` will support two release entry points:

- a pushed version tag matching `v*.*.*`, excluding `v*-nightly.*`; and
- a manual `workflow_dispatch` run with the existing `stable` or `nightly`
  channel choice.

The workflow will no longer declare a `schedule` trigger. Removing the trigger,
rather than adding a false condition or repository flag, ensures GitHub does
not create periodic workflow runs that immediately skip.

## Workflow Structure

The scheduled-only `check_changes` job will be deleted. `preflight` will no
longer depend on that job or contain scheduled-run conditions.

The release metadata step will preserve its manual nightly branch. A manually
dispatched `nightly` run will continue to use
`scripts/resolve-nightly-release.ts`, produce a dated nightly version and tag,
publish a GitHub prerelease, and avoid marking the release as latest.

Stable tag releases and manually dispatched stable releases will retain their
current version validation and latest/prerelease behavior.

## Supporting Tooling

The nightly metadata resolver, its unit tests, release smoke coverage, and
historical nightly-tag handling will remain because they are required by the
manual nightly path.

Release documentation will describe nightly releases as manual-only. It will
remove the three-hour schedule and change-detection language while retaining
instructions and expectations for manual nightly dispatches.

## Testing

Implementation will follow a red-green-refactor cycle:

1. Add a workflow contract test that fails while `release.yml` contains a
   schedule, `check_changes`, or scheduled-event branching.
2. Assert that the manual `nightly` channel and nightly resolver invocation
   remain present.
3. Remove the scheduled workflow path and make the targeted test pass.
4. Run the release smoke test, `vp check`, `vp run typecheck`, and the complete
   test suite.

The contract test protects both sides of the requirement: automated nightly
releases cannot return unnoticed, and manual nightly releases cannot be removed
by an unrelated workflow cleanup.

## Non-Goals

- Removing manual nightly releases.
- Deleting nightly metadata or historical tag support.
- Changing stable or stable-prerelease behavior.
- Changing artifact platforms, signing, publishing, or deployment behavior.
