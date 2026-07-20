# portable-pty provenance

- Crate: `portable-pty`
- Version: `0.9.0`
- Source: `registry+https://github.com/rust-lang/crates.io-index`
- Crates.io checksum:
  `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`
- Upstream repository: <https://github.com/wezterm/wezterm>

## Imported files

This directory contains only the normalized crates.io `Cargo.toml`, the
upstream `LICENSE.md`, and the build-required source files:

- `src/cmdbuilder.rs`
- `src/lib.rs`
- `src/serial.rs`
- `src/unix.rs`
- `src/win/conpty.rs`
- `src/win/mod.rs`
- `src/win/procthreadattr.rs`
- `src/win/psuedocon.rs`

## Local deviations

The intended source deviations from portable-pty 0.9.0 are limited to:

- Windows ConPTY support for supplying an existing Job Object through
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` at process creation. This closes the
  interval in which a newly created ConPTY child could create descendants
  before T4Code assigned it to a Job.
- Correct propagation of `TerminateProcess` success and failure from the
  Windows child-killer implementations. Upstream 0.9.0 reverses the Win32
  result check and `WinChild::kill` discards the result, which makes bounded
  cleanup unable to distinguish a terminated child from a failed fallback.

## Updating

1. Update the workspace `portable-pty` version.
2. Download and verify that exact crates.io release.
3. Replace `Cargo.toml`, `LICENSE.md`, and `src/` from Cargo's verified registry
   source; do not copy examples, lockfiles, or Cargo registry metadata.
4. Reapply only the deviations documented above.
5. Update the version and checksum above from the workspace `Cargo.lock`.
6. Run the Windows cross-compile harness, target-gated Windows tests, and all
   repository checks.

Remove this fork and the workspace `[patch.crates-io]` entry once an upstream
portable-pty release provides an equivalent at-creation Job-list API.
