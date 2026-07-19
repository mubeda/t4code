# Direct Dependency and Toolchain Modernization Report

## Result

The direct dependency modernization and the available native package matrix
are complete. Every declared direct JavaScript dependency, registry Rust
crate, local Rust crate, GitHub Action, and toolchain pin is represented in the
checked-in upgrade ledger. All compatible stable upgrades are applied,
clean-install reproducibility is proven, the full local test and build gates
pass, and the packaged UI suite passes on Linux x64, Windows x64, macOS arm64,
and macOS Intel.

The final packaged run is
[GitHub Actions run 29671427032](https://github.com/mubeda/t4code/actions/runs/29671427032)
at commit `37ea7c6adf65c0d17f95eacab6e3ad5947d1a167`. All four
jobs passed and uploaded their native installer, three UI screenshots, and
four bounded driver logs.

This report does not infer results for client operating systems that were not
available as runners. Windows 10/11 clean/offline WebView2 and an actual macOS
11 runtime remain explicit evidence gaps; the tested Windows host was Windows
Server 2025 and the tested macOS hosts were macOS 26.

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

- `vp test`: 477 test files and 6,278 tests passed.
- `vp run test`: all 9 package test scripts passed.
- Desktop E2E support tests: 7 files and 24 tests passed.
- Packaged desktop UI: all 3 specs passed.

One earlier recursive package run observed a single HTTP 400 from the mock
update server's byte-range test. The route does not emit that status and the
failure did not reproduce: the focused test passed 20 consecutive runs, the
complete scripts suite passed 10 consecutive runs, and the complete recursive
package gate passed on retry. No product or assertion change was made for the
non-reproducing test-environment transient.

The first Node 26 packaged-UI run found a real interoperability regression:
WebdriverIO supplied a manual `Content-Length` header across two Undici fetch
implementations, and Node 26 rejected the request with
`UND_ERR_INVALID_ARG`. A test-first harness fix now clones each request,
removes only `Content-Length`, and lets the active fetch runtime calculate the
header. The focused regression test, all E2E support tests, and the mounted-DMG
suite pass.

## Packaged UI Validation

The native installers were built, installed or mounted, and exercised through
the same WebdriverIO/Tauri path on every matrix leg. The suite passed:

1. Add a Git project through **Browse folder** and verify persistence after an
   application restart.
2. Create a project session, stream a deterministic provider response,
   reconnect, and exercise the terminal lifecycle.
3. Exercise settings, the updater-disabled state, provider shims, native
   connections, WSL capability-dependent rendering, and platform opener
   capabilities.

The 12 retained screenshots were visually reviewed at the tested minimum
window size. Each platform shows the imported fixture project, the streamed
session and terminal state, and native settings. The 16 retained logs contain
no log-level warning/error, `EPERM`, Undici failure, or panic entry. Expected
WebDriver element-polling misses remain visible in per-spec traces.

The final matrix results were:

| Matrix leg  | Native package | UI result      | Duration |
| ----------- | -------------- | -------------- | -------- |
| Linux x64   | AppImage       | 3 specs passed | 9m 02s   |
| Windows x64 | NSIS           | 3 specs passed | 20m 49s  |
| macOS arm64 | DMG            | 3 specs passed | 8m 37s   |
| macOS Intel | DMG            | 3 specs passed | 15m 55s  |

The Windows run also validates the final teardown repair. WebdriverIO invokes
configuration `onComplete` hooks before launcher-service `onComplete` hooks,
so the Tauri service still owned test-state handles when the old cleanup ran.
Cleanup now waits for launcher process exit, after service shutdown, and uses
bounded recursive filesystem retries. The ordering and retry options have
unit regressions, and the final Windows job exits successfully after all three
specs.

Every UI artifact contains only the expected top-level PNG and log files. No
state directory, settings database, provider shim, or credential-bearing test
fixture was uploaded.

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

## Final Native Artifacts

All artifacts below originated from run 29671427032 and embed version 0.2.2.
They are test artifacts, not signed public releases.

| Matrix leg  | Filename                              | Size       | SHA-256                                                            | Architecture and signing state                          |
| ----------- | ------------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Linux x64   | `T4Code (Alpha)_0.2.2_amd64.AppImage` | 90,548,728 | `767b3be0c7e99257fa46e772abca8a1039904fd7545c75f23056d6dcaa07f726` | x86-64 AppImage; unsigned                               |
| Windows x64 | `T4Code (Alpha)_0.2.2_x64-setup.exe`  | 9,865,733  | `339a058a769ea08af982ea2e39a87585f7cdba2da7f61aa7be168dfc6cbe38d9` | x64 NSIS payload; Authenticode security directory empty |
| macOS arm64 | `T4Code (Alpha)_0.2.2_aarch64.dmg`    | 11,919,908 | `a53478e55e02fdfb1f9d78aca9dd851ce1767182126c9464199a96f49cad9173` | arm64 DMG; app has only an ad-hoc linker signature      |
| macOS Intel | `T4Code (Alpha)_0.2.2_x64.dmg`        | 12,766,711 | `5ca048a8328c792c6dd9123b052207a906cd1ce7aed4d41c836b712cd240dd2b` | x86_64 DMG; app is unsigned                             |

Both DMGs are read-only zlib-compressed UDIF images. Their application
metadata reports version 0.2.2 and minimum macOS 11.0. The Windows job
silently installed the NSIS artifact before exercising it. The Linux job
executed the AppImage under Xvfb on Ubuntu 22.04.

Updater UI remains intentionally unavailable. The Tauri updater configuration
has an empty public key and no endpoints, the workflow publishes no updater
manifest, and none of these artifacts is suitable for trusted public
distribution without platform signing.

## Cross-Platform Compatibility Status

The final native/UI workflow proves the upgraded dependency graph on its four
supported build targets:

| Target                      | Evidence                                                                            | Result |
| --------------------------- | ----------------------------------------------------------------------------------- | ------ |
| Ubuntu 22.04 x64            | AppImage build and all packaged UI specs under Xvfb                                 | Passed |
| Windows Server 2025 x64     | NSIS build, silent install, and all packaged UI specs                               | Passed |
| macOS 26 arm64              | DMG mount and all packaged UI specs                                                 | Passed |
| macOS 26 Intel              | DMG mount and all packaged UI specs                                                 | Passed |
| Ubuntu 24.04 amd64 userland | Final AppImage payload initialized under Xvfb/DBus and remained live for 20 seconds | Passed |
| Debian 12 amd64 userland    | Final AppImage payload initialized under Xvfb/DBus and remained live for 20 seconds | Passed |

The Ubuntu 24.04 and Debian 12 checks used clean amd64 containers on an arm64
macOS host. Docker Desktop could not execute the AppImage's static PIE loader
stub through its emulator, so the exact SquashFS payload was extracted from
the final AppImage and launched unchanged. Both probes initialized T4Code,
started the embedded WebDriver on port 4445, hydrated the desktop shell
environment, and stayed live for the complete bounded window. This is useful
userland ABI/payload evidence, but it is not a substitute for a native
x86_64-VM test of the AppImage loader itself.

No disposable Windows 10/11 client VM or macOS 11 runner was available.
Accordingly:

- Windows 10/11 remain the documented support target, but clean/offline
  WebView2 behavior was not executed in this run.
- macOS 11 remains the declared and embedded minimum, but runtime launch was
  tested only on macOS 26.
- Windows ARM remains intentionally unsupported.

These are validation-infrastructure gaps, not observed dependency
regressions.
