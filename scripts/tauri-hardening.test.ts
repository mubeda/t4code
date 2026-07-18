import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const TauriConfiguration = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.String,
    build: Schema.Struct({ beforeBuildCommand: Schema.String }),
    app: Schema.Struct({
      withGlobalTauri: Schema.Boolean,
      security: Schema.Struct({
        csp: Schema.NullOr(Schema.String),
        devCsp: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
    bundle: Schema.Struct({
      icon: Schema.Array(Schema.String),
      macOS: Schema.Struct({ minimumSystemVersion: Schema.String }),
      resources: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  }),
);
const CapabilityConfiguration = Schema.fromJsonString(
  Schema.Struct({ permissions: Schema.Array(Schema.String) }),
);
const DesktopPackageConfiguration = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Struct({ build: Schema.String }) }),
);
const decodeTauriConfiguration = Schema.decodeUnknownEffect(TauriConfiguration);
const decodeCapabilityConfiguration = Schema.decodeUnknownEffect(CapabilityConfiguration);
const decodeDesktopPackageConfiguration = Schema.decodeUnknownEffect(DesktopPackageConfiguration);

it.layer(NodeServices.layer)("Tauri production hardening", (it) => {
  it.effect("bundles only canonical black desktop icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const expectedIcons = [
        "../../../assets/prod/black-universal-1024.png",
        "../../../assets/prod/t4-black-windows.ico",
        "../../../assets/prod/t4-black-macos.icns",
      ];

      assert.deepEqual(tauri.bundle.icon, expectedIcons);
      assert.equal(tauri.bundle.macOS.minimumSystemVersion, "11.0");
      for (const iconPath of [
        "assets/prod/black-universal-1024.png",
        "assets/prod/t4-black-windows.ico",
        "assets/prod/t4-black-macos.icns",
      ]) {
        assert.equal(yield* fs.exists(path.join(repoRoot, iconPath)), true, iconPath);
      }
      assert.equal(yield* fs.exists(path.join(repoRoot, "apps/desktop/resources")), false);
    }),
  );

  it.effect("applies the production black web icons before bundling the desktop app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );

      assert.match(
        tauri.build.beforeBuildCommand,
        /apply-web-brand-assets\.ts production apps\/web\/dist/,
      );
      assert.equal(
        yield* fs.exists(path.join(repoRoot, "assets/prod/t4-black-web-apple-touch-180.png")),
        true,
      );
    }),
  );

  it.effect("keeps only canonical black product-icon assets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      for (const legacyPath of ["assets/dev", "assets/nightly"]) {
        assert.equal(
          yield* fs.exists(path.join(repoRoot, legacyPath)),
          false,
          `${legacyPath} must be absent`,
        );
      }

      const publicCopies = [
        [
          "assets/prod/t4-black-web-favicon.ico",
          "apps/web/public/favicon.ico",
          "apps/marketing/public/favicon.ico",
        ],
        [
          "assets/prod/t4-black-web-favicon-16x16.png",
          "apps/web/public/favicon-16x16.png",
          "apps/marketing/public/favicon-16x16.png",
        ],
        [
          "assets/prod/t4-black-web-favicon-32x32.png",
          "apps/web/public/favicon-32x32.png",
          "apps/marketing/public/favicon-32x32.png",
        ],
        [
          "assets/prod/t4-black-web-apple-touch-180.png",
          "apps/web/public/apple-touch-icon.png",
          "apps/marketing/public/apple-touch-icon.png",
        ],
      ] as const;

      for (const [sourcePath, ...copyPaths] of publicCopies) {
        const source = yield* fs.readFile(path.join(repoRoot, sourcePath));
        for (const copyPath of copyPaths) {
          assert.deepEqual(
            yield* fs.readFile(path.join(repoRoot, copyPath)),
            source,
            `${copyPath} must match ${sourcePath}`,
          );
        }
      }
    }),
  );

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
      const desktopLib = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/src-tauri/src/lib.rs"),
      );
      const relayTracing = yield* fs.readFileString(
        path.join(repoRoot, "packages/shared/src/relayTracing.ts"),
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
      assert.notMatch(tauri.identifier, /\.app$/i);
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
      const desktopPackageJson = yield* decodeDesktopPackageConfiguration(desktopPackage);
      assert.match(desktopPackageJson.scripts.build, /pnpm exec tauri build$/);
      assert.notMatch(desktopPackage, /pnpm dlx/);
      assert.notMatch(desktopLib, /if\s*!cfg!\(debug_assertions\)[\s\S]*?backend\.start_default/);
      assert.match(desktopLib, /backend\.start_default\(app_handle\)\.await/);
      assert.notMatch(relayTracing, /from "\.\/observability\.ts"/);
    }),
  );
});
