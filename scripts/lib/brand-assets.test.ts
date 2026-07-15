import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
  WEB_ASSET_CHANNELS,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("publishes every desktop and web asset path as a literal repository contract", () => {
    expect(BRAND_ASSET_PATHS).toEqual({
      productionMacIconPng: "assets/prod/black-macos-1024.png",
      productionLinuxIconPng: "assets/prod/black-universal-1024.png",
      productionWindowsIconIco: "assets/prod/t4-black-windows.ico",
      productionWebFaviconIco: "assets/prod/t4-black-web-favicon.ico",
      productionWebFavicon16Png: "assets/prod/t4-black-web-favicon-16x16.png",
      productionWebFavicon32Png: "assets/prod/t4-black-web-favicon-32x32.png",
      productionWebAppleTouchIconPng: "assets/prod/t4-black-web-apple-touch-180.png",
      nightlyMacIconPng: "assets/nightly/blueprint-macos-1024.png",
      nightlyLinuxIconPng: "assets/nightly/blueprint-universal-1024.png",
      nightlyWindowsIconIco: "assets/nightly/blueprint-windows.ico",
      nightlyWebFaviconIco: "assets/nightly/blueprint-web-favicon.ico",
      nightlyWebFavicon16Png: "assets/nightly/blueprint-web-favicon-16x16.png",
      nightlyWebFavicon32Png: "assets/nightly/blueprint-web-favicon-32x32.png",
      nightlyWebAppleTouchIconPng: "assets/nightly/blueprint-web-apple-touch-180.png",
      developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
      developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
      developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
      developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
      developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
      developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
    });
  });

  it("maps every development web icon into the packaged client directory", () => {
    const expected = [
      {
        sourceRelativePath: "assets/dev/blueprint-web-favicon.ico",
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: "assets/dev/blueprint-web-favicon-16x16.png",
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: "assets/dev/blueprint-web-favicon-32x32.png",
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: "assets/dev/blueprint-web-apple-touch-180.png",
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ];

    expect(DEVELOPMENT_ICON_OVERRIDES).toEqual(expected);
    expect(resolveWebIconOverrides("development", "dist/client")).toEqual(expected);
  });

  it("maps every stable web icon into the hosted client directory", () => {
    const expected = [
      {
        sourceRelativePath: "assets/prod/t4-black-web-favicon.ico",
        targetRelativePath: "apps/web/dist/favicon.ico",
      },
      {
        sourceRelativePath: "assets/prod/t4-black-web-favicon-16x16.png",
        targetRelativePath: "apps/web/dist/favicon-16x16.png",
      },
      {
        sourceRelativePath: "assets/prod/t4-black-web-favicon-32x32.png",
        targetRelativePath: "apps/web/dist/favicon-32x32.png",
      },
      {
        sourceRelativePath: "assets/prod/t4-black-web-apple-touch-180.png",
        targetRelativePath: "apps/web/dist/apple-touch-icon.png",
      },
    ];

    expect(resolveWebIconOverrides("production", "apps/web/dist")).toEqual(expected);
    expect(PUBLISH_ICON_OVERRIDES).toEqual(
      expected.map((override) => ({
        ...override,
        targetRelativePath: override.targetRelativePath.replace("apps/web/dist", "dist/client"),
      })),
    );
  });

  it("maps every nightly web icon into the hosted client directory", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toEqual([
      {
        sourceRelativePath: "assets/nightly/blueprint-web-favicon.ico",
        targetRelativePath: "apps/web/dist/favicon.ico",
      },
      {
        sourceRelativePath: "assets/nightly/blueprint-web-favicon-16x16.png",
        targetRelativePath: "apps/web/dist/favicon-16x16.png",
      },
      {
        sourceRelativePath: "assets/nightly/blueprint-web-favicon-32x32.png",
        targetRelativePath: "apps/web/dist/favicon-32x32.png",
      },
      {
        sourceRelativePath: "assets/nightly/blueprint-web-apple-touch-180.png",
        targetRelativePath: "apps/web/dist/apple-touch-icon.png",
      },
    ]);
  });

  it("maps only the supported release channels and rejects unsupported runtime input", () => {
    expect(WEB_ASSET_CHANNELS).toEqual(["latest", "nightly"]);
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
    expect(() => resolveWebAssetBrandForChannel("beta" as never)).toThrowError(
      "Unsupported web asset channel: beta",
    );
  });
});
