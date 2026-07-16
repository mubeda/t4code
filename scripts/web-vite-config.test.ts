import { describe, expect, it } from "vite-plus/test";

// @ts-expect-error -- The instrumentable web config intentionally lives in an .mjs module.
import webConfigFactory from "../apps/web/vite.config.app.mjs";
import webPackage from "../apps/web/package.json" with { type: "json" };

const packageRoot = (dependency: string): string => {
  const segments = dependency.split("/");
  return dependency.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? dependency);
};

describe("web Vite configuration", () => {
  it("only pre-bundles dependencies declared by the web workspace", () => {
    const config = webConfigFactory();
    const dependencies: ReadonlyArray<string> = config.optimizeDeps?.include ?? [];
    const declared = new Set([
      ...Object.keys(webPackage.dependencies),
      ...Object.keys(webPackage.devDependencies),
    ]);
    const undeclared = dependencies.filter((dependency) => !declared.has(packageRoot(dependency)));

    expect(undeclared).toEqual([]);
  });
});
