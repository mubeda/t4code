# Canonical T4Code Identity Design

## Objective

Make T4Code the only project identity in active source, configuration, package
metadata, binaries, protocols, tests, generated lockfiles, and documentation.
This is a hard cutover: no permanent legacy aliases or compatibility names remain.

## Canonical Names

| Surface                 | Canonical value                   |
| ----------------------- | --------------------------------- |
| Product                 | `T4Code`                          |
| Slug                    | `t4code`                          |
| npm scope               | `@t4code/*`                       |
| Rust crate prefix       | `t4code-*`                        |
| CLI and server package  | `t4code`                          |
| Desktop binary          | `t4code-desktop`                  |
| Environment prefix      | `T4CODE_*`                        |
| Vite environment prefix | `VITE_T4CODE_*`                   |
| Browser storage prefix  | `t4code:`                         |
| Tauri identifier        | `com.t4code.app`                  |
| Well-known endpoint     | `/.well-known/t4code/environment` |
| Hosted control endpoint | `/__t4code/channel`               |

## Scope

- Rename workspace package names, dependency specifiers, filters, imports, lint
  plugin names, and the `oxlint-plugin-t4code` directory.
- Rename Rust packages, dependency keys, library names, binaries, executable
  references, process assertions, fixture names, and installer expectations.
- Rename all application-owned environment variables, storage/database keys,
  cookie names, telemetry service names, protocol routes, marker strings,
  temporary file prefixes, and app-data paths.
- Rename Tauri bundle metadata and platform identifiers.
- Update CI, release workflows, scripts, fixtures, documentation, and historical
  measurement prose so they describe T4Code only.
- Regenerate `pnpm-lock.yaml` and `Cargo.lock` from renamed manifests.
- Rename project-owned files and directories whose names contain the old
  identity. Vendored `.repos` content and Git history are out of scope.

## Compatibility

The cutover intentionally does not retain old CLI names, environment variables,
protocol routes, package aliases, storage keys, or application identifiers.
Existing installations must be replaced by the T4Code installer. This avoids
keeping the removed identity alive indefinitely.

## Verification

- A repository guard scans project-owned files and file paths case-insensitively
  for the removed product name, package scope, environment prefix, and standalone
  CLI token.
- `vp check`, `vp run typecheck`, `vp test`, and `vp run test` pass.
- `cargo fmt --all --check`, workspace clippy with `-D warnings`, and workspace
  tests pass.
- Browser and packaged Tauri smoke tests use only T4Code URLs, binaries, process
  names, storage, and metadata.
- Release executables and installers are named T4Code and contain no removed
  identity strings attributable to application code.
