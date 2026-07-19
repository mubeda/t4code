# Direct Dependency and Toolchain Modernization Report

## Result

The direct dependency modernization is locally complete on macOS. Every
declared direct JavaScript dependency, registry Rust crate, local Rust crate,
GitHub Action, and toolchain pin is represented in the checked-in upgrade
ledger. All compatible stable upgrades are applied, clean-install
reproducibility is proven, the full local test and build gates pass, and the
packaged desktop UI suite passes from a mounted DMG.

The Windows and Linux packaged UI matrix remains pending until the execution
branch may be pushed and the GitHub Actions workflow may be run.

## Synchronized Baseline

- `origin/main`: `b606a2309e021f2c315d87203054d9b92049d4a3`
- Baseline implementation head:
  `0aeaaf743d71cb0d32c5765c68bf4b6497d8c805`
- Baseline repair:
  `216b7bf232f4af68967c3e29472b346de7ace5c7`
- The implementation branch contains `origin/main`.
- Before dependency changes, `vp check`, `vp run typecheck`, `vp test`,
  `vp run test`, and `cargo test --workspace --all-targets -j 2` all passed.

## Final Toolchains

| Tool             | Final version | Policy result                                         |
| ---------------- | ------------- | ----------------------------------------------------- |
| Node.js          | 26.5.0        | Latest stable release selected for the upgrade        |
| Corepack         | 0.35.0        | Current package-manager bootstrap                     |
| pnpm             | 11.15.0       | Latest stable release selected for the upgrade        |
| Vite+            | 0.2.5         | Latest stable release selected for the upgrade        |
| Rust             | 1.97.1        | Latest stable release selected for the upgrade        |
| Cargo            | 1.97.1        | Shipped with the selected Rust toolchain              |
| TypeScript       | 7.0.2         | Latest stable release selected for the root workspace |
| Astro            | 7.1.1         | Latest stable release selected for the marketing app  |
| `@astrojs/check` | 0.9.9         | Latest stable release selected for the marketing app  |

Authoritative release pages, registry package URLs, channels, selected
versions, cohorts, and platform applicability are recorded per entry in
[`2026-07-17-ledger.json`](./2026-07-17-ledger.json).

## Inventory Closure

The deterministic ledger validator reports:

- 78 direct JavaScript dependencies
- 51 registry Rust crates
- 1 local Rust crate
- 9 GitHub Actions
- 9 toolchain pins
- 0 unaccounted declarations

The ledger contains 150 rows: 65 already current, 82 upgraded and green, and 3
removed. Eleven rows intentionally use an approved preview channel, five are
platform-specific, and no row is pending or blocked.

Final registry requery results:

- `pnpm outdated --recursive --format json` reports only the intentional
  marketing TypeScript compatibility boundary described below.
- `cargo update --dry-run` locks zero packages because the lockfile already
  contains the latest versions compatible with Rust 1.97.1 and the selected
  dependency graph.
- `vp run check:dependency-ledger` passes with zero unaccounted entries.

## Intentional Astro TypeScript Compatibility Boundary

The root workspace uses TypeScript 7.0.2. `apps/marketing` pins TypeScript
6.0.3, the latest TypeScript 6 release, because `@astrojs/check` 0.9.9 and its
language-server path do not yet support TypeScript 7. Using the root
TypeScript 7 package causes the Astro checker to crash on TypeScript's changed
export surface; it is not an application type error.

This is a narrow development-only compatibility island:

- it affects only `apps/marketing` static checking;
- the marketing application uses the latest Astro and `@astrojs/check`
  releases;
- the root, desktop E2E, scripts, shared packages, and web application all use
  TypeScript 7.0.2; and
- the full `vp run typecheck` gate, including Astro, passes with zero Astro
  errors, warnings, or hints.

Remove the local TypeScript 6 pin when Astro's checker officially supports
TypeScript 7.

## Clean-Install Reproducibility

A fresh detached worktree at the upgraded commit started without
`node_modules` or build output. The following commands passed without changing
the manifests or lockfiles:

```text
corepack pnpm install --frozen-lockfile
cargo fetch --locked
```

## Local Verification

The final dependency state passed:

```text
vp check
vp run typecheck
vp test
vp run test
vp run build
vp run release:smoke
vp run check:dependency-ledger
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets -j 2
vp run dist:desktop:dmg:arm64
```

Test totals observed during final validation:

- `vp test`: 476 test files and 6,272 tests passed.
- `vp run test`: all 9 package test scripts passed.
- Desktop E2E support tests: 7 files and 22 tests passed.
- Packaged desktop UI: all 3 specs passed.

The first Node 26 packaged-UI run found a real interoperability regression:
WebdriverIO supplied a manual `Content-Length` header across two Undici fetch
implementations, and Node 26 rejected the request with
`UND_ERR_INVALID_ARG`. A test-first harness fix now clones each request,
removes only `Content-Length`, and lets the active fetch runtime calculate the
header. The focused regression test, all E2E support tests, and the mounted-DMG
suite pass.

## Packaged macOS UI Validation

The instrumented release DMG was mounted read-only and exercised through the
same WebdriverIO/Tauri path used by CI. The suite passed:

1. Add a Git project through **Browse folder** and verify persistence after an
   application restart.
2. Create a project session, stream a deterministic provider response,
   reconnect, and exercise the terminal lifecycle.
3. Exercise settings, the updater-disabled state, provider shims, native
   connections, and platform opener capabilities.

The retained screenshots were visually reviewed at the tested minimum window
size. The retained driver logs contain no warning, error, Undici, or panic
entries.

## macOS Test Installer

- Artifact:
  `release/desktop/mac-arm64/T4Code (Alpha)_0.2.2_aarch64.dmg`
- Version: 0.2.2
- Architecture: Apple Silicon (`arm64`)
- Size: 11,590,819 bytes
- SHA-256:
  `03affc0bd4d673b15720deb97c3362a0a8bd67707ef5a787b37022ea10b3089b`
- Image format: read-only compressed UDIF
- Signing: ad-hoc linker signature only; no Apple team identity
- Notarization: not notarized

This is a local test installer, not a distributable signed/notarized release.

## Cross-Platform Compatibility Status

Cross-platform source and test-harness compatibility is represented explicitly
in the ledger and local type/test/build gates are green. The packaged macOS
runtime is validated. Final runtime evidence for Windows and Linux requires
the remote `desktop-ui-smoke.yml` matrix:

| Platform    | Local/static evidence                    | Packaged UI evidence    |
| ----------- | ---------------------------------------- | ----------------------- |
| macOS arm64 | Passed                                   | Passed from mounted DMG |
| Windows x64 | Passed in shared gates/config validation | Pending remote matrix   |
| Linux x64   | Passed in shared gates/config validation | Pending remote matrix   |

The modernization must not be called cross-platform complete until the remote
Windows, macOS, and Linux jobs pass and their artifact evidence is recorded
here.
