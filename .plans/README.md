# Architecture Planning Records

This directory contains retained server, provider, authentication, VCS, and
contract planning records. It is not the source of truth for repository
commands or the desktop package layout.

The pre-monorepo renderer and Electron plans were removed after the Tauri 2
cutover because their target files no longer exist. Some retained plans are
already implemented or partially superseded; read each document's status and
verify paths against the current tree before using it as an execution plan.

Current architecture and commands live in:

- [Architecture Overview](../docs/architecture/overview.md)
- [Workspace Layout](../docs/reference/workspace-layout.md)
- [Current Scripts](../docs/reference/scripts.md)
- [Tauri Migration Record](../docs/superpowers/plans/2026-07-08-tauri-rust-migration.md)

Retained records:

- `13-provider-service-integration-tests.md`
- `14-server-authoritative-event-sourcing-cleanup.md`
- `15-effect-server.md`
- `16-pr89-review-remediation-phases.md`
- `16c-pr89-remediation-checklist.md`
- `17-claude-agent.md`
- `17-provider-neutral-runtime-determinism.md`
- `18-server-auth-model.md`
- `19-remote-endpoints-hosted-static.md`
- `19-version-control-phase-1-vcs-driver-foundation.md`
- `20-version-control-phase-2-source-control-provider-foundation.md`
- `spec-1-1-cutover-plan.md`
- `spec-contract-matrix.md`
