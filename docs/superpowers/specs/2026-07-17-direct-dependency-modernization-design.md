# Direct Dependency and Toolchain Modernization

## Goal

Bring every direct T4Code dependency, development toolchain, and GitHub Action
to its newest appropriate release while preserving reliable behavior on
Windows, macOS, and Linux.

The work must leave all JavaScript and Rust tests green, add native
cross-platform build coverage before risky upgrades, and finish with packaged
application UI validation on all three desktop operating systems.

This design uses a risk-based cohort strategy. Each cohort is independently
reviewable and revertible, and no cohort may advance while its required checks
are failing.

## Scope

The audit covers:

- all 69 unique direct external JavaScript dependencies declared by the 11
  workspace `package.json` manifests;
- all 49 unique registry Rust crates declared by the workspace and fixture
  `Cargo.toml` manifests;
- all GitHub Actions referenced by repository workflows;
- Node.js, pnpm, Rust, Vite+, and devcontainer tooling;
- Tauri core, CLI, JavaScript API, build crate, and plugins;
- operating-system packages and runner assumptions used by desktop builds; and
- regenerated JavaScript and Rust lockfiles.

Transitive dependencies will be refreshed through the authoritative lockfiles.
They will not be individually pinned unless a security, compatibility, or
reproducibility requirement makes a direct constraint necessary.

The dependency snapshot was researched on 2026-07-17. The implementation must
query authoritative registries again immediately before each cohort and record
any newer stable release in the upgrade ledger.

## Version Policy

For ordinary dependencies, "latest" means the newest stable release published
by the dependency's authoritative registry or project.

Existing intentional preview dependencies remain on their current release
channel and move to the newest matching beta, release candidate, development,
or special-source build. A preview dependency must not be silently downgraded
to an older stable generation.

The user explicitly selected the newest stable toolchains rather than an LTS
policy:

- Node.js moves from the Node 24 line to exact Node.js 26.5.0 Current;
- Node type declarations move to the matching latest Node 26 line;
- Rust moves from 1.88 to exact Rust 1.97.1;
- the workspace Rust compiler floor moves with the selected Rust toolchain;
- pnpm moves from 10.24.0 to 11.14.0; and
- Vite+ and the aliased `@voidzero-dev/vite-plus-core` move together from
  0.2.1 to 0.2.5.

Node 26 is still in Current status as of the audit date and will not enter LTS
until October 2026. This risk is intentional. The repository will pin the exact
Node release rather than a range so CI, local development, and the devcontainer
use the same runtime.

The devcontainer's secondary Bun installation path will be removed in favor of
the repository's authoritative Vite+/pnpm workflow. If a later implementation
discovery proves Bun is required, it must instead be upgraded to the latest
stable release and given an explicit compatibility check.

Tauri core and all currently declared Tauri plugins are already current. The
Tauri CLI will be moved from network-resolved `pnpm dlx` use into a locked
workspace development dependency at its latest stable release.

## Upgrade Ledger

The implementation will create and maintain a machine-readable or generated
ledger containing one row for every direct dependency, toolchain, and Action:

- manifest and dependency name;
- current declared and resolved versions;
- target version and release channel;
- authoritative source;
- risk cohort;
- platform applicability;
- migration notes;
- validation status; and
- any explicit blocker.

Completion requires every audited row to be either upgraded and green or
marked as a user-approved external blocker. A dependency cannot disappear from
the ledger merely because an installer accepted an incompatible peer graph.

## Audited JavaScript Targets

The following normal stable upgrades were identified:

| Dependency or atomic pair | Audited target |
| --- | --- |
| `@babel/plugin-transform-react-jsx` | 8.0.1 |
| `@base-ui/react` | 1.6.0 |
| `@clerk/backend` | 3.11.7 |
| `@clerk/react` | 6.12.5 |
| `@cloudflare/workers-types` | 5.20260717.1 |
| `@effect/tsgo` | 0.24.1 |
| `@formkit/auto-animate` | 0.10.0 |
| `@legendapp/list` | 3.3.3 |
| `lexical`, `@lexical/react` | 0.48.0 |
| `@noble/curves` | 2.2.0 |
| `@noble/hashes` | 2.2.0 |
| `@oxlint/plugins` | 1.74.0 |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.3 |
| `@tanstack/react-pacer` | 0.22.1 |
| `@tanstack/react-router` | 1.170.18 |
| `@tanstack/router-plugin` | 1.168.21 |
| `@types/node` | latest matching Node 26, audited as 26.1.1 |
| `@types/react` | 19.2.17 |
| `@vercel/config` | 0.5.5 |
| `@vitejs/plugin-react` | 6.0.3 |
| `@vitest/coverage-v8` | 4.1.10 |
| `astro` | 7.1.1 |
| `fast-check` | 4.9.0 |
| `jose` | 6.2.3 |
| `lucide-react` | 1.25.0 |
| `msw` | 2.15.0 |
| `react`, `react-dom` | 19.2.7 |
| `typescript` | 7.0.2 |
| `vite-plus`, aliased `vite` core | 0.2.5 |

The Vite dependency key is intentionally an alias for
`@voidzero-dev/vite-plus-core`; it must not be replaced with upstream Vite.
The Babel 8 migration must coordinate a compatible Babel core/runtime rather
than updating the JSX transform plugin in isolation. Noble 2 requires its
documented `.js` export subpath migration.

The following intentional preview or special-source families move atomically:

- `effect`, `@effect/atom`, `@effect/platform`, `@effect/sql`, and
  `@effect/vitest` from beta.78 to beta.99;
- `@pierre/diffs` from beta.5 to beta.10;
- `@pierre/trees` from beta.4 to beta.5;
- the custom-source Alchemy build from beta.51 to the newest matching
  custom-source beta, audited as beta.63;
- `drizzle-orm` and `drizzle-kit` from rc.3 to rc.4; and
- `@typescript/native-preview` from the 2026-06-04 development build to the
  audited 2026-07-07.2 build.

Updating the Effect family also requires rebasing repository patches and
running `vp run sync:repos -- --repo effect-smol` so the read-only reference
subtree matches the installed dependency.

Catalog-managed Clerk packages that are not currently direct imports must move
with the direct Clerk cohort so the catalog stays coherent:

- Clerk JS to 6.25.5; and
- Clerk shared to 4.25.5.

The following 25 direct JavaScript dependencies were already current at audit
time and remain ledger rows with no-op validation:

- `@astrojs/check`;
- the four declared `@dnd-kit` packages;
- the two declared font packages;
- `@rolldown/plugin-babel`;
- `@tauri-apps/api`;
- `@types/babel__core`;
- `@types/react-dom`;
- the two declared xterm packages;
- `babel-plugin-react-compiler`;
- `class-variance-authority`;
- `happy-dom`;
- `react-markdown`;
- `rehype-raw`;
- `rehype-sanitize`;
- `remark-breaks`;
- `remark-gfm`;
- `smol-toml`;
- `tailwind-merge`;
- `yaml`; and
- `zustand`.

TypeScript 7 and the latest `@astrojs/check` currently have an incompatible
declared peer range. The TypeScript phase must test the exact newest pair. A
narrow package-manager compatibility override is permitted only if clean
installation, Astro checking, production builds, unit tests, and native UI
tests demonstrate that the incompatibility is metadata-only. Otherwise the
phase stops until the checker is replaced without reducing coverage or an
upstream compatible release exists.

## Audited Rust Targets

The following Rust crates require upgrades:

| Crate | Audited target | Cohort |
| --- | --- | --- |
| `clap` | 4.6.2 | compatible |
| `open` | 5.4.0 | compatible |
| `tokio` | 1.53.0 | compatible |
| `uuid` | 1.24.0 | compatible |
| `ed25519-dalek` | 3.0.0 | crypto |
| `getrandom` | 0.4.3 | crypto |
| `hmac` | 0.13.0 | crypto |
| `p256` | 0.14.0 | crypto |
| `sha2` | 0.11.0 | crypto |
| `rusqlite` | 0.40.1 | storage and protocol |
| `tokio-tungstenite` | 0.30.0 | storage and protocol |
| `toml` | 1.1.3 with spec 1.1.0 | storage and protocol |
| `tower-http` | 0.7.0 | storage and protocol |
| `junction` | 2.0.0 | Windows platform |
| `sysinfo` | 0.39.6 | platform and process |
| `zip` | 8.6.0 | isolated archive migration |

All other direct registry crates were current at audit time and remain
explicitly represented in the ledger. Pre-release `libc` 1 alpha and `zip` 9
pre-release versions are excluded by the stable-release policy.

The crypto cohort must preserve fixed test vectors and compatibility with
persisted keys and signatures. Storage and protocol upgrades must preserve the
database, TOML, HTTP, and WebSocket behavior. Platform and process upgrades
must run on their native operating systems. The archive migration must use
fixtures representing existing exported or downloaded archives.

## GitHub Actions and Reproducibility

Every Action will move to its newest stable release and be pinned to the full
commit SHA. A nearby comment will retain the human-readable release number.
The audited targets are:

| Action | Audited target |
| --- | --- |
| `actions/checkout` | 7.0.0 |
| `actions/github-script` | 9.0.0 |
| `voidzero-dev/setup-vp` | 1.15.0 |
| `dtolnay/rust-toolchain` | immutable SHA with explicit Rust 1.97.1 |
| `Swatinem/rust-cache` | 2.9.1 |
| `actions/upload-artifact` | 7.0.1 |
| `actions/download-artifact` | 8.0.1 |
| `softprops/action-gh-release` | 3.0.2 |
| `mitchellh/vouch/action/check-user` | 1.5.0 |

The checkout v7 migration must be tested with a real fork pull request because
the repository's PR-size workflow uses `pull_request_target`. GitHub Script v9
must exercise issue labeling, PR comments and labels, and vouch events.
Softprops v3 must publish a disposable draft or prerelease before it is trusted
for a stable release.

No scheduled nightly release trigger will be reintroduced. Existing manual
nightly releases remain available for disposable release validation.

## Phase Architecture

### Phase 0: Validation Foundation

Capture a fully green baseline and add the native cross-platform checks that
will detect later upgrade regressions. Introduce a WebdriverIO harness using
Tauri's embedded cross-platform driver. New test-only packages must be queried
and pinned to their latest stable versions when this phase is implemented, and
must be added to the ledger.

### Phase 1: Toolchains and CI

Upgrade Node, Node types, pnpm, Rust, Vite+, the devcontainer, Tauri CLI
resolution, GitHub Actions, and lockfile formats together. Validate clean and
frozen installs on every operating system.

### Phase 2: Low-Risk Stable Dependencies

Apply compatible patch and minor JavaScript and Rust upgrades. This establishes
that the new toolchains and lockfiles are stable before ecosystem migrations.

### Phase 3: Coupled Frontend Ecosystems

Upgrade React and types, Lexical, TanStack, Tailwind, Clerk, UI utilities, and
Noble as atomic dependency families. Add migration-specific regression tests
before changing application code.

### Phase 4: Preview and Service Ecosystems

Upgrade Effect and its reference subtree, Alchemy, Pierre, Drizzle, TypeScript
native preview, Cloudflare types, and service-facing packages. Preserve custom
source intent and repository patches.

### Phase 5: Rust Risk Cohorts

Upgrade crypto, storage/protocol, platform/process, and archive dependencies in
four separate green-gated steps.

### Phase 6: Major Build Tools

Migrate Babel 8 and TypeScript 7 independently. Resolve the Astro peer conflict
under the compatibility rules above rather than hiding it.

### Phase 7: Final Artifact Validation

Requery every direct dependency, close the ledger, run all repository checks,
build release-equivalent artifacts, and exercise packaged applications on
Windows, macOS, and Linux.

## Cross-Platform CI Design

Ordinary pull-request validation currently runs only on Ubuntu. Before
dependency upgrades, CI will add:

- Ubuntu 22.04 x64 native compilation and bundling;
- Ubuntu 24.04 portable quality checks;
- Windows Server 2025 x64 native compilation and bundling;
- macOS 26 Apple Silicon native compilation and bundling; and
- macOS 26 Intel native compilation and bundling.

Each native leg performs a clean frozen install, frontend production build,
desktop Rust tests, and a no-publish Tauri bundle build. The exact Node 26.5.0,
pnpm 11.14.0, and Rust 1.97.1 versions must be asserted in logs.

Linux AppImages will be built on Ubuntu 22.04 rather than Ubuntu 24.04. Tauri
warns that building on a newer distribution can raise the artifact's glibc
floor. The AppImage will then be launched on Ubuntu 22.04, Ubuntu 24.04, and
Debian 12.

Windows support will be documented and validated for Windows 10 and Windows
11. NSIS installation must be tested with WebView2 already present and in a
clean/offline scenario so the selected WebView2 installer mode is deliberate.
Windows ARM remains outside the release matrix unless its currently
x64-specific MSVC wrapper and build prerequisites are redesigned.

macOS validation will cover both Intel and Apple Silicon artifacts. The
implementation must choose and document a real minimum macOS version rather
than relying on an implicit default. Signing and notarization are separate
release-hardening work unless credentials are explicitly added to this scope;
the test matrix must still verify the unsigned artifact behavior honestly.

## Test-Driven Migration Rules

For a dependency migration that requires application behavior to change:

1. add or identify a focused regression test for the behavior at risk;
2. demonstrate the test fails for the unmet migration requirement;
3. make the smallest compatibility change;
4. make the focused test pass;
5. refactor without changing behavior; and
6. run the cohort's full validation matrix.

A version-only update that requires no source migration does not need an
artificial failing test. It still requires the existing relevant suite to be
green before and after the change.

No cohort may:

- suppress type errors;
- delete or skip failing tests;
- weaken assertions;
- add broad peer-dependency ignores;
- add platform skips to hide native failures; or
- combine unrelated repairs that make rollback ambiguous.

A failure stops the current cohort. Diagnosis and repairs stay in that cohort,
and the complete cohort matrix is rerun before work advances.

## Automated Completion Gates

At minimum, the final source state must pass:

- `vp check`;
- `vp run typecheck`;
- `vp test`;
- the workspace `test` package script through `vp run test`;
- all Rust workspace unit and integration tests;
- clean frozen JavaScript installation on Windows, macOS, and Linux;
- release-mode native compilation and bundling on Windows, macOS Intel,
  macOS Apple Silicon, and Linux; and
- verification that a second frozen install leaves manifests and lockfiles
  unchanged.

Targeted suites for each migration are additive to these final gates.

## Packaged UI Validation

Final UI validation uses production-equivalent packaged binaries rather than
only the Vite development server. WebdriverIO with `@wdio/tauri-service` is the
preferred harness because Tauri's embedded driver supports Windows, Linux, and
macOS.

The smoke suite will:

1. launch to a usable main window without frontend or backend errors;
2. add a temporary local project through the native folder-dialog path and
   verify selection and restart persistence;
3. open or switch a session, render streamed conversation data, and exercise
   reconnect or reload behavior;
4. open a terminal and verify input, resize, and teardown;
5. exercise dialog, opener, and persisted-preference behavior;
6. confirm the updater reports its intentional disabled state;
7. verify provider executable discovery on each desktop platform;
8. verify missing SSH, WSL, and Tailscale capabilities produce bounded,
   actionable errors where applicable;
9. run at the minimum supported window size and save one screenshot per
   operating system; and
10. close and relaunch, verifying project state and that no orphan server
    process remains.

The Windows packaged suite additionally validates WSL capability handling. The
macOS suite validates both architectures. The Linux suite runs under a real
desktop session or Xvfb on each supported distribution target.

## Error Handling and Stop Conditions

Installer success is not proof of compatibility. An incompatible peer graph,
runtime warning, platform-only compilation error, migration warning, or
packaged UI failure is a cohort failure.

Overrides must be narrow, documented in the ledger, and proven by the same
tests as a normal dependency edge. If an upstream combination is genuinely
incompatible, implementation stops and reports the exact blocker. It must not
claim that all dependencies are current until the blocker is replaced,
resolved upstream, or explicitly accepted by the user.

The existing dirty change in `apps/desktop/src-tauri/src/bridge.rs` is unrelated
to this work and must not be overwritten or included in dependency
modernization commits.

## Completion Criteria

The modernization is complete only when:

- every audited direct dependency, toolchain, and Action is accounted for in
  the upgrade ledger;
- every selected target has been rechecked against its authoritative source;
- no phase has an unresolved test, type, peer, compilation, or UI failure;
- all automated completion gates pass;
- packaged UI validation passes on Windows, macOS, and Linux;
- release artifacts retain the expected names, architectures, versions, and
  checksums; and
- the final report identifies intentional current-preview dependencies and any
  separately approved non-goals.

## Non-Goals

- Individually pinning every transitive package.
- Replacing the intentional Vite+ alias with upstream Vite.
- Downgrading intentional preview families to older stable generations.
- Enabling Windows ARM64 release builds without the required native wrapper
  redesign.
- Enabling the currently disabled Tauri updater.
- Introducing scheduled nightly releases.
- Claiming signing or notarization without configured credentials and
  verifiable signed artifacts.
