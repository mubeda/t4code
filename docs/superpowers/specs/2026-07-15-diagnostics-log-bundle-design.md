# Diagnostics Log Bundle Design

## Goal

Keep the bottom of Settings → Diagnostics clear of the persistent status bar and add a reliable download that produces one ZIP archive containing one server log file and one frontend log file.

## User Experience

The Diagnostics page receives enough bottom padding for its final content and focus ring to scroll fully above the status bar at desktop and compact viewport sizes.

A final “Diagnostic logs” section contains a primary `Download logs` button and concise copy explaining that the archive contains redacted server and frontend diagnostics. While a download is being prepared, the button is disabled and shows progress. A successful request starts a browser download named `t4code-diagnostics-<UTC timestamp>.zip`. A failure leaves the page usable and displays an error toast with an actionable message.

The same interaction works in the browser-hosted application and the Tauri webview. It downloads logs from the environment represented by the Diagnostics page rather than reading local desktop paths directly.

## Archive Contract

The ZIP contains exactly two regular files at its root:

- `server.log` combines the retained rotating `server.log` files in chronological order, oldest backup first and the active file last. Each source is separated by a plain-text header. If no server log exists, the file contains an explanatory line instead of failing the whole download.
- `frontend.log` contains the bounded frontend diagnostic capture supplied with the request. If capture is unavailable or empty, it contains an explanatory line.

The archive is generated in memory and returned directly. It is never written to a temporary path. Entry names are constants, so user input cannot influence ZIP paths.

## Frontend Diagnostic Capture

Capture is installed once during the earliest web bootstrap shared by browser and Tauri clients. It preserves the original browser behavior while recording only actionable client-side diagnostics:

- `console.warn` calls;
- `console.error` calls;
- uncaught `error` events; and
- unhandled promise rejections.

Each record includes a UTC timestamp, level/source, and bounded serialized arguments. Serialization handles primitives, `Error` values, circular objects, DOM-like values, and values that throw while being inspected without allowing the logging path itself to throw.

The capture uses a byte-bounded ring buffer with a 512 KiB maximum. Oldest complete records are evicted first. It does not persist to local storage or disk, and it does not capture `debug`, `info`, ordinary `log`, terminal output, message content, or successful network traffic.

The exported frontend text is sanitized before leaving the client. The server sanitizes both requested frontend text and server log text again while building the archive so the trust boundary does not depend on client behavior. Credential-shaped values, authorization headers, cookies, API keys, and access/refresh tokens are replaced with redaction markers.

## Server Download Endpoint

Add an authenticated `POST /api/diagnostics/logs.zip` route to the Rust/Axum server. It requires an existing read-capable authenticated session and accepts a bounded JSON body containing `frontendLog`.

The body is limited to 512 KiB before decoding. Server log input is limited to the existing retained rotation set: `server.log.3`, `server.log.2`, `server.log.1`, and `server.log`. The response is limited by those bounded inputs and ZIP compression.

A successful response uses:

- `Content-Type: application/zip`;
- `Content-Disposition: attachment; filename="t4code-diagnostics-<UTC timestamp>.zip"`;
- `Cache-Control: no-store`; and
- `X-Content-Type-Options: nosniff`.

Malformed or oversized input receives the existing structured `400`/`413` response. Authentication failures use the existing authorization path. Log-read or ZIP-construction failures return a structured `500` response without exposing filesystem paths or secrets.

The archive builder is a focused server module independent of Axum so rotation ordering, placeholders, redaction, exact entry names, and ZIP integrity can be tested directly.

## Client Download Path

The client obtains the selected environment’s authenticated HTTP transport through the existing environment connection layer. A focused helper posts the current frontend log snapshot, checks the response and content type, reads the response as a `Blob`, extracts the server-provided safe filename, and triggers an object-URL download. The object URL and temporary anchor are always cleaned up.

The Diagnostics component owns only button state and toast presentation. Log capture, authenticated transport, filename parsing, and browser download mechanics stay outside the component.

## Layout

Bottom clearance belongs to the Diagnostics page content rather than the global Settings layout because the reported collision is specific to this long page and the persistent status bar. The page’s scroll content receives additional bottom padding of at least the status-bar height plus the existing visual gap. The download section is the final page section, so its button and focus outline remain reachable above the bar.

## Testing and Visual Verification

Implementation follows red-green-refactor cycles.

Automated coverage includes:

- frontend capture records only warning/error/fatal sources, preserves native console calls, bounds memory, survives circular values, and redacts secrets;
- the archive builder produces a readable ZIP with exactly `server.log` and `frontend.log`, combines rotations oldest-first, emits empty-state text, and redacts both inputs;
- the HTTP route enforces authentication and body limits and returns the required headers;
- the client helper posts the captured log, handles error responses, uses the server filename safely, triggers the download, and revokes its object URL;
- the Diagnostics panel renders the final section, disables the button during work, reports failure, and includes bottom clearance; and
- existing Diagnostics refresh, process-control, trace, and open-folder behaviors remain intact.

Visual verification uses the running browser-hosted React application with isolated T4Code state. Capture before and after screenshots at a desktop viewport and a compact viewport, with the page scrolled to the bottom so status-bar clearance and the new download section are visible. Inspect the browser console, failed requests, and the downloaded ZIP contents after the interaction.

## Out of Scope

- Capturing ordinary console `log`, `info`, or `debug` output.
- Persisting frontend logs across reloads.
- Exporting terminal output, prompts, conversations, project files, provider histories, or user configuration.
- Adding provider, trace, or terminal event files as additional ZIP entries.
- A desktop-only save dialog or native-only implementation.
