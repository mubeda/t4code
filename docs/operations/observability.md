# Observability

T4Code's production backend is the native Rust server. Axum request handling,
Tokio tasks, provider supervision, terminals, Git, persistence, and desktop
integration emit diagnostics through Rust's `tracing` facade. There is no
production Node.js logger or TypeScript server observability layer.

## Runtime Boundaries

- The Tauri host and in-process server share one native desktop process.
- A headless `t4code serve` process runs the same Rust server library without Tauri.
- Provider CLIs, terminals, SSH forwards, and `cloudflared` are supervised child
  processes and appear in process diagnostics.
- Browser and WebView clients have separate client-side tracing.
- The hosted T4 Connect relay has its own Cloudflare/Axiom observability stack;
  see [Relay Observability](./relay-observability.md).

## Logs

Rust diagnostics are emitted with `tracing::debug!`, `tracing::warn!`, and
`tracing::error!` at operational boundaries. Every server mode initializes the
same native subscriber and appends to `userdata/logs/server.log` (or
`dev/logs/server.log` for a source development environment) while retaining
human-readable stderr output. `T4CODE_LOG` controls the filter and falls back to
the standard `RUST_LOG` behavior, then `info`.

In headless mode, run the native server from a terminal or service manager to
retain an additional stderr stream:

```bash
t4code serve
```

From a source checkout:

```bash
cargo run -p t4code-server -- serve
```

Desktop diagnostics come from the shared in-process Rust runtime and the same
`server.log`; no child server process is involved. The old `server-child.log`
belonged to the removed Node sidecar and is not part of the final architecture.

## Trace Diagnostics

The native server writes actionable RPC failures and decoded browser OTLP spans
to `userdata/logs/server.trace.ndjson`. Records are retained across application
restarts. The writer rotates at 4 MiB and keeps three backups, bounding disk and
memory use while preserving recent failures.

`server.getTraceDiagnostics` reads the current file and its backups on demand.
It reports parse errors, span counts, slow spans, common failures, recent
failures, and warning/error events. A missing file is reported explicitly as
`trace-file-not-found`; it is not presented as a healthy empty trace.

RPC error details are bounded before they reach this store. Authorization
headers, common token/password assignments, and URL credentials are redacted.
Git failures retain bounded stderr so errors such as malformed `.gitmodules`
entries remain actionable both in the original notification and after restart.

Provider and terminal lifecycle summaries are written as bounded NDJSON under
`userdata/logs/provider/events.log` and `userdata/logs/terminals/`. These logs
rotate at 4 MiB with three backups. They contain identifiers, event types,
status, and byte counts only: terminal output, prompts, provider payloads, tool
arguments, environment values, and credentials are never persisted.

The former Effect logger, `Logger.tracerLogger`, TypeScript `TraceRecord`, and
Node OTLP exporter paths were removed with the TypeScript server. Environment
variables documented for that implementation are not a supported native-server
configuration surface unless they are reintroduced in Rust and covered by
tests.

## Process Diagnostics

Resource diagnostics are host-scoped. Each snapshot describes the selected
environment on one machine; it is not a whole-machine total and never combines
processes from different machines. The reported groups are:

- **Combined**: the complete monitored total for that host, equal to T4Code Core
  plus External Tooling for CPU, RSS, and process count.
- **T4Code Core**: the native T4Code server or combined Tauri host/server root,
  plus UI processes that a desktop adapter can associate reliably with that
  T4Code instance.
- **External Tooling**: provider CLIs, terminals, helpers, and other processes
  launched or supervised by T4Code.

For a remote selected environment, Combined, Core, and External describe only
the remote host. A desktop client may also show the always-present local
environment's Core usage separately as **This device**; that local value is not
added to the remote total. Browser clients have no local desktop environment
to report and omit **This device**.

The UI coverage status qualifies whether co-located desktop UI processes are
included in Core:

- `available`: every UI process exposed by the supported platform mechanism was
  sampled;
- `partial`: some UI processes were sampled and a bounded failure explains the
  incomplete coverage;
- `unavailable`: the adapter could not associate any UI process reliably; and
- `notApplicable`: the runtime is headless and has no co-located T4Code UI.

The initial desktop observer reports `unavailable` and states that local UI
usage is not included. It does not estimate UI usage or claim generic
`WebContent`, browser, renderer, or executable-name matches. Core still includes
the native server in this state.

Production provider and terminal launchers register their root PID, scope,
kind, and bounded label. The schema reserves the `helper` kind, but no
production helper launcher currently registers it. Descendants inherit the
nearest registered root's attribution. A process with no registered provider or
terminal ancestor that remains descended from the native server is visible as
External Tooling with `unknown` kind and fallback confidence; missing
registration does not make it Core or remove it from the totals.

Attribution and process actions use a stable process identity made from PID and
operating-system start identity. A registration binds to that start identity
on its first matching sample, and a reused PID does not inherit the previous
process's ownership. The native sampler remains the source of CPU and memory
values; attribution does not perform a second machine-wide process refresh.

If refresh fails after a successful sample, the client retains the last good
snapshot and its original timestamp, marks it stale, and displays the bounded
failure. Before the first successful sample it shows unavailable placeholders,
not healthy-looking zeroes. Partial and unavailable UI coverage likewise remain
explicit rather than being encoded as zero usage.

Resource Manager never offers Interrupt or Kill for a Core row. For an eligible
External row, client state is only a request: immediately before signaling, the
server resamples and revalidates the PID/start identity, current ancestry, and
signal eligibility. Stale or reparented identities are rejected.

Use the Diagnostics UI or the corresponding typed RPC methods to:

- inspect current process rows and resource history;
- compare Combined, Core, and External current and historical usage;
- identify registered provider and terminal roots, their inherited descendants,
  and fallback descendants;
- signal a supervised process when the UI permits it;
- verify that shutdown leaves no owned child processes behind.

Packaged-runtime investigations should explicitly confirm that no `node`,
Electron, TypeScript server, or removed native-helper process appears in the
application tree. The desktop runtime measurement reports idle process count,
private memory or its POSIX RSS approximation, working set, and highest-memory
processes. Verify shutdown by checking that its recorded process IDs no longer
exist. Use Resource Manager's attributed CPU display for active-load checks;
the measurement script does not duplicate cross-platform CPU accounting.

## Analytics

The native telemetry domain buffers bounded analytics events and flushes them
through an injected delivery boundary. It hashes provider account identifiers
when available and otherwise persists an anonymous identifier. Analytics and
diagnostic tracing are separate concerns: analytics events are not a substitute
for request traces or operational logs.

## Instrumentation Guidance

Add spans and structured fields at meaningful Rust boundaries:

- Axum HTTP and WebSocket RPC requests;
- orchestration command dispatch and committed events;
- provider process start, request, cancellation, and exit;
- SQLite transactions and migrations;
- Git and source-control commands;
- terminal lifecycle and process-tree cleanup;
- relay installation, authentication, and tunnel lifecycle.

Keep high-cardinality values such as thread IDs, paths, and command IDs in span
fields, not metric labels. Never record prompts, credentials, bearer tokens,
pairing links, environment secrets, or raw provider authentication files.

## Verification

For observability changes, run focused Rust tests followed by the repository
gates:

```bash
cargo test -p t4code-server
cargo clippy --workspace --all-targets -- -D warnings
vp check
vp run typecheck
```

For desktop changes, launch a packaged build, exercise provider and terminal
lifecycle, inspect diagnostics, then close the app and verify that its supervised
process tree is gone.
