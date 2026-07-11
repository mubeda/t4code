import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const TauriConfiguration = Schema.fromJsonString(
  Schema.Struct({
    build: Schema.Struct({ beforeBuildCommand: Schema.String }),
    app: Schema.Struct({
      withGlobalTauri: Schema.Boolean,
      security: Schema.Struct({
        csp: Schema.NullOr(Schema.String),
        devCsp: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
    bundle: Schema.Struct({
      resources: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  }),
);
const CapabilityConfiguration = Schema.fromJsonString(
  Schema.Struct({ permissions: Schema.Array(Schema.String) }),
);
const decodeTauriConfiguration = Schema.decodeUnknownEffect(TauriConfiguration);
const decodeCapabilityConfiguration = Schema.decodeUnknownEffect(CapabilityConfiguration);

it.layer(NodeServices.layer)("Tauri production hardening", (it) => {
  it.effect("restricts the main WebView and disables production source maps by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const capability = yield* decodeCapabilityConfiguration(
        yield* fs.readFileString(
          path.join(repoRoot, "apps/desktop/src-tauri/capabilities/default.json"),
        ),
      );
      const viteConfig = yield* fs.readFileString(path.join(repoRoot, "apps/web/vite.config.ts"));
      const rootPackage = yield* fs.readFileString(path.join(repoRoot, "package.json"));
      const workspace = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
      const desktopPackage = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/package.json"),
      );

      for (const obsoletePath of [
        "apps/server-rust",
        "apps/desktop-tauri",
        "packages/effect-acp",
        "packages/effect-codex-app-server",
        "packages/native-command-runner",
        "packages/native-process-diagnostics",
        "packages/ssh",
        "packages/tailscale",
        "scripts/prepare-tauri-node-runtime.ts",
      ]) {
        assert.equal(
          yield* fs.exists(path.join(repoRoot, obsoletePath)),
          false,
          `${obsoletePath} must be absent`,
        );
      }

      assert.equal(tauri.app.withGlobalTauri, false);
      assert.equal(
        /prepare-tauri-node-runtime|server\//.test(tauri.build.beforeBuildCommand),
        false,
      );
      assert.equal(tauri.bundle.resources, undefined);
      assert.notEqual(tauri.app.security.csp, null);
      assert.match(tauri.app.security.csp ?? "", /default-src 'self'/);
      assert.match(tauri.app.security.csp ?? "", /object-src 'none'/);
      assert.match(tauri.app.security.csp ?? "", /frame-ancestors 'none'/);
      assert.notEqual(tauri.app.security.devCsp, null);
      assert.deepEqual(capability.permissions, ["allow-desktop-bridge", "core:default"]);
      assert.match(viteConfig, /tanstackRouter\(\{[\s\S]*?autoCodeSplitting: true,/);
      assert.match(viteConfig, /chunkSizeWarningLimit: 1536,/);
      assert.match(
        viteConfig,
        /const buildSourcemap:[\s\S]*?sourcemapEnv === "hidden"[\s\S]*?sourcemapEnv === "true";/,
      );
      assert.equal(/electron|electron-builder|@clerk\/electron/i.test(rootPackage), false);
      assert.equal(
        /effect-acp|effect-codex-app-server|node-pty|ffi-rs|fff-node/i.test(workspace),
        false,
      );
      assert.equal(
        /resources\/node|server-node_modules|dist\/bin\.mjs/i.test(desktopPackage),
        false,
      );
    }),
  );
});
