# Black Icon Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every blue T4Code product icon and make the existing black-background, white-`T4` artwork the only icon used by development, nightly, production, web, desktop, and installers.

**Architecture:** `assets/prod` becomes the only authoritative icon family. Release-channel inputs remain compatible, but the shared brand resolver maps every channel to the same production web assets; Vite public files are verified black copies, and Tauri references production PNG/ICO/ICNS files directly.

**Tech Stack:** TypeScript, Vite+, Effect Vitest, Tauri 2, macOS `sips` and `iconutil`, PNG/ICO/ICNS assets.

## Global Constraints

- Use the existing unbadged black-background, white-`T4` artwork without redesigning it.
- Delete all blue T4Code product-icon outputs and source material under `assets/dev`, `assets/nightly`, `apps/desktop/resources`, and the blue contents currently stored in `apps/web/public`.
- Keep development and nightly channel names and release behavior.
- Keep generic web public filenames required by browser metadata and the splash/boot UI.
- Do not modify third-party icons, file-type icons, screenshots, diagnostics, application names, bundle identifiers, or release metadata.
- Preserve the unrelated working-tree modification in `apps/desktop/src-tauri/src/bridge.rs`; never stage it in icon commits.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Structure

- `scripts/lib/brand-assets.ts`: the canonical icon path contract and channel-independent web override resolver.
- `scripts/lib/brand-assets.test.ts`: unit contract for canonical paths and identical channel resolution.
- `scripts/apply-web-brand-assets.test.ts`: integration coverage proving the copy command resolves development through `assets/prod`.
- `scripts/tauri-hardening.test.ts`: repository-level native configuration, legacy-path absence, and public-copy byte invariants.
- `apps/desktop/src-tauri/tauri.conf.json`: cross-platform Tauri bundle icon references.
- `assets/prod/t4-black-macos.icns`: deterministic macOS bundle derivative generated from `assets/prod/black-macos-1024.png`.
- `apps/web/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png}`: required black public copies.
- `assets/dev/**`, `assets/nightly/**`, and `apps/desktop/resources/**`: deleted legacy blue families.

### Task 1: Collapse Brand Resolution onto the Production Icon Family

**Files:**
- Modify: `scripts/lib/brand-assets.test.ts`
- Modify: `scripts/apply-web-brand-assets.test.ts`
- Modify: `scripts/lib/brand-assets.ts`

**Interfaces:**
- Consumes: existing `WebAssetBrand`, `WebAssetChannel`, and `IconOverride` public types.
- Produces: `BRAND_ASSET_PATHS` with canonical desktop/web keys and `resolveWebIconOverrides(brand, targetDirectory)` returning production sources for every valid brand.

- [ ] **Step 1: Write the failing brand-contract tests**

Replace the asset-contract assertion and the three brand-specific mapping tests in
`scripts/lib/brand-assets.test.ts` with:

```typescript
it("publishes the canonical black desktop and web asset paths", () => {
  expect(BRAND_ASSET_PATHS).toEqual({
    macIconPng: "assets/prod/black-macos-1024.png",
    linuxIconPng: "assets/prod/black-universal-1024.png",
    macIconIcns: "assets/prod/t4-black-macos.icns",
    windowsIconIco: "assets/prod/t4-black-windows.ico",
    webFaviconIco: "assets/prod/t4-black-web-favicon.ico",
    webFavicon16Png: "assets/prod/t4-black-web-favicon-16x16.png",
    webFavicon32Png: "assets/prod/t4-black-web-favicon-32x32.png",
    webAppleTouchIconPng: "assets/prod/t4-black-web-apple-touch-180.png",
  });
});

it("maps every brand to the canonical black web icons", () => {
  const expected = [
    {
      sourceRelativePath: "assets/prod/t4-black-web-favicon.ico",
      targetRelativePath: "dist/client/favicon.ico",
    },
    {
      sourceRelativePath: "assets/prod/t4-black-web-favicon-16x16.png",
      targetRelativePath: "dist/client/favicon-16x16.png",
    },
    {
      sourceRelativePath: "assets/prod/t4-black-web-favicon-32x32.png",
      targetRelativePath: "dist/client/favicon-32x32.png",
    },
    {
      sourceRelativePath: "assets/prod/t4-black-web-apple-touch-180.png",
      targetRelativePath: "dist/client/apple-touch-icon.png",
    },
  ];

  for (const brand of ["development", "nightly", "production"] as const) {
    expect(resolveWebIconOverrides(brand, "dist/client")).toEqual(expected);
  }
  expect(DEVELOPMENT_ICON_OVERRIDES).toEqual(expected);
  expect(PUBLISH_ICON_OVERRIDES).toEqual(expected);
});
```

In `scripts/apply-web-brand-assets.test.ts`, change the repository-root assertion
to require the canonical source:

```typescript
assert.match(copies[0]![0], /[\\/]assets[\\/]prod[\\/]/);
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
./node_modules/.bin/vp test run scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts
```

Expected: FAIL because `BRAND_ASSET_PATHS` still contains development/nightly
paths and the development resolver still returns `assets/dev`.

- [ ] **Step 3: Implement the canonical path contract**

Replace the channel-specific asset constants and map in
`scripts/lib/brand-assets.ts` with:

```typescript
export const BRAND_ASSET_PATHS = {
  macIconPng: "assets/prod/black-macos-1024.png",
  linuxIconPng: "assets/prod/black-universal-1024.png",
  macIconIcns: "assets/prod/t4-black-macos.icns",
  windowsIconIco: "assets/prod/t4-black-windows.ico",
  webFaviconIco: "assets/prod/t4-black-web-favicon.ico",
  webFavicon16Png: "assets/prod/t4-black-web-favicon-16x16.png",
  webFavicon32Png: "assets/prod/t4-black-web-favicon-32x32.png",
  webAppleTouchIconPng: "assets/prod/t4-black-web-apple-touch-180.png",
} as const;

const WEB_ICON_SOURCE_PATHS = {
  faviconIco: BRAND_ASSET_PATHS.webFaviconIco,
  favicon16Png: BRAND_ASSET_PATHS.webFavicon16Png,
  favicon32Png: BRAND_ASSET_PATHS.webFavicon32Png,
  appleTouchIconPng: BRAND_ASSET_PATHS.webAppleTouchIconPng,
} as const satisfies Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>;

export function resolveWebIconOverrides(
  _brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  return [
    {
      sourceRelativePath: WEB_ICON_SOURCE_PATHS.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: WEB_ICON_SOURCE_PATHS.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: WEB_ICON_SOURCE_PATHS.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: WEB_ICON_SOURCE_PATHS.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}
```

Keep `WebAssetBrand`, `WEB_ASSET_CHANNELS`,
`resolveWebAssetBrandForChannel`, `DEVELOPMENT_ICON_OVERRIDES`, and
`PUBLISH_ICON_OVERRIDES` unchanged so command-line and release-channel behavior
remains compatible.

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vp test run scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts
```

Expected: PASS with every development/nightly/production copy source under
`assets/prod`.

- [ ] **Step 5: Commit the brand resolver**

```bash
git add scripts/lib/brand-assets.ts scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts
git commit -m "refactor: unify app icon branding"
```

### Task 2: Point Native Bundles at Black Production Assets

**Files:**
- Modify: `scripts/tauri-hardening.test.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `assets/prod/t4-black-macos.icns`
- Delete: `apps/desktop/resources/icon.png`
- Delete: `apps/desktop/resources/icon.ico`
- Delete: `apps/desktop/resources/icon.icns`

**Interfaces:**
- Consumes: `assets/prod/black-macos-1024.png`,
  `assets/prod/black-universal-1024.png`, and
  `assets/prod/t4-black-windows.ico`.
- Produces: Tauri `bundle.icon` containing only black production paths and a
  valid macOS ICNS at `assets/prod/t4-black-macos.icns`.

- [ ] **Step 1: Write the failing native-bundle test**

Replace the first test in `scripts/tauri-hardening.test.ts` with:

```typescript
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
./node_modules/.bin/vp test run scripts/tauri-hardening.test.ts
```

Expected: FAIL because Tauri references the blue desktop PNG/ICNS, the black ICNS
does not exist, and `apps/desktop/resources` still exists.

- [ ] **Step 3: Generate the deterministic black macOS ICNS**

Run:

```bash
icon_root=$(mktemp -d /tmp/t4code-black-icon.XXXXXX)
iconset="$icon_root/t4-black-macos.iconset"
mkdir -p "$iconset"
sips -z 16 16 assets/prod/black-macos-1024.png --out "$iconset/icon_16x16.png"
sips -z 32 32 assets/prod/black-macos-1024.png --out "$iconset/icon_16x16@2x.png"
sips -z 32 32 assets/prod/black-macos-1024.png --out "$iconset/icon_32x32.png"
sips -z 64 64 assets/prod/black-macos-1024.png --out "$iconset/icon_32x32@2x.png"
sips -z 128 128 assets/prod/black-macos-1024.png --out "$iconset/icon_128x128.png"
sips -z 256 256 assets/prod/black-macos-1024.png --out "$iconset/icon_128x128@2x.png"
sips -z 256 256 assets/prod/black-macos-1024.png --out "$iconset/icon_256x256.png"
sips -z 512 512 assets/prod/black-macos-1024.png --out "$iconset/icon_256x256@2x.png"
sips -z 512 512 assets/prod/black-macos-1024.png --out "$iconset/icon_512x512.png"
cp assets/prod/black-macos-1024.png "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o assets/prod/t4-black-macos.icns
file assets/prod/t4-black-macos.icns
```

Expected: `assets/prod/t4-black-macos.icns: Mac OS X icon`.

- [ ] **Step 4: Update Tauri and delete blue desktop resources**

Set `bundle.icon` in `apps/desktop/src-tauri/tauri.conf.json` to:

```json
[
  "../../../assets/prod/black-universal-1024.png",
  "../../../assets/prod/t4-black-windows.ico",
  "../../../assets/prod/t4-black-macos.icns"
]
```

Delete the three tracked blue resources:

```bash
git rm apps/desktop/resources/icon.png apps/desktop/resources/icon.ico apps/desktop/resources/icon.icns
```

- [ ] **Step 5: Run the test and verify GREEN**

Run:

```bash
./node_modules/.bin/vp test run scripts/tauri-hardening.test.ts
```

Expected: PASS; every configured native icon exists under `assets/prod`, and the
legacy desktop resource directory is absent.

- [ ] **Step 6: Commit native icon packaging**

```bash
git add scripts/tauri-hardening.test.ts apps/desktop/src-tauri/tauri.conf.json assets/prod/t4-black-macos.icns
git commit -m "fix: package black desktop icons"
```

### Task 3: Delete Blue Families and Enforce Black Public Copies

**Files:**
- Modify: `scripts/tauri-hardening.test.ts`
- Replace: `apps/web/public/favicon.ico`
- Replace: `apps/web/public/favicon-16x16.png`
- Replace: `apps/web/public/favicon-32x32.png`
- Replace: `apps/web/public/apple-touch-icon.png`
- Delete: `assets/dev/**`
- Delete: `assets/nightly/**`

**Interfaces:**
- Consumes: canonical black web assets in `assets/prod`.
- Produces: byte-identical black Vite public icons and a repository with no
  legacy development/nightly blue icon directories.

- [ ] **Step 1: Write the failing repository-invariant test**

Add this test inside the existing `Tauri production hardening` layer in
`scripts/tauri-hardening.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
./node_modules/.bin/vp test run scripts/tauri-hardening.test.ts
```

Expected: FAIL because `assets/dev` and `assets/nightly` exist and the checked-in
web public icons contain the blue nightly artwork.

- [ ] **Step 3: Replace public icons and delete blue source families**

Run:

```bash
cp assets/prod/t4-black-web-favicon.ico apps/web/public/favicon.ico
cp assets/prod/t4-black-web-favicon-16x16.png apps/web/public/favicon-16x16.png
cp assets/prod/t4-black-web-favicon-32x32.png apps/web/public/favicon-32x32.png
cp assets/prod/t4-black-web-apple-touch-180.png apps/web/public/apple-touch-icon.png
git rm -r assets/dev assets/nightly
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vp test run scripts/tauri-hardening.test.ts scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts
```

Expected: PASS; all brands resolve production assets, legacy blue directories
are absent, and web/marketing public copies equal their canonical black sources.

- [ ] **Step 5: Verify no application or build reference selects blue artwork**

Run:

```bash
rg -n 'blueprint-|assets/(dev|nightly)|apps/desktop/resources' apps scripts assets package.json .github
```

Expected: no matches.

- [ ] **Step 6: Commit the repository cleanup**

```bash
git add scripts/tauri-hardening.test.ts apps/web/public
git commit -m "chore: remove blue app icons"
```

### Task 4: Build and Visually Verify Every Shipping Surface

**Files:**
- Verify only; no planned source edits.

**Interfaces:**
- Consumes: the canonical assets and references from Tasks 1–3.
- Produces: test/build evidence and a visual contact sheet showing only the
  black/white family.

- [ ] **Step 1: Run all required static and type checks**

Run:

```bash
./node_modules/.bin/vp check
./node_modules/.bin/vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Build the web and marketing applications**

Run:

```bash
./node_modules/.bin/vp run --filter @t4code/web build
./node_modules/.bin/vp run --filter @t4code/marketing build
```

Expected: both builds exit 0, and their generated favicon files use the black
production family.

- [ ] **Step 3: Build the macOS DMG**

Run:

```bash
./node_modules/.bin/vp run dist:desktop:dmg
```

Expected: the Tauri app and DMG build exits 0.

- [ ] **Step 4: Inspect the generated icon and build a contact sheet**

Run:

```bash
audit_dir=$(mktemp -d /tmp/t4code-black-icon-audit.XXXXXX)
mkdir -p "$audit_dir/thumbs"
for source in \
  assets/prod/black-macos-1024.png \
  assets/prod/black-universal-1024.png \
  assets/prod/t4-black-web-apple-touch-180.png \
  apps/web/public/apple-touch-icon.png \
  apps/marketing/public/icon.png \
  apps/marketing/public/apple-touch-icon.png
do
  target="$audit_dir/thumbs/$(echo "$source" | tr '/' '-').png"
  magick "$source" -background '#d0d0d0' -alpha background -resize '220x220' \
    -gravity center -extent 240x240 "$target"
done
montage "$audit_dir"/thumbs/*.png -tile 3x -geometry +14+14 \
  -background '#eeeeee' "$audit_dir/contact-sheet.png"
printf '%s\n' "$audit_dir/contact-sheet.png"
```

Expected: every tile shows a black background with white `T4`; inspect the
generated file with the local image viewer.

- [ ] **Step 5: Re-run the focused suite and inspect final scope**

Run:

```bash
./node_modules/.bin/vp test run scripts/tauri-hardening.test.ts scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts
git diff --check
git status --short
```

Expected: tests pass, `git diff --check` exits 0, and the only unrelated
unstaged path remains `apps/desktop/src-tauri/src/bridge.rs`.
