# Terminal Responsiveness and Rendering Performance Design

## Goal

Make managed terminals feel immediate and predictable while substantially reducing terminal-related
CPU, GPU, memory, and RPC overhead.

The design fixes four user-visible failures:

- PowerShell predictive-history ghost text appears while typing and is difficult to dismiss.
- The terminal can lose its visible blinking cursor and keyboard focus.
- Rapid input produces many concurrent RPC writes and can feel slow or unresponsive.
- Hidden terminals continue consuming rendering and subscription resources.

It also introduces adaptive WebGL rendering with a persisted escape hatch in the existing
environment `settings.json`.

## Chosen Approach

Use an end-to-end hot-path optimization rather than a narrow UI patch or a protocol rewrite.

The implementation keeps the existing terminal RPC protocol and server-owned terminal processes,
but changes how input is scheduled, how transcript history is retained, how output reaches xterm,
and when a renderer is allowed to exist.

This approach was selected because it removes the known repeated-work paths without taking on the
migration risk of binary terminal frames or a new streaming protocol.

## Behavioral Invariants

- Hiding a terminal never stops its shell or a command running inside it.
- Only visible terminals own xterm renderers, live output subscriptions, or WebGL contexts.
- Reopening a terminal reconstructs its display from server history and then resumes live output
  without a gap or duplicate output.
- Input reaches the PTY in exactly the order produced by xterm.
- Input that may have failed is never replayed automatically.
- PowerShell history navigation and explicit completion remain available; only predictive
  history/ghost text is disabled.
- WebGL failure never makes the terminal unusable.
- Turning WebGL off is persisted in the existing environment `settings.json`.

## Renderer and Subscription Lifecycle

`TerminalViewport` is a visible-resource owner rather than a permanently mounted representation of
a server session.

When a terminal becomes visible:

1. Create xterm and the fit addon.
2. Attach to the client terminal runtime.
3. Seed xterm from the runtime/server snapshot.
4. Subscribe an imperative output sink for subsequent deltas.
5. Load WebGL if the persisted setting enables it.
6. Fit, resize if dimensions changed, and restore focus when activation requested it.

When the terminal becomes hidden, its panel is replaced, or the document becomes non-visible:

1. Stop the live output sink.
2. Dispose the WebGL addon and xterm instance.
3. Release observers, timers, and DOM listeners.
4. Leave the server terminal session and process running.

The terminal group/tab UI state remains in the existing UI store. Only renderer resources are
released. React must not keep one hidden `TerminalViewport` mounted for every retained thread.

When visibility returns, the normal attach path obtains the bounded transcript snapshot and
continues from the current session generation. Existing attach generation/version safeguards remain
the authority for avoiding stale output from an older process.

## Output Data Path

### Client Runtime

The client runtime owns a bounded chunked transcript for each attached terminal session.

The transcript tracks UTF-8 byte size incrementally. Appending an output event encodes and examines
only the new delta, then evicts old chunks until the existing 512 KiB limit is satisfied. If a
partial chunk must be retained, trimming occurs at a valid Unicode boundary.

The transcript is materialized into one string only when a snapshot is needed, such as renderer
attachment or explicit state inspection. Output events no longer:

- encode the complete accumulated transcript;
- concatenate and retain an ever-growing temporary string; or
- require the React component to compare the complete previous and current buffers.

Status, error, exit, and attachment metadata remain observable React state. Live output is delivered
to an imperative listener owned by the visible viewport, so every PTY chunk does not trigger a
large React render.

### Visible xterm Sink

The visible sink queues output deltas and coalesces them for one xterm write per browser rendering
turn. A size threshold forces an earlier flush during very large bursts so the pending queue stays
bounded and output latency remains predictable.

The initial transcript snapshot is written once. Subsequent output uses direct deltas; it does not
use full-buffer `startsWith` comparisons.

If the document becomes hidden, the renderer subscription is released rather than accumulating a
browser rendering queue while animation frames are throttled. Server history remains the catch-up
source when visibility returns.

### Server History

Server terminal history changes from one repeatedly scanned and drained `String` to a bounded
chunked history.

Each append:

- scans only the new output for line boundaries;
- updates retained line accounting;
- evicts only the necessary oldest chunks or prefixes; and
- preserves the existing 5,000-line behavior.

History is joined only when a terminal snapshot is requested. The live broadcast remains a direct
delta stream. This makes sustained output amortized O(new output plus evicted output), rather than
repeatedly scanning the entire retained history.

## Ordered Input Queue

Each terminal has one input scheduler in the client runtime. All terminal input paths use it,
including typing, paste, navigation keys, deletion, control sequences, and programmatic clear
operations.

The scheduler has these rules:

1. `enqueue(data)` preserves each string in arrival order.
2. An idle queue schedules its first drain in a microtask, allowing same-turn events to coalesce
   without adding a perceptible frame delay.
3. There is at most one `terminal.write` RPC in flight for a terminal.
4. While an RPC is in flight, newly queued input is concatenated into the next payload.
5. Large payloads are split at valid Unicode boundaries into bounded RPC frames.
6. When a write succeeds, the next queued payload is sent immediately.
7. When a write fails, the failed payload and all dependent pending input are discarded, the
   terminal exposes the write error, and no input is replayed automatically.
8. The queue is reset only after the session is confirmed attached again or a new session
   generation starts.

Discarding dependent input on failure is intentional. Sending later characters after an earlier
prefix was lost could create a different and potentially destructive shell command.

The scheduler registry removes an entry when the corresponding terminal session is closed, so
inactive historical IDs do not retain queues.

## Focus and Cursor Behavior

The viewport restores xterm focus in two explicit situations:

- pointer-down inside the terminal rendering surface; and
- activation of a drawer, center panel, right panel, or terminal tab.

Activation focus occurs after the renderer is mounted and layout/fit has completed. It is tied to an
activation token rather than incidental React renders, so background terminal updates cannot steal
focus from the composer, settings, or another terminal.

Pointer focus applies only to the terminal surface, not toolbar buttons or resize handles. It
preserves xterm selection behavior.

The xterm cursor continues to use blinking mode. Tests verify that focus calls occur after
activation and that terminal CSS does not leave the active cursor hidden.

## Reliable PowerShell Prediction Disablement

Managed `pwsh.exe` and `powershell.exe` candidates use an invisible post-profile bootstrap. T4Code
does not send `Set-PSReadLineOption` as terminal input, so the bootstrap command is neither rendered
as user input nor added to interactive command history.

PowerShell is launched with `-NoLogo`, `-NoExit`, and a `-Command` bootstrap equivalent to:

```powershell
$command = Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue
if ($command -and $command.Parameters.ContainsKey('PredictionSource')) {
    Set-PSReadLineOption -PredictionSource None -ErrorAction Stop
}
```

PowerShell loads the user profile before executing the startup command. This ordering ensures a
profile cannot re-enable prediction before T4Code applies the managed setting. Resolving the command
also loads PSReadLine when it is available.

If `Set-PSReadLineOption` or its `PredictionSource` parameter is unavailable, the bootstrap is a
no-op because that PSReadLine version has no predictive-history feature to disable. Other PSReadLine
features, including Up/Down history navigation and Tab completion, remain available.

The contract is verified against a real Windows PTY. The integration test launches the same managed
shell candidate used in production and queries `Get-PSReadLineOption`. A PowerShell version that
supports prediction must report `PredictionSource = None`; a version without the property is
accepted as unsupported. The test also verifies that the bootstrap text does not appear in
interactive history.

Argument unit tests remain useful but are not accepted as proof of behavior.

## WebGL Setting and Adaptive Fallback

The server-authoritative settings schema adds:

```json
{
  "terminal": {
    "webglEnabled": true
  }
}
```

The default is `true`. The value is supported by the TypeScript contracts, Rust settings state and
patch model, settings JSON persistence, settings RPC, and a Terminal section in the Settings UI.
Older settings files decode with the default. Updating the toggle writes the existing environment
`settings.json`.

The visible viewport dynamically imports and loads `@xterm/addon-webgl` only when:

- the terminal is visible;
- the document is visible; and
- `terminal.webglEnabled` is true.

Dynamic loading keeps the addon out of the initial terminal path when WebGL is disabled. An
asynchronous load uses a generation guard so a late import cannot attach to a disposed terminal.

Disabling WebGL disposes the addon and returns xterm to its standard renderer. Enabling it attempts
to load the addon for each currently visible viewport without restarting the shell or losing
history.

Initialization failure or WebGL context loss disposes the addon and falls back to the standard
renderer. T4Code records one diagnostic event for the fallback but does not repeatedly retry within
the same viewport lifetime. The persisted preference remains unchanged, allowing a later renderer
or application restart to try again.

Hidden and unmounted terminals never retain WebGL contexts.

## Resize Scheduling

The existing latest-value resize behavior remains, with an additional exact-dimension guard.

The viewport records the last successfully requested `(cols, rows)` pair. Fit/layout events that
produce the same dimensions do not issue another RPC. A changed size replaces any resize still
waiting to be sent, preserving the most recent geometry without building a backlog.

## Failure Handling

- A renderer or WebGL failure affects only that viewport; the server shell continues running.
- WebGL failures fall back automatically and are diagnosed once.
- Input RPC failures stop and clear the dependent queue instead of replaying uncertain data.
- Attach/reconnect generation checks reject stale output from an older process.
- A corrupt or partial settings file follows existing settings recovery behavior, with
  `terminal.webglEnabled` defaulting to `true` when omitted.
- Transcript truncation removes complete oldest data at Unicode-safe boundaries.
- Renderer cleanup is idempotent so rapid tab, panel, and document visibility changes cannot leak
  observers, listeners, subscriptions, or GPU resources.

## Testing Strategy

Implementation follows red-green-refactor cycles.

### Contracts and Settings

- Omitted terminal settings decode to WebGL enabled.
- A false value round-trips through contract encoding, Rust persistence, and settings RPC updates.
- Existing settings JSON remains backward compatible.
- The Settings UI reflects and updates the persisted value.

### PowerShell

- Windows shell candidates receive the managed post-profile bootstrap.
- `cmd.exe` and non-Windows shells are unchanged.
- A real Windows PTY reports `PredictionSource = None` when supported.
- Unsupported older PSReadLine versions remain usable.
- The bootstrap is not present in interactive command history.

### Input

- Rapid events coalesce into fewer RPC writes.
- Only one write is in flight per terminal.
- Deferred writes preserve exact byte/character ordering.
- Independent terminals do not block one another.
- Large Unicode paste input splits safely and remains ordered.
- A failed write clears dependent input and is never replayed.
- Closing or replacing a session removes its scheduler.

### Focus and Cursor

- Pointer-down focuses xterm without toolbar focus theft.
- Drawer, panel, and tab activation focus after mount and fit.
- Inactive terminal updates do not steal focus.
- The active xterm cursor is visible and blinking.

### Output and Lifecycle

- Chunked client history enforces the existing byte limit and Unicode-safe truncation.
- Chunked server history preserves 5,000-line semantics.
- Sustained output does not rescan the complete retained transcript per event.
- Visible output deltas reach xterm in order and are coalesced.
- Hidden terminals have no xterm instance, output sink, observers, or WebGL addon.
- Reopening restores the snapshot and receives later output without gaps or duplicates.
- Hiding a viewport does not close or kill its shell process.
- Duplicate terminal dimensions do not produce duplicate resize RPCs.

### WebGL

- Enabled settings load the addon only for visible terminals.
- Disabled settings never import or instantiate the addon.
- A late dynamic import cannot attach after unmount.
- Initialization failure and context loss dispose WebGL and preserve terminal usability.
- Hiding, unmounting, or disabling the setting releases the GPU context.

## Performance Acceptance Criteria

Tests prefer structural guarantees over timing thresholds that would be flaky in CI:

- zero hidden xterm renderers and WebGL contexts;
- zero React transcript renders for ordinary live output deltas;
- no full retained-buffer encoding or prefix comparison per output event;
- amortized incremental client and server transcript maintenance;
- at most one input RPC in flight per terminal;
- fewer RPC writes than input events during a delayed burst;
- no resize RPC when dimensions are unchanged; and
- bounded client transcript and visible output queues.

Development profiling will compare a sustained-output terminal and a rapid-input terminal before and
after the change. The profiling check confirms that terminal work is concentrated in the visible
viewport and that hiding the application or switching threads removes renderer CPU/GPU activity.

## Verification

Before completion:

- run focused web unit and interaction tests;
- run focused Rust unit and Windows PTY integration tests;
- run the repository terminal-related test suites;
- run `vp check`; and
- run `vp run typecheck`.

Manual Windows verification covers PowerShell typing without ghost history, cursor visibility,
rapid typing and deletion, hidden command continuity, renderer switching, WebGL disablement, and
automatic fallback.

## Out of Scope

- A binary WebSocket terminal protocol.
- Local echo, which could display input that the shell never received.
- Disabling ordinary PowerShell history navigation or Tab completion.
- Stopping hidden terminal processes.
- Persisting WebGL preference in a second device-local store.
- Retrying uncertain terminal input automatically.
- Modifying vendored repositories under `.repos/`.
