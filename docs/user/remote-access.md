# Remote Access

Use this when you want to connect to a T4Code server from another device such as a phone, tablet, or separate desktop app.

## Recommended Setup

Use a trusted private network that meshes your devices together, such as a tailnet.

That gives you:

- a stable address to connect to
- transport security at the network layer
- less exposure than opening the server to the public internet

## Enabling Network Access

There are two ways to expose your server for remote connections: from the desktop app or from the CLI.

### Option 1: Desktop App

If you are already running the desktop app and want to make it reachable from other devices:

1. Open **Settings** → **Connections**.
2. Under **Manage Local Backend**, toggle **Network access** on. This will restart the app and run the backend on all network interfaces.
3. The settings panel will show the default reachable endpoint, with a `+N` control when more endpoints are available. Expand it to inspect alternatives such as loopback, LAN, private-network, or HTTPS endpoints.
4. Use **Create Link** to generate a pairing link you can share with another device.

The default endpoint controls the QR code and primary copy action for pairing links. You can change it from the expanded endpoint list. The preference is stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when you move between networks.

When no user default is saved, the app uses the built-in LAN endpoint for pairing links when
available. You can set another endpoint as the default from the expanded endpoint list.

- HTTPS/WSS-compatible endpoints work from `https://app.t4code.codes`, but are not made the default
  automatically.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

If the copied link points directly at `http://192.168.x.y:3773`, open it from a client that can reach that LAN address. If it points at `https://app.t4code.codes/pair?...`, the hosted web app will save the environment and connect directly to the backend URL in the link.

### Tailscale Endpoints

When the desktop app can detect Tailscale, it adds Tailnet endpoints to the reachable endpoint list.

Depending on your Tailscale setup, this may include:

- the machine's `100.x.y.z` Tailnet IP
- a MagicDNS name
- an HTTPS MagicDNS endpoint when Tailscale Serve is configured for this backend

The Tailscale HTTPS endpoint uses the clean MagicDNS URL, such as
`https://machine.tailnet.ts.net/`, and is disabled until the app verifies that the URL reaches this
backend. Use **Setup** on the Tailscale HTTPS row to opt in. The desktop app restarts the backend
with the same server-side behavior as `t4code serve --tailscale-serve`, then the server asks Tailscale
Serve to proxy HTTPS traffic to the local backend.

The Tailscale support is an endpoint provider add-on. The core remote model still works without Tailscale: LAN HTTP endpoints, custom HTTPS endpoints, future tunnels, and SSH-launched environments all use the same saved environment and pairing flow.

For `https://app.t4code.codes`, prefer an HTTPS Tailnet or other HTTPS endpoint. A plain `http://100.x.y.z:3773` endpoint can still work from a desktop client or another browser page served over HTTP, but it will not work from the hosted HTTPS app because of browser mixed-content rules.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a remote machine over SSH.

Run the server with `t4code serve`.

```bash
t4code serve --host "$(tailscale ip -4)"
```

`t4code serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately
- in the hosted web app, open a hosted pairing URL when the backend is reachable over HTTPS

Use `t4code serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

For hosted web pairing over Tailscale HTTPS, opt in to Tailscale Serve:

```bash
t4code serve --tailscale-serve
```

By default this configures Tailscale Serve on HTTPS port 443 and advertises
`https://machine.tailnet.ts.net/`. Advanced users can choose a different HTTPS port:

```bash
t4code serve --tailscale-serve --tailscale-serve-port 8443
```

> Note
> The Add Project dialog currently exposes the Local host flow. For project
> management on a separate remote host, use `t4code project ...` on that server
> until remote-host project selection is wired into the dialog.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse T4Code on another machine over SSH.

1. Open **Settings** → **Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote T4 server, opens a local port forward, and saves the environment.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual T4 server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, Tailscale, HTTPS, or future tunnel-backed environments.

#### SSH Launch Troubleshooting

The desktop SSH launcher connects with a non-interactive `sh` session, writes a small launcher script under `~/.t4code/ssh-launch/<host-key>/`, starts or reuses a remote T4 server, and forwards the remote loopback port back to your desktop.

The remote host must have a compatible native `t4code` executable on the
non-interactive shell `PATH`. Node.js, npm, npx, and JavaScript package-manager
shims are not searched or installed by the launcher. Install the `t4code` binary
for the remote operating system and architecture before adding the environment.

If launch fails with `t4code: command not found`, SSH into the host and test the
same non-interactive shell used by the desktop launcher:

```bash
ssh user@example.com 'sh -lc "command -v t4code && t4code --version"'
```

If that command does not resolve the native executable, install it in a standard
location such as `~/.local/bin`, `/usr/local/bin`, or another directory exported
by non-interactive `sh`. The remote binary must match the desktop release's
server protocol.

If reconnecting after an app update fails, retry the SSH launch once. The launcher now compares its generated runner script, stops stale launcher-managed remote servers, clears the SSH launch PID/port state, and starts a fresh remote server. You should not normally need to delete `~/.t4code/ssh-launch` or kill `t4code` processes manually.

### Windows Subsystem For Linux

The optional WSL backend also runs a native Linux `t4code` binary. It never invokes
WSL Node.js, npm, npx, or a JavaScript server package.

Prerequisites:

- Windows Subsystem for Linux and at least one installed distribution;
- `wsl.exe` available to the desktop process;
- a `t4code` Linux binary matching the distribution architecture;
- normal provider CLIs and credentials installed inside that distribution.

For source development, build the Linux server under
`target/<linux-triple>/(debug|release)/t4code`. The desktop searches the
`x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` targets. To use a
binary elsewhere on the Windows filesystem, set `T4CODE_WSL_SERVER_BINARY` to
its Windows path before starting the desktop app; the host translates it with
`wslpath` for the selected distribution.

The WSL launcher uses a fixed system `PATH` inside the distribution and starts
`t4code serve` directly. If launch fails, verify the binary from Windows:

```powershell
wsl.exe -d <distribution> -- /path/to/t4code --version
```

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `t4code serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Hosted Web App Pairing

The hosted web app at `https://app.t4code.codes` can save a remote backend in browser local storage from a URL like:

```text
https://app.t4code.codes/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

Use hosted pairing when the backend is reachable from the browser over HTTPS/WSS. This includes a backend behind a trusted HTTPS tunnel or another HTTPS endpoint you operate.

Do not use hosted pairing for plain HTTP LAN URLs such as `http://192.168.x.y:3773`. Browsers block an HTTPS page from connecting to an insecure HTTP or WS backend. For those endpoints, use the direct pairing URL shown by the desktop app or CLI from a client that can open that HTTP URL directly.

Hosted pairing does not proxy traffic through T4Code. The browser still connects directly to the backend URL in the pairing link.

## Managing Access Later

Use `t4code auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `t4code auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `t4code auth` to revoke credentials or sessions you no longer trust.
