# macOS Ad-Hoc DMG Signing

## Goal

Produce macOS ARM64 and Intel DMGs whose application bundles have complete
ad-hoc signatures, while continuing to use no Apple Developer identity and no
notarization. A browser-downloaded build will remain untrusted on first launch,
but macOS must allow the user to approve it through Settings > Privacy &
Security instead of reporting that the application is damaged.

## Problem

The Electron release pipeline used through `v0.1.1` ad-hoc signed the complete
application bundle. Its signature bound `Info.plist`, enabled the hardened
runtime, sealed bundled resources, and passed
`codesign --verify --deep --strict` despite having no Team ID.

The Tauri pipeline introduced in `v0.2.0` does not configure a signing identity.
On ARM64, the resulting executable has only its linker-generated ad-hoc
signature; the surrounding `.app` has no resource seal and fails strict
verification. On Intel, the application is unsigned. This behavior remains
present through `v0.2.6`. Gatekeeper interprets the malformed or absent bundle
signature as damage rather than as an overridable untrusted developer.

The existing README instruction to right-click the unsigned app or remove its
quarantine attribute therefore does not describe the current Tauri artifacts
accurately.

## Selected Approach

Set `bundle.macOS.signingIdentity` to the pseudo-identity `-` in
`apps/desktop/src-tauri/tauri.conf.json`. Tauri documents this as its supported
ad-hoc-signing configuration. It causes Tauri to sign the assembled application
bundle before creating the DMG, covering the executable, `Info.plist`, and
resources without using an Apple-authenticated identity.

The configuration applies to both supported macOS architectures. Restricting it
to ARM64 through a workflow environment variable would make local and Intel
builds behave differently without providing a benefit. Both DMGs will remain
unnotarized, have no Team ID, and require explicit user approval after download.

## Release Verification

The macOS matrix entries in `.github/workflows/release.yml` will verify the
actual DMG after the desktop artifact is built and before it is uploaded. The
verification step will:

1. Resolve exactly one generated DMG and create a temporary mount directory.
2. Mount the image read-only and locate exactly one `.app` bundle.
3. Run `codesign --verify --deep --strict --verbose=4` against the app.
4. Inspect the signature and require `Signature=adhoc` with no Team ID.
5. Detach the image through a shell trap, including on verification failure.

The job must fail if the DMG or application cannot be resolved, the bundle seal
is invalid, or the signature is not ad-hoc. Gatekeeper acceptance is not the
assertion: an ad-hoc-signed, unnotarized application is expected to remain
blocked until the user approves it.

## Automated Tests

Implementation will use a red-green-refactor cycle at two stable seams:

- Extend `scripts/tauri-hardening.test.ts` to decode and require
  `bundle.macOS.signingIdentity === "-"`.
- Extend `scripts/ci-platform-contract.test.ts` to require a macOS-only release
  verification step containing read-only DMG mounting, strict recursive
  `codesign` verification, ad-hoc identity inspection, and guaranteed detach.

The tests must fail before the configuration and workflow change are applied.
After they pass, a local ARM64 DMG will be built and inspected with the same
signature commands used in release CI. Repository completion gates remain
`vp check`, `vp run typecheck`, and `vp run test`.

## Documentation

`README.md` and `docs/operations/release.md` will describe the macOS artifacts
as ad-hoc signed without an Apple identity or notarization. The installation
guidance will explain the expected first-launch block and the Settings > Privacy
& Security approval path. It will keep the quarantine-removal command as a
testing fallback, not as the primary indication that the bundle is valid.

## Alternatives Rejected

- **Set `APPLE_SIGNING_IDENTITY=-` only in GitHub Actions.** This would repair
  release CI but leave local Tauri builds and other build workflows inconsistent.
- **Manually sign and recreate the DMG after Tauri finishes.** This duplicates
  bundler behavior, is sensitive to DMG layout changes, and adds avoidable
  mounting and repackaging failure modes.
- **Developer ID signing and notarization.** This is the correct future public
  distribution path, but it requires Apple credentials and intentionally removes
  the unsigned-testing behavior requested here.

## Non-Goals

- Adding an Apple Developer ID certificate or Apple notarization credentials.
- Making Gatekeeper trust the application without user approval.
- Enabling Tauri updater signing or publishing update metadata.
- Changing Linux AppImage or Windows installer signing.
- Replacing or mutating previously published release assets in this change.

## Reference

- [Tauri macOS code signing: Ad-Hoc Signing](https://tauri.app/distribute/sign/macos/#ad-hoc-signing)
