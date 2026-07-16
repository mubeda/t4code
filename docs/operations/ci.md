# CI Quality Gates

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`.

- Check job: installs Node/Vite+, Rust, and Tauri Linux prerequisites; runs
  `vp check`, workspace typechecking, and a Tauri desktop build.
- Test job: installs the same Node/Rust prerequisites and runs all package test
  scripts, including the Tauri host and native server Rust suites.
- Release-smoke job: validates release version rewriting, nightly metadata, and
  lockfile regeneration without publishing.

The release workflow builds Tauri installers on native runners: macOS arm64,
macOS Intel, Linux x64, and Windows x64. See [Release Checklist](./release.md).

Node.js in CI runs frontend builds, TypeScript checks, and repository scripts.
Release artifacts contain only the Tauri/Rust application and built web assets.
