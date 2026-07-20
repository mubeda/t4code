# PTY Process-Tree Ownership Hardening

## Context

Provider terminals must not leave descendants running when launch setup fails or
when the terminal is killed. Two ownership gaps remain:

1. Windows PTY launch gates only `.cmd`/`.bat` shims. PowerShell and native
   executables can run user code before their root process is attached to the
   terminal job.
2. Unix PTY setup reads the child process group, but the post-spawn guard owns
   only the root child. A setup failure can kill the root while leaving a
   HUP-resistant descendant alive.

## Chosen Design

### Gate every Windows PTY target

Generalize the existing same-binary batch trampoline into a Windows PTY launch
trampoline. First resolve and prepare the real target command exactly as today:
native executables remain direct, `.ps1` becomes profile-free non-interactive
PowerShell, and `.cmd`/`.bat` remains a structured standard-library batch launch.

Then wrap that prepared program and argv in the T4Code trampoline for every
Windows PTY launch. The trampoline opens the existing per-launch ready and
authorization events, signals ready, and waits. The parent attaches the
trampoline root to a kill-on-close Windows job before signaling authorization.
Only then may the trampoline spawn the prepared target. Descendants inherit the
job. Non-PTY provider and inventory launches keep their existing suspended native
launch path.

### Own the process tree during setup

Extend the post-spawn guard into the single owner of all uncommitted PTY process
resources:

- On Unix, capture the PTY foreground process-group ID immediately after spawn
  and before fallible setup work.
- On Windows, transfer the attached job into the guard before releasing the
  launch gate.
- On every early return or unwind, terminate the process group/job and then the
  root child.
- On success, transfer the root child to the wait thread and the process-tree
  ownership token to `PortablePtyProcess`.

This makes cleanup independent of which later reader, writer, thread, PID, or
handle setup step fails.

## Error Handling

- Gate creation, trampoline resolution, job attachment, and gate signaling remain
  explicit spawn errors.
- The gate stays unsignaled if Windows job attachment fails, so target user code
  never starts.
- A tree-termination error is diagnostic-only during guard drop; root-child
  cleanup is still attempted.
- Successful terminal kill retains the current Unix `SIGKILL` process-group and
  Windows job-termination behavior.

## Test Strategy

Use red-green tests against real ownership behavior:

1. Host-independent Windows construction tests require `.ps1` and native targets
   to appear behind the generic trampoline with exact structured argv.
2. Windows-only integration tests launch `.ps1` and native PowerShell roots that
   create long-lived descendants, kill the PTY, and require those descendants to
   terminate.
3. A Unix unit/integration regression creates a real PTY child with a
   HUP-resistant descendant, forces post-spawn cleanup by dropping the
   uncommitted guard, and requires the descendant to terminate.
4. Existing `.cmd`/`.bat` quoting, gate-ordering, PTY lifecycle, and provider
   runtime tests remain green.

## Non-Goals

- Do not change provider command semantics or terminal RPC contracts.
- Do not fork or patch `portable-pty`.
- Do not enumerate descendants after failure.
- Do not change non-PTY process supervision beyond using the existing policy.
