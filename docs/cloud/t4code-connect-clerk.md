# T4 Connect Clerk Setup

T4 Connect uses one Clerk application for web and desktop authentication. The relay accepts
Clerk JWTs only when they are generated from the `t4code-relay` template with the shared
`t4code-relay` audience.

## Application Keys

T4 Connect is disabled in a fresh clone. To enable it for source builds, add a repository-root `.env`
or `.env.local` file:

```dotenv
T4CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T4CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T4CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T4CODE_RELAY_URL=https://relay.example.com
```

The shared client loader projects these canonical values into framework-specific `VITE_*` aliases.
Existing aliases remain accepted as overrides for compatibility, but new client configuration should
use the canonical names.

Configuration precedence is:

1. Process or CI environment variables.
2. Repository-root `.env.local`.
3. Repository-root `.env`.

The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL are public
identifiers, not secrets.
Web and desktop builds statically inject the public values they consume during
their build step. The native server reads operator overrides from its process
environment. A built desktop artifact does not need an environment file at runtime. CI release builds
should set `T4CODE_CLERK_PUBLISHABLE_KEY`, `T4CODE_CLERK_JWT_TEMPLATE`,
`T4CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T4CODE_RELAY_URL` before building.

When any client-facing public value is absent, cloud UI is omitted. When the CLI public values are
absent, the `t4code connect` CLI command group is omitted. The native server accepts runtime
overrides for self-hosted or operator-managed
deployments.

For a hosted relay deployment, copy `infra/relay/.env.example` to `infra/relay/.env`. The relay
deployment reads `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_AUDIENCE` through Effect `Config`. There are no checked-in
deployment defaults.
`vp run --filter t4code-relay deploy` invokes Alchemy from the relay directory, so Alchemy loads
`infra/relay/.env`. After a successful deployment, the wrapper updates the repository-root `.env`
with the deployed HTTPS relay URL. The relay still requires
`CLERK_SECRET_KEY` as an Alchemy secret. Never put `CLERK_SECRET_KEY` in a client application
environment or commit it to the repository.

The `prod` Alchemy stage owns the retained PlanetScale database. Non-production stages reference
that database and provision isolated PlanetScale branches, so deploy `prod` before creating a
personal developer stage.

## Headless CLI OAuth Application

The `t4code connect` commands authorize a headless environment with a separate Clerk OAuth application.
This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create an OAuth application for the T4 CLI.
2. Enable the **Public** option so authorization-code exchange uses PKCE.
3. Add `http://127.0.0.1:34338/callback` as an allowed redirect URI.
4. Enable the `openid`, `profile`, and `email` scopes.
5. Set `T4CODE_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

The CLI derives Clerk's frontend API URL from the publishable key and calls Clerk's
`/oauth/authorize` and `/oauth/token` endpoints directly. The relay is not involved in the OAuth
handshake; it only validates the issued Clerk bearer token when the CLI manages an environment link.

The CLI supports these headless operations:

```sh
t4code connect login
t4code connect link
t4code connect status
t4code connect unlink
t4code connect logout
t4code serve
```

`t4code connect login` opens the Clerk authorization flow and stores the CLI credential without enabling
cloud exposure. `t4code connect link` installs the pinned managed `cloudflared` binary when needed,
authorizes when needed, and records durable intent to expose the environment. It works without a
running T4 server. The next `t4code serve` or `t4code start` reconciles the relay link and launches the
managed tunnel. `t4code connect unlink` records disabled intent immediately, stops a reachable running
connector, and attempts to revoke the relay-side environment record. It retains the stored CLI
authorization so `t4code connect link` can re-enable exposure without another browser flow. `t4code connect
logout` performs the same cleanup and removes the stored CLI authorization.

The current OAuth callback listener binds to loopback port `34338`. When running the CLI over SSH,
forward that port before running `t4code connect login` or `t4code connect link`:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

A relay-hosted callback broker can remove this port-forward requirement later without changing the
stored PKCE token model.

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                       |
| ------- | --------------------------- |
| Name    | `t4code-relay`              |
| Claims  | `{ "aud": "t4code-relay" }` |

Set `T4CODE_CLERK_JWT_TEMPLATE=t4code-relay` in the repository-root `.env`, and set
`CLERK_JWT_AUDIENCE=t4code-relay` in `infra/relay/.env`. Define `CLERK_JWT_TEMPLATE` and
`CLERK_JWT_AUDIENCE` in the production relay deployment environment as well. The stable `aud` value
is shared by production and non-production relay stages. The client-facing `T4CODE_RELAY_URL` still
selects the concrete relay deployment, but changing that URL does not require a JWT template change.

## Desktop Authentication

The Tauri desktop loads the same React application and `@clerk/react` provider
as the browser build. Include the public Clerk and relay variables at build
time to enable T4 Connect in either host. The desktop does not use
`@clerk/electron`, an Electron request adapter, or Electron token storage.

The current implementation supports Clerk flows that work inside the
operating-system WebView. A native external-browser OAuth callback flow and
native desktop passkeys are not implemented. Do not configure custom
`t4code://` redirects or claim native passkey support until a Tauri-specific
transport, secure token store, platform entitlements, and end-to-end tests have
been added.

The production desktop identifier is `com.t4code.app`. It is relevant to
future code signing and native entitlement work, but it does not by itself
enable Clerk native authentication.

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment
file, or a build artifact.

## Enable Waitlist Access

For a private beta where people should request access, use **Clerk Dashboard > Waitlist**:

1. Toggle on **Enable waitlist** and save.
2. Review requests on the same page and select **Invite** or **Deny**.

Approved signed-in users manage T4 Connect under **Connections**. The web and desktop sidebars do
not expose a dedicated account or waitlist control. Signed-out users reach Clerk's waitlist and
sign-in flow contextually from the T4 Connect controls on the Connections page.

## Alternative: Known-User Allowlist

For a closed beta where all permitted users are known in advance, use an allowlist instead of a
request-and-approval waitlist:

To restrict the beta to permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created without a waitlist request flow.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.
