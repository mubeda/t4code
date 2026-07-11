# Canonical T4Code Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make T4Code the only active identity across the repository and built products.

**Architecture:** Perform a hard coordinated rename of package, Rust, runtime,
protocol, persistence, build, and documentation surfaces. Regenerate dependency
metadata after source renames and enforce the result with a repository guard.

**Tech Stack:** TypeScript, pnpm, Vite+, Rust, Cargo, Tauri 2, GitHub Actions.

## Global Constraints

- Canonical product name is `T4Code`; canonical slug and CLI are `t4code`.
- Canonical npm scope is `@t4code`; canonical environment prefix is `T4CODE_`.
- Do not preserve aliases using the removed identity.
- Do not edit vendored repositories under `.repos`.
- Generated lockfiles must be regenerated rather than hand-maintained.
- All existing quality gates remain mandatory with zero warnings.

---

### Task 1: Add The Identity Guard

**Files:**

- Create: `scripts/t4code-identity.test.ts`
- Modify: `scripts/package.json`

**Interfaces:**

- Produces a test that scans project-owned paths and UTF-8 text files while
  excluding `.git`, `.repos`, `node_modules`, `target`, and generated binaries.

- [x] Write a failing test that reports every removed identity occurrence and path.
- [x] Run `vp test scripts/t4code-identity.test.ts` and verify it fails.
- [x] Keep the test active through the rename until it returns zero findings.

### Task 2: Rename Workspace And Rust Identities

**Files:**

- Rename: predecessor plugin directory to `oxlint-plugin-t4code`
- Modify: all project-owned `package.json`, TypeScript imports, `pnpm-workspace.yaml`
- Modify: `Cargo.toml`, `Cargo.lock`, `apps/server/Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`
- Modify: Tauri configuration and Rust executable references

**Interfaces:**

- Produces `@t4code/*`, `t4code-server`, `t4code-desktop`, and `t4code` CLI names.

- [x] Rename directories and manifests.
- [x] Replace workspace imports, filters, crate paths, binary names, and process assertions.
- [x] Regenerate both lockfiles and run focused workspace/Cargo metadata checks.

### Task 3: Rename Runtime And Protocol Identity

**Files:**

- Modify: `apps/server/src/**`, `apps/desktop/src-tauri/src/**`, `apps/web/src/**`
- Modify: `packages/client-runtime/src/**`, `packages/contracts/src/**`, `packages/shared/src/**`
- Modify: `infra/relay/src/**`

**Interfaces:**

- Produces `T4CODE_*`, `VITE_T4CODE_*`, `t4code:` storage keys,
  `/.well-known/t4code/environment`, and `/__t4code/channel`.

- [x] Rename runtime constants, routes, marker strings, schemas, telemetry, and persisted keys.
- [x] Update language-neutral fixtures and contract parity tests.
- [x] Run focused server, client-runtime, contracts, relay, and web tests.

### Task 4: Rename Tooling, CI, Releases, And Documentation

**Files:**

- Modify: `.github/**`, `scripts/**`, all project-owned Markdown
- Modify: release artifact builders, smoke tests, measurement tooling, and docs links

**Interfaces:**

- Produces T4Code-only build commands, artifact names, environment configuration,
  release metadata, examples, and documentation.

- [x] Rename all tooling and workflow inputs/outputs.
- [x] Rename project-owned files whose paths contain the removed identity.
- [x] Validate every local Markdown link.

### Task 5: Regenerate And Verify

**Files:**

- Regenerate: `pnpm-lock.yaml`, `Cargo.lock`, web output, desktop installers
- Modify: any source exposed by final verification

**Interfaces:**

- Produces a repository and release artifacts with zero removed identity findings.

- [x] Run the identity guard and direct path/content scans.
- [x] Run `vp check`, `vp run typecheck`, `vp test`, and `vp run test`.
- [x] Run Rust formatting, clippy with `-D warnings`, and workspace tests.
- [x] Build release installers and scan their names and embedded application strings.
- [x] Verify browser mode in Chrome and packaged Tauri mode on Windows.
