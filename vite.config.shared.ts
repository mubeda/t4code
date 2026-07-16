import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export const coverageInclude = [
  "vite.config.shared.ts",
  "apps/marketing/astro.config.mjs",
  "apps/marketing/src/**/*.ts",
  "apps/marketing/vercel.ts",
  "apps/web/src/**/*.{ts,tsx}",
  "apps/web/vercel.ts",
  "apps/web/vite.config.app.mjs",
  "infra/relay/alchemy.run.ts",
  "infra/relay/scripts/**/*.ts",
  "infra/relay/src/**/*.ts",
  "oxlint-plugin-t4code/**/*.ts",
  "packages/client-runtime/scripts/**/*.ts",
  "packages/client-runtime/src/**/*.ts",
  "packages/client-runtime/vite.config.runtime.ts",
  "packages/contracts/scripts/**/*.ts",
  "packages/contracts/src/**/*.ts",
  "packages/shared/src/**/*.ts",
  "scripts/**/*.mjs",
  "scripts/**/*.ts",
] as const;

export const coverageExclude = [
  "**/*.d.ts",
  "**/*.spec.{ts,tsx,js,mjs}",
  "**/*.test.{ts,tsx,js,mjs}",
  "**/test/**",
  "**/__tests__/**",
  "**/vite.config.ts",
  "**/.repos/**",
  "**/.vite-plus/**",
  "**/coverage/**",
  "**/.vitest-coverage*/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/target/**",
  "**/.{idea,git,cache,output,temp}/**",
  "apps/web/public/mockServiceWorker.js",
  "apps/web/src/lib/vendor/qrcodegen.ts",
  "apps/web/src/routeTree.gen.ts",
] as const;

export const coverageProbeEntrypoints = [
  "vite.config.shared.ts",
  "apps/web/vite.config.app.mjs",
  "packages/client-runtime/vite.config.runtime.ts",
] as const;

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    coverage: {
      provider: "v8",
      include: coverageInclude,
      exclude: coverageExclude,
      thresholds: {
        lines: 74,
        statements: 74,
        functions: 74,
        branches: 74,
      },
    },
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".plans",
      ".alchemy",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t4code/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t4code/client-runtime",
              message:
                "Import from an explicit @t4code/client-runtime/* subpath. The package has no root export.",
            },
          ],
        },
      ],
      "t4code/no-global-process-runtime": "error",
      "t4code/no-inline-schema-compile": "warn",
      "t4code/no-manual-effect-runtime-in-tests": "error",
      "t4code/namespace-node-imports": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
