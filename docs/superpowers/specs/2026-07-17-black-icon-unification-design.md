# Black Icon Unification Design

## Summary

T4Code currently ships two product-icon families:

- the desired black background with solid white `T4` lettering in `assets/prod`;
- blue blueprint variants used by development, nightly, the checked-in web public
  assets, and the desktop resources consumed by Tauri.

All T4Code surfaces must use the same unbadged black-and-white icon. Development
and nightly builds will retain their existing channel names and release behavior,
but they will no longer have channel-specific icon artwork.

## Goals

- Use the existing black-and-white T4Code artwork everywhere.
- Remove every blue T4Code product-icon image and its obsolete source material
  from the repository.
- Make the production asset directory the single canonical icon source.
- Update web, desktop, and installer references so no build can select a blue
  icon.
- Protect the invariant with automated tests.

## Non-goals

- Rebrand third-party provider icons, file-type icons, screenshots, diagnostic
  artifacts, or unrelated images that happen to contain blue pixels.
- Rename development or nightly release channels.
- Change application names, bundle identifiers, or release metadata.
- Redesign the existing black-and-white artwork.

## Current-State Audit

| Consumer | Current icon family | Required change |
| --- | --- | --- |
| `assets/prod` | Black/white | Keep as canonical source |
| `assets/dev` | Blue blueprint, including a yellow `Dev` badge | Delete icon outputs and composer source |
| `assets/nightly` | Blue blueprint | Delete icon outputs |
| `apps/desktop/resources` | Blue blueprint PNG, ICO, and ICNS | Delete and point Tauri at production assets |
| `apps/web/public` | Blue blueprint favicons and Apple touch icon | Replace required public files with black production equivalents |
| `apps/marketing/public` | Black/white | Keep and verify |
| `scripts/lib/brand-assets.ts` | Selects different paths by brand | Resolve every brand/channel to the canonical production set |
| Tauri bundle configuration | Mixes blue desktop resources with the black Windows ICO | Reference only black production assets |

The web splash screen and boot shell load `/apple-touch-icon.png`, while browser
metadata loads generic favicon filenames. Those public filenames must remain
available even though their contents become black production artwork.

## Canonical Asset Model

`assets/prod` is the only authoritative location for T4Code product icons.
It contains:

- the macOS source PNG;
- the universal/Linux PNG;
- the Windows ICO;
- the web ICO, 16px PNG, 32px PNG, and Apple touch PNG;
- a black macOS ICNS derivative required by the native bundle.

The macOS ICNS is a deterministic packaging derivative of the existing black
macOS PNG. It does not introduce new artwork.

Development, nightly, and production remain valid logical web-brand inputs for
release tooling. All three resolve to the same canonical web icon paths. This
preserves release-script compatibility while removing visual channel variants.

## Desktop and Installer Integration

The Tauri bundle icon list will reference only files under `assets/prod`:

- the universal black PNG for platforms that consume a PNG;
- the black Windows ICO for Windows installers;
- the black macOS ICNS for `.app` and DMG output.

The blue files under `apps/desktop/resources` will be deleted instead of replaced
with more duplicate copies. macOS DMG, Windows NSIS/MSI, and Linux bundle
generation will therefore share the same canonical artwork.

## Web and Marketing Integration

The checked-in generic files under `apps/web/public` are necessary for Vite
development and for the splash/boot UI. Their blue contents will be removed and
replaced by byte-for-byte copies of the corresponding black production web
assets.

Publishing continues to copy brand assets into built web output. The source
selection will be channel-independent, so both stable and nightly hosted builds
receive black icons.

The marketing public assets already match the black family. They remain in place
because Astro serves them from its public directory; verification will ensure
they still match the canonical production assets.

## Asset Removal

Delete:

- the complete blue icon-output sets under `assets/dev` and `assets/nightly`;
- the development blueprint Icon Composer source and supporting blue artwork;
- the blue PNG, ICO, and ICNS files under `apps/desktop/resources`;
- the blue contents currently checked into `apps/web/public`.

The generic web public filenames remain, but only as black replacements. No
`blueprint-*` product-icon file or reference remains.

## Test-Driven Implementation

The change follows a red-green-refactor sequence.

### Red

Add or update tests that initially fail because:

- brand-asset contracts still expose development/nightly blue paths;
- nightly web overrides still select blue files;
- Tauri still references `apps/desktop/resources`;
- legacy blue asset paths still exist;
- web public icons do not match their black production equivalents.

### Green

- Collapse brand path selection onto `assets/prod`.
- Update Tauri icon references.
- Create the black ICNS derivative.
- Replace required web public icons with black copies.
- Delete all legacy blue product-icon assets and source material.

### Refactor

- Remove obsolete path constants and duplicated channel maps.
- Retain release-channel behavior while making the single-icon invariant
  explicit in names and tests.

## Verification

Verification must include:

- targeted brand-asset and Tauri-hardening tests;
- a repository search proving no `blueprint-*` product-icon paths or references
  remain;
- byte or decoded-image comparisons for public web/marketing derivatives;
- `vp check`;
- `vp run typecheck`;
- web and desktop build smoke checks;
- a macOS application/DMG build;
- visual inspection of the built application icon and generated icon-family
  contact sheet.

The existing unrelated modification to
`apps/desktop/src-tauri/src/bridge.rs` must remain untouched and must not be
included in icon-specific commits.

## Risks and Mitigations

- **macOS icon packaging regression:** generate and validate a black ICNS, then
  inspect the built `.app`/DMG instead of relying only on source files.
- **development favicon regression:** retain the generic Vite public filenames
  and verify they match production assets.
- **nightly release-script breakage:** keep the existing channel and brand inputs
  while mapping them to one icon source.
- **future blue asset reintroduction:** tests assert canonical paths and absence
  of the known legacy asset families.
