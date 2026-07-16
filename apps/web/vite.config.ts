/*
 * tanstackRouter({ autoCodeSplitting: true,
 * chunkSizeWarningLimit: 1536,
 * const buildSourcemap: sourcemapEnv === "hidden" ? "hidden" : sourcemapEnv === "1" || sourcemapEnv === "true";
 */
// @ts-expect-error -- The shim intentionally re-exports an instrumentable .mjs implementation module.
export { default } from "./vite.config.app.mjs";
