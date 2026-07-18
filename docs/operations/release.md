# Release Checklist

This document describes the current Tauri 2 desktop release workflow. The
repository no longer packages or publishes Electron artifacts.

## Release Workflow

`.github/workflows/release.yml` supports:

- stable releases from tags matching `v*.*.*`; and
- manual stable or nightly releases through `workflow_dispatch`.

The preflight job runs `vp check`, `vp run typecheck`, and `vp run test`.
The build matrix then creates native Tauri installers on the matching operating
system:

| Platform | Runner           | Architecture | Artifact        |
| -------- | ---------------- | ------------ | --------------- |
| macOS    | `macos-26`       | arm64        | DMG             |
| macOS    | `macos-26-intel` | x64          | DMG             |
| Linux    | `ubuntu-22.04`   | x64          | AppImage        |
| Windows  | `windows-2025`   | x64          | NSIS executable |

Each matrix job installs the frontend build toolchain and Rust, restores Cargo
caches, and runs `scripts/build-desktop-artifact.ts`. Tauri compiles the native
host and in-process server and embeds the built React assets. No Node runtime or
TypeScript server is packaged. The release job publishes the resulting
`.dmg`, `.AppImage`, and `.exe` files to one GitHub Release.

Stable semantic versions are marked latest. Stable prerelease versions are
GitHub prereleases and are never marked latest.
Manual nightly releases are GitHub prereleases and are never marked latest.
Nightly releases run only when a maintainer explicitly selects the `nightly`
channel in a manual workflow dispatch.

## Supported Platforms

- macOS 11 or newer on Apple Silicon (`arm64`) and Intel (`x64`);
- Windows 10 or 11 on `x64`;
- Linux `x64` AppImages built on Ubuntu 22.04 and exercised on Ubuntu 22.04,
  Ubuntu 24.04, and Debian 12.

Windows on ARM remains unsupported until `scripts/run-msvc-x64.mjs` is made
architecture-aware. Linux release artifacts use Ubuntu 22.04 to keep the
runtime glibc compatibility floor below the portable Ubuntu 24.04 CI jobs.

## Version Source

`apps/desktop/package.json` is the desktop version source.
`apps/desktop/src-tauri/tauri.conf.json` reads that version by path. The release
workflow aligns versioned application packages before building. After a
successful stable release, the finalize job updates the
versioned package files on `main` when branch protection permits the workflow
token to push.

## Cloud Configuration

T4 Connect public configuration is optional for this fork. When Cloudflare and
Clerk production configuration exists, the workflow resolves and injects:

- `T4CODE_CLERK_PUBLISHABLE_KEY`;
- `T4CODE_CLERK_JWT_TEMPLATE`;
- `T4CODE_CLERK_CLI_OAUTH_CLIENT_ID`;
- `T4CODE_RELAY_URL`;
- relay client tracing variables.

Without that configuration, desktop artifacts are still built with T4 Connect
disabled. Never place `CLERK_SECRET_KEY` in client build variables or artifacts.

Relay deployment and hosted web deployment are separate from this fork's
desktop release. The workflow intentionally does not publish the upstream
`t4code` npm package or deploy the upstream Vercel project.

## Signing And Updates

Current desktop artifacts are unsigned. Platform signing, macOS notarization,
and Windows trusted signing must be added to the Tauri pipeline before public
distribution that requires trusted installers.

The Tauri updater plugin is installed, but
`apps/desktop/src-tauri/tauri.conf.json` currently has no updater public key or
endpoints. Runtime update checks therefore report the updater as unavailable.
Do not publish updater metadata or claim automatic updates until signing keys,
endpoints, and signed updater artifacts are configured and tested.

## Local Verification

Run the repository gates:

```powershell
vp check
vp run typecheck
vp test
vp run release:smoke
```

Build the native artifact for the current operating system:

```powershell
vp run build:desktop
```

Build a specific release target:

```powershell
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --output-dir release --verbose
```

Equivalent root shortcuts are `dist:desktop:dmg`,
`dist:desktop:dmg:arm64`, `dist:desktop:dmg:x64`,
`dist:desktop:linux`, `dist:desktop:win`,
`dist:desktop:win:arm64`, and `dist:desktop:win:x64`.

## Release Check

1. Confirm `main` passes the portable and four native CI jobs.
2. Run `vp run release:smoke`.
3. Create and push `vX.Y.Z`, dispatch `stable` with an explicit version, or
   dispatch the `nightly` channel.
4. Confirm all four native matrix jobs complete.
5. Confirm the GitHub Release contains exactly the expected installers.
6. Install and smoke-test each artifact on its target operating system.
7. Record any signing or updater limitation in the release notes.

## References

- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
