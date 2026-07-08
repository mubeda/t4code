# Remove Mobile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove native mobile app support and mobile-only relay/device infrastructure from T4Code.

**Architecture:** Keep the web, desktop, server, relay, and shared client runtime. Remove Expo/React Native app code, mobile-only package manager entries, mobile CI, mobile APNS/live-activity relay endpoints, and web settings/profile UI that lists mobile clients.

**Tech Stack:** TypeScript, React, Effect, Vite+, pnpm workspace, Cloudflare relay.

## Global Constraints

- Do not remove responsive web viewport behavior named `mobile`; it is browser layout support, not the native mobile product.
- Keep `packages/client-runtime` because web, desktop, and relay consume it.
- Remove mobile-only Expo, React Native, APNS, Live Activity, and mobile-device registration surfaces.
- Required final validation: `vp check`, `vp run typecheck`, `vp run test`, and a local build command.

---

### Task 1: Remove Native Mobile App And Tooling

**Files:**

- Delete: `apps/mobile/`
- Delete: `.github/workflows/mobile-eas-preview.yml`
- Delete: `scripts/mobile-native-static-check.ts`
- Delete: `scripts/mobile-native-static-check.test.ts`
- Delete: `patches/@expo%2Fmetro-config@56.0.13.patch`
- Delete: `patches/react-native-nitro-modules@0.35.9.patch`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `vite.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/release-smoke.ts`

**Interfaces:**

- Produces: a workspace with no `@t3tools/mobile` package and no `lint:mobile` script.

- [x] **Step 1: Delete mobile app and native static-analysis script**

Remove the native app tree and the mobile-only lint script files.

- [x] **Step 2: Remove root workspace hooks**

Remove `lint:mobile`, mobile CI jobs/workflows, Vite ignore entries for `apps/mobile`, mobile release-smoke manifest fixtures, and mobile-only catalog/patch entries.

- [x] **Step 3: Regenerate lockfile**

Run:

```bash
vp install --lockfile-only --ignore-scripts
```

Expected: `pnpm-lock.yaml` no longer has an `apps/mobile` importer or Expo/React Native-only lock entries.

### Task 2: Remove Mobile Relay/API Support

**Files:**

- Modify: `packages/contracts/src/relay.ts`
- Modify: `packages/client-runtime/src/relay/managedRelay.ts`
- Modify: `packages/client-runtime/src/relay/managedRelayState.ts`
- Modify: `packages/client-runtime/src/relay/managedRelay.test.ts`
- Modify: `packages/client-runtime/src/connection/resolver.ts`
- Modify: `packages/client-runtime/src/platform/capabilities.ts`
- Modify: `infra/relay/src/http/Api.ts`
- Modify: `infra/relay/src/worker.ts`
- Modify: `infra/relay/src/Config.ts`
- Modify: `infra/relay/src/persistence/schema.ts`
- Delete: `infra/relay/src/queues.ts`
- Delete mobile/APNS-only files under `infra/relay/src/agentActivity/`.

**Interfaces:**

- Produces: relay API without `/v1/mobile/*`, `/v1/client/devices`, APNS queues, mobile client id, or `mobile:registration` scope.

- [x] **Step 1: Simplify relay contracts**

Remove mobile schemas, `RelayMobileGroup`, device-list endpoint, mobile registration scope, mobile client id, APNS delivery result shape, and mobile-specific link options.

- [x] **Step 2: Simplify client runtime relay client**

Remove `listDevices`, `registerDevice`, `unregisterDevice`, `registerLiveActivity`, mobile DPoP request helper, and `RelayDeviceIdentity` usage.

- [x] **Step 3: Simplify relay implementation**

Remove APNS credentials/config, queue subscription, mobile API group, device-list handler, APNS error mapping, APNS/live-activity layers, and mobile tables from schema.

### Task 3: Remove Mobile Web UI And Config

**Files:**

- Modify: `apps/web/src/components/clerk/T3ConnectSidebarSignIn.tsx`
- Delete: `apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx`
- Delete: `apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.ts`
- Delete: `apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.test.ts`
- Modify: `apps/web/src/cloud/managedRelayState.ts`
- Modify: `apps/web/src/cloud/linkEnvironment.ts`
- Modify: `scripts/lib/public-config.ts`
- Modify: `scripts/lib/public-config.test.ts`

**Interfaces:**

- Produces: no settings/profile page or environment preference that claims mobile push delivery.

- [x] **Step 1: Remove mobile clients profile page**

Delete the profile page and remove the custom Clerk `UserProfilePage` registration.

- [x] **Step 2: Remove mobile/public config aliases**

Remove Expo public config aliases and mobile OTLP config fields/tests.

### Task 4: Documentation Cleanup

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/reference/workspace-layout.md`
- Modify: `packages/client-runtime/README.md`
- Modify docs under `docs/architecture/`, `docs/cloud/`, and `docs/operations/` with mobile/APNS references.

**Interfaces:**

- Produces: docs that describe web/desktop/relay support only.

- [x] **Step 1: Remove mobile package role and lint requirement**

Update repository docs so task completion no longer mentions `lint:mobile`.

- [x] **Step 2: Remove APNS and mobile setup documentation**

Remove APNS secrets, Expo/Clerk mobile setup, mobile auth flow endpoints, and native mobile architecture references.

### Task 5: Verify

**Files:**

- No source edits expected unless validation reveals misses.

**Interfaces:**

- Produces: local proof the simplified repo still works.

- [x] **Step 1: Search for remaining native mobile support**

Run:

```bash
rg -n "apps/mobile|@t3tools/mobile|react-native|expo|eas|APNS|Apns|mobile:registration|/v1/mobile|Mobile clients|Live Activities|push notifications" -g "!node_modules/**" -g "!.repos/**"
```

Expected: no product-support references except responsive web wording and historical plan docs.

- [x] **Step 2: Run required checks**

Run:

```bash
vp check
vp run typecheck
vp run test
vp run build
```

Expected: all commands pass after fixing any compile/test failures.

Verified locally:

- `vp check`
- `vp run typecheck`
- `vp test`
- `vp run test`
- `vp run build`
- `vp run release:smoke`
