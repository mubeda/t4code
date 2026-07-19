# Terminal Nerd Font Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every packaged T4Code terminal render Powerline and Nerd Font glyphs by default while offering device-local bundled, system, and custom font choices.

**Architecture:** Extend client-only settings with a recoverable terminal font preference, bundle the official monospaced Nerd Fonts symbols face alongside the existing JetBrains Mono web font, and resolve every preference through one font-stack utility. Settings updates mutate the existing xterm instance after the symbols face loads, preserving the backend session and scrollback.

**Tech Stack:** Effect Schema, React 19, Vite, xterm.js 6, Tauri 2, Vite+, WebdriverIO, Nerd Fonts Symbols Only v3.4.0, fontkitten 1.0.3.

## Global Constraints

- Follow red–green–refactor for every behavior change.
- Keep the font preference in `ClientSettings`; do not add it to `ServerSettings`, Rust settings, RPC contracts, or remote-environment state.
- Do not touch the pre-existing unstaged change in `apps/desktop/src-tauri/src/bridge.rs`.
- Use the family name `T4Code Symbols Nerd Font Mono` for the bundled symbols asset.
- Pin Nerd Fonts release `v3.4.0`.
- Pin archive SHA-256 `7f8c090da3b0eaa7108646bf34cbbb6ed13d5358a72460522108b06c7ecd716a`.
- Pin source TTF SHA-256 `f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60`.
- Produce WOFF2 SHA-256 `8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467`.
- Include the upstream license with SHA-256 `84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847`.
- Keep Node and TypeScript as development/build dependencies only; add no production runtime or native font sidecar.
- Preserve identical web assets and font resolution on macOS, Windows, and Linux.
- Existing settings automatically decode to `{ mode: "bundled" }`.
- Both WebGL and fallback xterm renderers use the same resolved stack.
- `vp check` and `vp run typecheck` must pass before completion; in this environment invoke them through `pnpm exec`.

---

## File Structure

### Create

- `apps/web/src/lib/terminalFont.ts` — font preference normalization, safe CSS family construction, best-effort availability checks, and deduplicated bundled-font loading.
- `apps/web/src/lib/terminalFont.test.ts` — unit coverage for stacks, validation, availability, and load failure behavior.
- `apps/web/src/assets/fonts/nerd-fonts-symbols/SymbolsNerdFontMono-Regular.woff2` — optimized pinned font asset.
- `apps/web/src/assets/fonts/nerd-fonts-symbols/LICENSE` — exact license from the pinned release archive.
- `apps/web/src/assets/fonts/nerd-fonts-symbols/SOURCE.md` — source URL, release, conversion command, and checksums.
- `apps/web/src/assets/terminalFontAsset.test.ts` — parses the emitted WOFF2 and verifies representative glyph coverage and provenance.
- `apps/desktop/e2e/specs/terminal-font.e2e.ts` — packaged device-local persistence and glyph rendering smoke test.

### Modify

- `packages/contracts/src/settings.ts` — define `TerminalFontPreference`, its resilient default, and client settings/patch fields.
- `packages/contracts/src/settings.test.ts` — legacy/default, valid custom, malformed recovery, and patch tests.
- `apps/web/src/hooks/useSettings.ts` — schema-decode native persistence results before publishing the client snapshot.
- `apps/web/src/hooks/useSettings.test.ts` — prove malformed terminal font values recover without discarding valid client preferences.
- `apps/web/src/index.css` — register the bundled symbols face.
- `apps/web/package.json` — add `fontkitten@1.0.3` as a direct test-only development dependency.
- `pnpm-lock.yaml` — record the direct test dependency.
- `apps/web/src/components/settings/SettingsPanels.tsx` — add the existing Terminal section controls and Restore Defaults integration.
- `apps/web/src/components/settings/SettingsPanels.test.tsx` — cover presets, custom input/warning, reset, and device-local update shape.
- `apps/web/src/components/ThreadTerminalDrawer.tsx` — use the resolver at creation and update active xterm instances after the font loads.
- `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx` — prove live updates preserve terminal/session identity under both renderers.
- `apps/desktop/e2e/wdio.conf.ts` — include the packaged terminal font spec in the default cross-platform suite.

---

### Task 1: Device-local settings schema and native hydration recovery

**Files:**

- Modify: `packages/contracts/src/settings.ts:10-100`
- Modify: `packages/contracts/src/settings.ts:550-585`
- Test: `packages/contracts/src/settings.test.ts`
- Modify: `apps/web/src/hooks/useSettings.ts:8-110`
- Test: `apps/web/src/hooks/useSettings.test.ts`

**Interfaces:**

- Produces: `TerminalCustomFontFamily`, `TerminalFontPreference`, `TerminalFontPreference` type, `BUNDLED_TERMINAL_FONT_PREFERENCE`, and `terminalFontPreference` in `ClientSettings`/`ClientSettingsPatch`.
- Consumes: Existing `TrimmedNonEmptyString`, `ClientSettingsSchema`, client persistence, and `DEFAULT_CLIENT_SETTINGS`.

- [ ] **Step 1: Write failing contract tests for the default and migration behavior**

Add `ClientSettingsPatch`, `BUNDLED_TERMINAL_FONT_PREFERENCE`, and
`DEFAULT_CLIENT_SETTINGS` to the settings imports in
`packages/contracts/src/settings.test.ts`, define a patch decoder, and add:

```ts
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings terminal font", () => {
  it("automatically defaults legacy settings to the bundled font", () => {
    expect(decodeClientSettings({}).terminalFontPreference).toEqual(
      BUNDLED_TERMINAL_FONT_PREFERENCE,
    );
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontPreference).toEqual(
      BUNDLED_TERMINAL_FONT_PREFERENCE,
    );
  });

  it("decodes each supported preference", () => {
    expect(
      decodeClientSettings({ terminalFontPreference: { mode: "system" } })
        .terminalFontPreference,
    ).toEqual({ mode: "system" });
    expect(
      decodeClientSettings({
        terminalFontPreference: {
          mode: "custom",
          family: "  Iosevka Nerd Font  ",
        },
      }).terminalFontPreference,
    ).toEqual({ mode: "custom", family: "Iosevka Nerd Font" });
  });

  it.each([
    { mode: "obsolete" },
    { mode: "custom", family: "" },
    { mode: "custom", family: "Font, monospace" },
    { mode: "custom", family: "Font\u0000Name" },
  ])("recovers malformed preferences to bundled: %o", (terminalFontPreference) => {
    const decoded = decodeClientSettings({
      wordWrap: false,
      terminalFontPreference,
    });

    expect(decoded.wordWrap).toBe(false);
    expect(decoded.terminalFontPreference).toEqual(BUNDLED_TERMINAL_FONT_PREFERENCE);
  });

  it("accepts a device-local terminal font patch", () => {
    expect(
      decodeClientSettingsPatch({
        terminalFontPreference: { mode: "custom", family: "Maple Mono" },
      }).terminalFontPreference,
    ).toEqual({ mode: "custom", family: "Maple Mono" });
  });
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```bash
pnpm exec vp test run packages/contracts/src/settings.test.ts
```

Expected: FAIL because the terminal font exports and client settings field do
not exist.

- [ ] **Step 3: Implement the resilient Effect schemas and client patch**

Add the following before `ClientSettingsSchema` in
`packages/contracts/src/settings.ts`:

```ts
export const TERMINAL_CUSTOM_FONT_FAMILY_MAX_LENGTH = 128;

export const TerminalCustomFontFamily = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TERMINAL_CUSTOM_FONT_FAMILY_MAX_LENGTH),
  Schema.isPattern(/^[^,\u0000-\u001f\u007f]+$/u),
);

const TerminalFontPreferenceValue = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("bundled") }),
  Schema.Struct({ mode: Schema.Literal("system") }),
  Schema.Struct({
    mode: Schema.Literal("custom"),
    family: TerminalCustomFontFamily,
  }),
]);

export type TerminalFontPreference = typeof TerminalFontPreferenceValue.Type;

export const BUNDLED_TERMINAL_FONT_PREFERENCE = {
  mode: "bundled",
} as const satisfies TerminalFontPreference;

export const TerminalFontPreference = TerminalFontPreferenceValue.pipe(
  Schema.catchDecoding(() => Effect.succeedSome(BUNDLED_TERMINAL_FONT_PREFERENCE)),
  Schema.withDecodingDefault(Effect.succeed(BUNDLED_TERMINAL_FONT_PREFERENCE)),
);
```

Add this field to `ClientSettingsSchema`:

```ts
terminalFontPreference: TerminalFontPreference,
```

Add this field to `ClientSettingsPatch`:

```ts
terminalFontPreference: Schema.optionalKey(TerminalFontPreference),
```

Do not add the field to `TerminalSettings`, `ServerSettings`, or
`ServerSettingsPatch`.

- [ ] **Step 4: Run the contract tests and verify they pass**

Run:

```bash
pnpm exec vp test run packages/contracts/src/settings.test.ts
```

Expected: PASS, including the new terminal font cases.

- [ ] **Step 5: Write a failing native hydration regression test**

Add this test to the `client settings hydration` block in
`apps/web/src/hooks/useSettings.test.ts`:

```ts
it("schema-recovers a malformed native terminal font without losing valid preferences", async () => {
  h.persisted = {
    wordWrap: false,
    terminalFontPreference: { mode: "removed-preset" },
  };

  useClientSettings();
  await flush();

  expect(getClientSettings()).toMatchObject({
    wordWrap: false,
    terminalFontPreference: { mode: "bundled" },
  });
});
```

Add this test to `describe("useUpdatePrimarySettings")` to lock the preference
to client persistence:

```ts
it("persists terminal font preferences locally without a server RPC", () => {
  h.primaryEnv = { environmentId };

  useUpdatePrimarySettings()({
    terminalFontPreference: { mode: "system" },
  });

  expect(h.persistServerSettings).not.toHaveBeenCalled();
  expect(h.setClientSettings).toHaveBeenCalledTimes(1);
  expect(getClientSettings().terminalFontPreference).toEqual({ mode: "system" });
});
```

- [ ] **Step 6: Run the hydration and routing tests and verify they fail**

Run:

```bash
pnpm exec vp test run apps/web/src/hooks/useSettings.test.ts
```

Expected: FAIL because native hydration currently spreads the unvalidated
terminal preference into the snapshot.

- [ ] **Step 7: Decode native persistence through the client schema**

Update the settings import in `apps/web/src/hooks/useSettings.ts`:

```ts
import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type UnifiedSettings,
} from "@t4code/contracts/settings";
import * as Schema from "effect/Schema";
```

Create the decoder next to the persistence error scope:

```ts
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
```

Replace the persisted settings merge in `hydrateClientSettings`:

```ts
if (persistedSettings) {
  replaceClientSettingsSnapshot(decodeClientSettings(persistedSettings));
}
```

The schema already supplies every missing default, so do not spread
`DEFAULT_CLIENT_SETTINGS` around the decoded value.

- [ ] **Step 8: Run the focused settings tests**

Run:

```bash
pnpm exec vp test run \
  packages/contracts/src/settings.test.ts \
  apps/web/src/hooks/useSettings.test.ts \
  apps/web/src/clientPersistenceStorage.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the schema and migration unit**

```bash
git add \
  packages/contracts/src/settings.ts \
  packages/contracts/src/settings.test.ts \
  apps/web/src/hooks/useSettings.ts \
  apps/web/src/hooks/useSettings.test.ts
git commit -m "feat: add device-local terminal font preference"
```

---

### Task 2: Pinned Nerd symbols asset and shared font resolver

**Files:**

- Create: `apps/web/src/assets/fonts/nerd-fonts-symbols/SymbolsNerdFontMono-Regular.woff2`
- Create: `apps/web/src/assets/fonts/nerd-fonts-symbols/LICENSE`
- Create: `apps/web/src/assets/fonts/nerd-fonts-symbols/SOURCE.md`
- Create: `apps/web/src/assets/terminalFontAsset.test.ts`
- Create: `apps/web/src/lib/terminalFont.ts`
- Create: `apps/web/src/lib/terminalFont.test.ts`
- Modify: `apps/web/src/index.css:1`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `TerminalCustomFontFamily` and `TerminalFontPreference` from Task 1.
- Produces: `TERMINAL_NERD_SYMBOLS_FONT_FAMILY`, `resolveTerminalFontFamily`, `normalizeCustomTerminalFontFamily`, `isCustomTerminalFontAvailable`, `ensureBundledTerminalFontLoaded`, and `__resetTerminalFontLoaderForTests`.

- [ ] **Step 1: Write the failing resolver tests**

Create `apps/web/src/lib/terminalFont.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetTerminalFontLoaderForTests,
  ensureBundledTerminalFontLoaded,
  isCustomTerminalFontAvailable,
  normalizeCustomTerminalFontFamily,
  resolveTerminalFontFamily,
  TERMINAL_NERD_SYMBOLS_FONT_FAMILY,
} from "./terminalFont";

describe("resolveTerminalFontFamily", () => {
  it("uses bundled JetBrains Mono with the Nerd symbols fallback by default", () => {
    expect(resolveTerminalFontFamily({ mode: "bundled" })).toBe(
      '"JetBrains Mono", "T4Code Symbols Nerd Font Mono", monospace',
    );
  });

  it("uses the system monospace generic before the bundled symbols", () => {
    expect(resolveTerminalFontFamily({ mode: "system" })).toBe(
      'ui-monospace, "T4Code Symbols Nerd Font Mono", monospace',
    );
  });

  it("quotes a custom family and keeps deterministic fallbacks", () => {
    expect(
      resolveTerminalFontFamily({
        mode: "custom",
        family: 'Operator "Mono" \\ Local',
      }),
    ).toBe(
      '"Operator \\"Mono\\" \\\\ Local", "T4Code Symbols Nerd Font Mono", "JetBrains Mono", monospace',
    );
  });

  it("normalizes valid custom families and rejects invalid CSS stacks", () => {
    expect(normalizeCustomTerminalFontFamily("  Maple Mono  ")).toBe("Maple Mono");
    expect(normalizeCustomTerminalFontFamily("")).toBeNull();
    expect(normalizeCustomTerminalFontFamily("Maple Mono, monospace")).toBeNull();
    expect(normalizeCustomTerminalFontFamily("Maple\u0000Mono")).toBeNull();
  });
});

describe("custom font availability", () => {
  it("uses the client FontFaceSet as a best-effort device-local check", () => {
    const check = vi.fn(() => false);

    expect(isCustomTerminalFontAvailable("Missing Mono", { check })).toBe(false);
    expect(check).toHaveBeenCalledWith('12px "Missing Mono"');
  });

  it("returns unknown when a FontFaceSet is unavailable", () => {
    expect(isCustomTerminalFontAvailable("Missing Mono", null)).toBeNull();
  });
});

describe("bundled font loading", () => {
  beforeEach(() => {
    __resetTerminalFontLoaderForTests();
  });

  it("loads the symbol probe once for all terminal instances", async () => {
    const load = vi.fn(() => Promise.resolve([]));
    const fontSet = { load };

    await Promise.all([
      ensureBundledTerminalFontLoaded(fontSet),
      ensureBundledTerminalFontLoaded(fontSet),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(
      `12px "${TERMINAL_NERD_SYMBOLS_FONT_FAMILY}"`,
      "\ue0b0\uf115\u{f0001}",
    );
  });

  it("warns once and resolves when the asset cannot load", async () => {
    const load = vi.fn(() => Promise.reject(new Error("font unavailable")));
    const warn = vi.fn();

    await ensureBundledTerminalFontLoaded({ load }, warn);
    await ensureBundledTerminalFontLoaded({ load }, warn);

    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the resolver tests and verify they fail**

Run:

```bash
pnpm exec vp test run apps/web/src/lib/terminalFont.test.ts
```

Expected: FAIL because `terminalFont.ts` does not exist.

- [ ] **Step 3: Implement the shared resolver and loader**

Create `apps/web/src/lib/terminalFont.ts`:

```ts
import {
  TerminalCustomFontFamily,
  type TerminalFontPreference,
} from "@t4code/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const TERMINAL_NERD_SYMBOLS_FONT_FAMILY = "T4Code Symbols Nerd Font Mono";
export const TERMINAL_FONT_GLYPH_PROBE = "\ue0b0\uf115\u{f0001}";

interface TerminalFontFaceSet {
  readonly check: (font: string) => boolean;
}

interface TerminalFontLoader {
  readonly load: (font: string, text?: string) => Promise<unknown>;
}

type TerminalFontWarning = (message: string, cause: unknown) => void;

const decodeCustomFontFamily = Schema.decodeUnknownOption(TerminalCustomFontFamily);
let bundledFontLoadPromise: Promise<void> | null = null;

export function normalizeCustomTerminalFontFamily(input: string): string | null {
  return Option.getOrNull(decodeCustomFontFamily(input));
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function resolveTerminalFontFamily(preference: TerminalFontPreference): string {
  const symbols = quoteFontFamily(TERMINAL_NERD_SYMBOLS_FONT_FAMILY);
  switch (preference.mode) {
    case "system":
      return `ui-monospace, ${symbols}, monospace`;
    case "custom":
      return `${quoteFontFamily(preference.family)}, ${symbols}, "JetBrains Mono", monospace`;
    case "bundled":
      return `"JetBrains Mono", ${symbols}, monospace`;
  }
}

export function isCustomTerminalFontAvailable(
  family: string,
  fontSet: TerminalFontFaceSet | null = typeof document === "undefined"
    ? null
    : document.fonts,
): boolean | null {
  if (fontSet === null) return null;
  try {
    return fontSet.check(`12px ${quoteFontFamily(family)}`);
  } catch {
    return false;
  }
}

export function ensureBundledTerminalFontLoaded(
  fontSet: TerminalFontLoader = document.fonts,
  warn: TerminalFontWarning = (message, cause) => console.warn(message, cause),
): Promise<void> {
  if (bundledFontLoadPromise === null) {
    bundledFontLoadPromise = fontSet
      .load(
        `12px ${quoteFontFamily(TERMINAL_NERD_SYMBOLS_FONT_FAMILY)}`,
        TERMINAL_FONT_GLYPH_PROBE,
      )
      .then(() => undefined)
      .catch((cause: unknown) => {
        warn("[terminal] Bundled Nerd Font symbols failed to load; using text fallbacks.", cause);
      });
  }
  return bundledFontLoadPromise;
}

export function __resetTerminalFontLoaderForTests(): void {
  bundledFontLoadPromise = null;
}
```

- [ ] **Step 4: Run the resolver tests and verify they pass**

Run:

```bash
pnpm exec vp test run apps/web/src/lib/terminalFont.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the direct font parser development dependency**

Run:

```bash
pnpm --filter @t4code/web add --save-dev fontkitten@1.0.3
```

Expected: `apps/web/package.json` contains `"fontkitten": "1.0.3"` under
`devDependencies`, and `pnpm-lock.yaml` records it directly for `@t4code/web`.

- [ ] **Step 6: Write the failing asset coverage test**

Create `apps/web/src/assets/terminalFontAsset.test.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - The test verifies the checked-in binary font asset.
import { readFileSync } from "node:fs";

import { create } from "fontkitten";
import { describe, expect, it } from "vite-plus/test";

const assetDirectory = new URL("./fonts/nerd-fonts-symbols/", import.meta.url);

describe("bundled terminal Nerd Font asset", () => {
  it("contains Powerline, Nerd private-use, and supplementary-plane glyphs", () => {
    const parsed = create(
      readFileSync(new URL("SymbolsNerdFontMono-Regular.woff2", assetDirectory)),
    );
    if (parsed.isCollection) {
      throw new Error("Expected a single monospaced Nerd symbols font.");
    }

    expect(parsed.hasGlyphForCodePoint(0xe0b0)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf115)).toBe(true);
    expect(parsed.hasGlyphForCodePoint(0xf0001)).toBe(true);
  });

  it("records pinned provenance and includes the upstream license", () => {
    const source = readFileSync(new URL("SOURCE.md", assetDirectory), "utf8");
    const license = readFileSync(new URL("LICENSE", assetDirectory), "utf8");

    expect(source).toContain("Nerd Fonts v3.4.0");
    expect(source).toContain(
      "8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467",
    );
    expect(license.length).toBeGreaterThan(1_000);
  });
});
```

- [ ] **Step 7: Run the asset test and verify it fails**

Run:

```bash
pnpm exec vp test run apps/web/src/assets/terminalFontAsset.test.ts
```

Expected: FAIL because the pinned font directory does not exist.

- [ ] **Step 8: Generate and verify the pinned WOFF2 asset**

Run the following from the repository root. The binary conversion is a
deterministic generated-asset operation; source documents are added in the next
step.

```bash
work_dir="$(mktemp -d)"
curl -fsSL \
  https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/NerdFontsSymbolsOnly.tar.xz \
  -o "$work_dir/NerdFontsSymbolsOnly.tar.xz"
test "$(shasum -a 256 "$work_dir/NerdFontsSymbolsOnly.tar.xz" | awk '{print $1}')" = \
  "7f8c090da3b0eaa7108646bf34cbbb6ed13d5358a72460522108b06c7ecd716a"
tar -xf "$work_dir/NerdFontsSymbolsOnly.tar.xz" -C "$work_dir" \
  SymbolsNerdFontMono-Regular.ttf LICENSE README.md
test "$(shasum -a 256 "$work_dir/SymbolsNerdFontMono-Regular.ttf" | awk '{print $1}')" = \
  "f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60"
uvx --from 'fonttools[woff]==4.59.0' \
  fonttools ttLib.woff2 compress \
  "$work_dir/SymbolsNerdFontMono-Regular.ttf" \
  -o "$work_dir/SymbolsNerdFontMono-Regular.woff2"
test "$(shasum -a 256 "$work_dir/SymbolsNerdFontMono-Regular.woff2" | awk '{print $1}')" = \
  "8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467"
test "$(shasum -a 256 "$work_dir/LICENSE" | awk '{print $1}')" = \
  "84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847"
mkdir -p apps/web/src/assets/fonts/nerd-fonts-symbols
cp "$work_dir/SymbolsNerdFontMono-Regular.woff2" \
  apps/web/src/assets/fonts/nerd-fonts-symbols/
cp "$work_dir/LICENSE" apps/web/src/assets/fonts/nerd-fonts-symbols/LICENSE
```

Expected: the checked-in asset is approximately 1.1 MiB and matches the pinned
WOFF2 hash.

- [ ] **Step 9: Record exact source provenance**

Create `apps/web/src/assets/fonts/nerd-fonts-symbols/SOURCE.md`:

```markdown
# Symbols Nerd Font Mono provenance

- Source: Nerd Fonts v3.4.0
- Release: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0
- Archive: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/NerdFontsSymbolsOnly.tar.xz
- Archive SHA-256: `7f8c090da3b0eaa7108646bf34cbbb6ed13d5358a72460522108b06c7ecd716a`
- Source file: `SymbolsNerdFontMono-Regular.ttf`
- Source TTF SHA-256: `f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60`
- Conversion: `fonttools[woff]==4.59.0`, `fonttools ttLib.woff2 compress`
- Emitted WOFF2 SHA-256: `8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467`
- License SHA-256: `84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847`
```

- [ ] **Step 10: Register the bundled web font**

Insert this block after `@import "tailwindcss";` in `apps/web/src/index.css`:

```css
@font-face {
  font-family: "T4Code Symbols Nerd Font Mono";
  src: url("./assets/fonts/nerd-fonts-symbols/SymbolsNerdFontMono-Regular.woff2")
    format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: block;
}
```

- [ ] **Step 11: Run resolver, asset, and web build tests**

Run:

```bash
pnpm exec vp test run \
  apps/web/src/lib/terminalFont.test.ts \
  apps/web/src/assets/terminalFontAsset.test.ts
pnpm exec vp run --filter @t4code/web build
```

Expected: both test files PASS and the Vite build emits a
`SymbolsNerdFontMono-Regular-*.woff2` asset.

- [ ] **Step 12: Commit the resolver and pinned asset unit**

```bash
git add \
  apps/web/src/lib/terminalFont.ts \
  apps/web/src/lib/terminalFont.test.ts \
  apps/web/src/assets/fonts/nerd-fonts-symbols \
  apps/web/src/assets/terminalFontAsset.test.ts \
  apps/web/src/index.css \
  apps/web/package.json \
  pnpm-lock.yaml
git commit -m "feat: bundle terminal Nerd Font symbols"
```

---

### Task 3: Terminal font controls in the existing Settings section

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:1-90`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:380-485`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:962-990`
- Test: `apps/web/src/components/settings/SettingsPanels.test.tsx`

**Interfaces:**

- Consumes: `TerminalFontPreference`, `BUNDLED_TERMINAL_FONT_PREFERENCE`,
  `normalizeCustomTerminalFontFamily`, and `isCustomTerminalFontAvailable`.
- Produces: Existing General → Terminal UI patches of the form
  `{ terminalFontPreference: TerminalFontPreference }`.

- [ ] **Step 1: Write failing Settings UI tests**

Update `changedSettings()` in
`apps/web/src/components/settings/SettingsPanels.test.tsx` to include:

```ts
terminalFontPreference: { mode: "custom", family: "Iosevka" },
```

Add these tests to `describe("GeneralSettingsPanel")`:

```tsx
it("renders the device-local terminal font selector in the existing Terminal section", () => {
  const markup = render(<GeneralSettingsPanel />);

  expect(markup).toContain('data-section-title="Terminal"');
  expect(markup).toContain("Terminal font");
  expect(markup).toContain("stored only on this device");

  invoke(control("select", "bundled"), "onValueChange", "system");
  expect(h.updateSettings).toHaveBeenCalledWith({
    terminalFontPreference: { mode: "system" },
  });

  invoke(control("select", "bundled"), "onValueChange", "custom");
  expect(h.updateSettings).toHaveBeenCalledWith({
    terminalFontPreference: { mode: "custom", family: "JetBrains Mono" },
  });
});

it("edits a custom font and warns when it is unavailable on this device", () => {
  vi.stubGlobal("document", {
    fonts: {
      check: vi.fn(() => false),
    },
  });
  h.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    terminalFontPreference: { mode: "custom", family: "Missing Mono" },
  };

  const markup = render(<GeneralSettingsPanel />);

  expect(markup).toContain("This font is not available on this device");
  invoke(control("draft-input", "Custom terminal font family"), "onCommit", "  Maple Mono  ");
  expect(h.updateSettings).toHaveBeenCalledWith({
    terminalFontPreference: { mode: "custom", family: "Maple Mono" },
  });
});

it("ignores an invalid custom font commit and resets the font independently", () => {
  h.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    terminalFontPreference: { mode: "custom", family: "Maple Mono" },
  };

  render(<GeneralSettingsPanel />);
  invoke(control("draft-input", "Custom terminal font family"), "onCommit", "");
  expect(h.updateSettings).not.toHaveBeenCalled();

  invoke(control("button", "Reset terminal font to default"), "onClick");
  expect(h.updateSettings).toHaveBeenCalledWith({
    terminalFontPreference: DEFAULT_UNIFIED_SETTINGS.terminalFontPreference,
  });
});
```

Update the Restore Defaults assertions so the changed labels include
`"Terminal font"` immediately before `"WebGL renderer"` and the restore patch
includes:

```ts
terminalFontPreference: DEFAULT_UNIFIED_SETTINGS.terminalFontPreference,
```

In the changed-settings reset test, add:

```ts
invoke(control("button", "Reset terminal font to default"), "onClick");
```

Then increment the existing `updateSettings` call-count assertion from 12 to
13.

- [ ] **Step 2: Run the Settings test and verify it fails**

Run:

```bash
pnpm exec vp test run apps/web/src/components/settings/SettingsPanels.test.tsx
```

Expected: FAIL because no Terminal font row or restore integration exists.

- [ ] **Step 3: Add Settings imports and labels**

Update the contracts import in `SettingsPanels.tsx`:

```ts
import {
  BUNDLED_TERMINAL_FONT_PREFERENCE,
  DEFAULT_UNIFIED_SETTINGS,
  type TerminalFontPreference,
} from "@t4code/contracts/settings";
```

Add the resolver imports:

```ts
import {
  isCustomTerminalFontAvailable,
  normalizeCustomTerminalFontFamily,
} from "../../lib/terminalFont";
```

Add the option metadata near the other Settings constants:

```ts
const TERMINAL_FONT_OPTIONS = [
  { value: "bundled", label: "T4Code Nerd Font (bundled)" },
  { value: "system", label: "System monospace" },
  { value: "custom", label: "Custom font family" },
] as const satisfies ReadonlyArray<{
  readonly value: TerminalFontPreference["mode"];
  readonly label: string;
}>;

function terminalFontPreferenceForMode(
  mode: TerminalFontPreference["mode"],
  current: TerminalFontPreference,
): TerminalFontPreference {
  switch (mode) {
    case "system":
      return { mode: "system" };
    case "custom":
      return current.mode === "custom"
        ? current
        : { mode: "custom", family: "JetBrains Mono" };
    case "bundled":
      return BUNDLED_TERMINAL_FONT_PREFERENCE;
  }
}
```

- [ ] **Step 4: Add the font row above WebGL**

Insert this row first inside `<SettingsSection title="Terminal">`:

```tsx
<SettingsRow
  title="Terminal font"
  description="Choose the terminal typeface stored only on this device. Nerd Font symbols are always bundled as a fallback."
  status={
    settings.terminalFontPreference.mode === "custom" &&
    isCustomTerminalFontAvailable(settings.terminalFontPreference.family) === false
      ? "This font is not available on this device. T4Code will use its bundled fallbacks."
      : null
  }
  resetAction={
    settings.terminalFontPreference.mode !==
    DEFAULT_UNIFIED_SETTINGS.terminalFontPreference.mode ? (
      <SettingResetButton
        label="terminal font"
        onClick={() =>
          updateSettings({
            terminalFontPreference: DEFAULT_UNIFIED_SETTINGS.terminalFontPreference,
          })
        }
      />
    ) : null
  }
  control={
    <Select
      value={settings.terminalFontPreference.mode}
      onValueChange={(value) => {
        if (value === "bundled" || value === "system" || value === "custom") {
          updateSettings({
            terminalFontPreference: terminalFontPreferenceForMode(
              value,
              settings.terminalFontPreference,
            ),
          });
        }
      }}
    >
      <SelectTrigger className="w-full sm:w-56" aria-label="Terminal font">
        <SelectValue>
          {TERMINAL_FONT_OPTIONS.find(
            (option) => option.value === settings.terminalFontPreference.mode,
          )?.label ?? "T4Code Nerd Font (bundled)"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {TERMINAL_FONT_OPTIONS.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  }
/>
```

Insert this subordinate row immediately after it:

```tsx
{settings.terminalFontPreference.mode === "custom" ? (
  <SettingsRow
    className="bg-muted/20 sm:pl-9"
    title="Custom font family"
    description="Enter one font family installed on this device."
    control={
      <DraftInput
        className="w-full sm:w-72"
        value={settings.terminalFontPreference.family}
        onCommit={(input) => {
          const family = normalizeCustomTerminalFontFamily(input);
          if (family === null) return;
          updateSettings({
            terminalFontPreference: { mode: "custom", family },
          });
        }}
        placeholder="Iosevka Nerd Font"
        spellCheck={false}
        aria-label="Custom terminal font family"
      />
    }
  />
) : null}
```

- [ ] **Step 5: Add Restore Defaults integration**

In `useSettingsRestore`, add the changed label:

```ts
...(settings.terminalFontPreference.mode !==
  DEFAULT_UNIFIED_SETTINGS.terminalFontPreference.mode
  ? ["Terminal font"]
  : []),
```

Add `settings.terminalFontPreference` to the `useMemo` dependency list.

Add this field to the `updateSettings` call inside `restoreDefaults`:

```ts
terminalFontPreference: DEFAULT_UNIFIED_SETTINGS.terminalFontPreference,
```

- [ ] **Step 6: Run Settings and settings-routing tests**

Run:

```bash
pnpm exec vp test run \
  apps/web/src/components/settings/SettingsPanels.test.tsx \
  apps/web/src/hooks/useSettings.test.ts
```

Expected: PASS. The routing test must show that `terminalFontPreference` causes
client persistence and no server RPC.

- [ ] **Step 7: Commit the Settings UI unit**

```bash
git add \
  apps/web/src/components/settings/SettingsPanels.tsx \
  apps/web/src/components/settings/SettingsPanels.test.tsx
git commit -m "feat: add terminal font settings"
```

---

### Task 4: Apply font changes to active xterm instances

**Files:**

- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:575-735`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:1060-1180`
- Test: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`

**Interfaces:**

- Consumes: `resolveTerminalFontFamily`, `ensureBundledTerminalFontLoaded`, and
  `terminalFontPreference`.
- Produces: Live xterm option/cache/layout updates without replacing the
  terminal or attached transcript runtime.

- [ ] **Step 1: Extend the fake xterm and write failing live-update tests**

In `FakeTerminalInstance`, add:

```ts
readonly clearTextureAtlas: ReturnType<typeof vi.fn>;
```

In the fake `Terminal` class, add:

```ts
readonly clearTextureAtlas = vi.fn();
```

Extend `testState`:

```ts
terminalFontPreference: { mode: "bundled" } as
  | { readonly mode: "bundled" }
  | { readonly mode: "system" }
  | { readonly mode: "custom"; readonly family: string },
fontLoad: vi.fn(() => Promise.resolve()),
```

Change the `usePrimarySettings` mock so selectors receive both values:

```ts
vi.mock("../hooks/useSettings", () => ({
  usePrimarySettings: (
    selector: (settings: {
      terminal: { webglEnabled: boolean };
      terminalFontPreference: typeof testState.terminalFontPreference;
    }) => unknown,
  ) =>
    selector({
      terminal: { webglEnabled: testState.webglEnabled },
      terminalFontPreference: testState.terminalFontPreference,
    }),
}));
```

Mock only the side-effectful loader while preserving the real resolver:

```ts
vi.mock("../lib/terminalFont", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/terminalFont")>();
  return {
    ...actual,
    ensureBundledTerminalFontLoaded: () => testState.fontLoad(),
  };
});
```

Add `setTerminalFontPreference` to `mountViewport`:

```ts
async setTerminalFontPreference(
  terminalFontPreference: typeof testState.terminalFontPreference,
) {
  testState.terminalFontPreference = terminalFontPreference;
  await rerender();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
```

Reset `testState.terminalFontPreference = { mode: "bundled" }` in
`beforeEach`, then reset the loader:

```ts
testState.fontLoad.mockReset().mockResolvedValue(undefined);
```

Add this parameterized interaction test:

```tsx
it.each([false, true])(
  "updates the active terminal font without replacing the session (webgl=%s)",
  async (webglEnabled) => {
    const view = await mountViewport({ visible: true, webglEnabled });
    const terminal = view.fakeTerminal;
    expect(terminal).not.toBeNull();
    expect(terminal!.options.fontFamily).toBe(
      '"JetBrains Mono", "T4Code Symbols Nerd Font Mono", monospace',
    );
    xtermState.fitAddons.at(-1)!.fit.mockImplementation(() => {
      terminal!.cols += 1;
    });
    view.resizeSpy.mockClear();

    await view.setTerminalFontPreference({
      mode: "custom",
      family: "Maple Mono",
    });

    expect(view.fakeTerminal).toBe(terminal);
    expect(terminal!.dispose).not.toHaveBeenCalled();
    expect(view.detachRendererSpy).not.toHaveBeenCalled();
    expect(terminal!.options.fontFamily).toBe(
      '"Maple Mono", "T4Code Symbols Nerd Font Mono", "JetBrains Mono", monospace',
    );
    expect(terminal!.clearTextureAtlas).toHaveBeenCalled();
    expect(terminal!.refresh).toHaveBeenCalledWith(0, terminal!.rows - 1);
    expect(view.resizeSpy).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        threadId: THREAD_ID,
        terminalId: "term-1",
        cols: terminal!.cols,
        rows: terminal!.rows,
      },
    });
  },
);
```

- [ ] **Step 2: Run the interaction test and verify it fails**

Run:

```bash
pnpm exec vp test run apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
```

Expected: FAIL because the terminal still has the hard-coded stack and no live
font update effect.

- [ ] **Step 3: Read and resolve the device-local font setting**

Add this import to `ThreadTerminalDrawer.tsx`:

```ts
import {
  ensureBundledTerminalFontLoaded,
  resolveTerminalFontFamily,
} from "../lib/terminalFont";
```

Next to `webglEnabled`, add:

```ts
const terminalFontPreference = usePrimarySettings(
  (settings) => settings.terminalFontPreference,
);
const terminalFontFamily = useMemo(
  () => resolveTerminalFontFamily(terminalFontPreference),
  [terminalFontPreference],
);
const readTerminalFontFamily = useEffectEvent(() => terminalFontFamily);
```

- [ ] **Step 4: Replace the hard-coded creation stack**

Change the `new Terminal` options:

```ts
fontFamily: readTerminalFontFamily(),
```

Do not add `terminalFontFamily` or `terminalFontPreference` to the terminal
creation effect dependencies. `readTerminalFontFamily` is an Effect Event so
new terminals read the latest value without making font changes tear down the
renderer.

- [ ] **Step 5: Add the live font update effect**

Insert this effect after the terminal creation effect and before WebGL addon
activation:

```tsx
useEffect(() => {
  const terminal = terminalRef.current;
  const fitAddon = fitAddonRef.current;
  if (!shouldRender || transcriptRuntime === null || terminal === null || fitAddon === null) {
    return;
  }

  let cancelled = false;
  const resizeRendererGeneration = resizeRendererGenerationRef.current;
  const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  terminal.options.fontFamily = terminalFontFamily;

  void ensureBundledTerminalFontLoaded().then(() => {
    if (
      cancelled ||
      terminalRef.current !== terminal ||
      fitAddonRef.current !== fitAddon
    ) {
      return;
    }
    terminal.clearTextureAtlas();
    fitTerminalSafely(fitAddon);
    if (wasAtBottom) {
      terminal.scrollToBottom();
    }
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    requestTerminalResize(
      resizeRendererGeneration,
      terminal.cols,
      terminal.rows,
    );
  });

  return () => {
    cancelled = true;
  };
}, [shouldRender, terminalFontFamily, transcriptRuntime]);
```

This changes only xterm presentation. It must not call terminal attach, write,
resize, restart, dispose, or transcript APIs.

- [ ] **Step 6: Run terminal unit and interaction tests**

Run:

```bash
pnpm exec vp test run \
  apps/web/src/components/ThreadTerminalDrawer.test.ts \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx \
  apps/web/src/components/terminalWebgl.test.ts \
  apps/web/src/lib/terminalFont.test.ts
```

Expected: PASS for both `webgl=false` and `webgl=true`.

- [ ] **Step 7: Commit the live terminal update unit**

```bash
git add \
  apps/web/src/components/ThreadTerminalDrawer.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
git commit -m "feat: apply terminal font changes live"
```

---

### Task 5: Cross-platform packaged UI regression

**Files:**

- Create: `apps/desktop/e2e/specs/terminal-font.e2e.ts`
- Modify: `apps/desktop/e2e/wdio.conf.ts:45-55`

**Interfaces:**

- Consumes: Existing packaged desktop fixture, Settings UI, device-local
  persistence, bundled font face, and terminal drawer.
- Produces: One WDIO spec run by the existing macOS arm64/x64, Windows x64, and
  Linux x64 desktop UI matrix.

- [ ] **Step 1: Add the new spec to the default WDIO suite and verify discovery fails**

Add `"./specs/terminal-font.e2e.ts"` to the default `specs` array in
`apps/desktop/e2e/wdio.conf.ts`:

```ts
[
  "./specs/main-window.e2e.ts",
  "./specs/project-session-terminal.e2e.ts",
  "./specs/platform-capabilities.e2e.ts",
  "./specs/terminal-font.e2e.ts",
]
```

Run:

```bash
pnpm exec vp run --filter @t4code/desktop typecheck
```

Expected: FAIL because the referenced test file does not exist.

- [ ] **Step 2: Create the packaged terminal font UI test**

Create `apps/desktop/e2e/specs/terminal-font.e2e.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests save native screenshots.
import * as NodePath from "node:path";

import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.T4CODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.T4CODE_E2E_PROJECT_PATH;
if (!artifactDirectory || !projectPath) {
  throw new Error("The packaged desktop UI fixture environment was not prepared.");
}

const bundledLabel = "T4Code Nerd Font (bundled)";
const fontGlyphProbe = "\ue0b0 \uf115 \u{f0001}";
const terminalGlyphProbe = "\ue0b0 \uf115";

async function openGeneralSettings(): Promise<void> {
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/settings/general`);
  await expect(browser.$('[aria-label="Terminal font"]')).toBeDisplayed();
}

async function selectTerminalFont(label: string): Promise<void> {
  const selector = browser.$('[aria-label="Terminal font"]');
  await selector.scrollIntoView();
  await selector.click();
  const option = browser.$(`//*[@role="option" and normalize-space()="${label}"]`);
  await option.waitForDisplayed();
  await option.click();
}

async function ensureFixtureProjectImported(): Promise<void> {
  const existingProject = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  if (await existingProject.isExisting()) {
    return;
  }

  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await expect(addProject).toBeDisplayed();
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(projectPath);
  await browseFolder.click();
  await existingProject.waitForDisplayed();
}

describe("packaged terminal font support", () => {
  it("loads bundled Nerd glyphs, persists a device-local preset, and restores the default", async () => {
    await setDesktopUiWindowSize(1_000, 720);
    await openGeneralSettings();

    const selector = browser.$('[aria-label="Terminal font"]');
    await expect(selector).toHaveText(expect.stringContaining(bundledLabel));

    const fontProbe = await browser.executeAsync((probe, done) => {
      void document.fonts
        .load('12px "T4Code Symbols Nerd Font Mono"', probe)
        .then(() => {
          done({
            loaded: document.fonts.check(
              '12px "T4Code Symbols Nerd Font Mono"',
              probe,
            ),
            familyRegistered: [...document.fonts].some(
              (face) => face.family === "T4Code Symbols Nerd Font Mono",
            ),
          });
        })
        .catch((error: unknown) => {
          done({ loaded: false, familyRegistered: false, error: String(error) });
        });
    }, fontGlyphProbe);
    expect(fontProbe).toEqual(
      expect.objectContaining({ loaded: true, familyRegistered: true }),
    );

    await selectTerminalFont("System monospace");
    await browser.reloadSession();

    await openGeneralSettings();
    await expect(browser.$('[aria-label="Terminal font"]')).toHaveText(
      expect.stringContaining("System monospace"),
    );

    const reset = browser.$('button[aria-label="Reset terminal font to default"]');
    await expect(reset).toBeDisplayed();
    await reset.click();
    await expect(browser.$('[aria-label="Terminal font"]')).toHaveText(
      expect.stringContaining(bundledLabel),
    );

    const appOrigin = await browser.execute(() => window.location.origin);
    await browser.url(`${appOrigin}/#/`);
    await ensureMainSidebarOpen();
    await ensureFixtureProjectImported();
    const project = browser.$(
      `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
    );
    await expect(project).toBeDisplayed();
    await project.click();

    const newChat = browser.$('[data-testid="sidebar-new-main-chat-trigger"]');
    await expect(newChat).toBeEnabled();
    await newChat.click();

    const terminalToggle = browser.$('button[aria-label="Toggle terminal drawer"]');
    await expect(terminalToggle).toBeEnabled();
    await terminalToggle.click();
    const terminalScreen = browser.$(".xterm-screen");
    await expect(terminalScreen).toBeDisplayed();
    await terminalScreen.click();
    await browser.keys([`echo ${terminalGlyphProbe}`, "Enter"]);

    await browser.saveScreenshot(
      NodePath.join(artifactDirectory, "terminal-nerd-font-glyphs.png"),
    );
  });
});
```

- [ ] **Step 3: Typecheck the desktop E2E suite**

Run:

```bash
pnpm exec vp run --filter @t4code/desktop typecheck
```

Expected: PASS.

- [ ] **Step 4: Build the packaged macOS UI test application**

Run:

```bash
pnpm run test:ui:desktop:build
```

Expected: the packaged T4Code macOS application is produced and includes the
hashed WOFF2 asset.

- [ ] **Step 5: Run the terminal font packaged UI test on macOS**

Run:

```bash
T4CODE_E2E_SPEC=./specs/terminal-font.e2e.ts pnpm run test:ui:desktop
```

Expected: PASS. Inspect the generated `terminal-nerd-font-glyphs.png` and
confirm U+E0B0, U+F115, and U+F0001 render as icons rather than tofu boxes.

- [ ] **Step 6: Commit the packaged UI regression**

```bash
git add \
  apps/desktop/e2e/specs/terminal-font.e2e.ts \
  apps/desktop/e2e/wdio.conf.ts
git commit -m "test: cover packaged terminal Nerd Fonts"
```

---

### Task 6: Full validation and compatibility evidence

**Files:**

- Verify only; modify a task-owned file only if a failing check exposes a
  regression introduced by Tasks 1-5.

**Interfaces:**

- Consumes: All implementation tasks.
- Produces: Green repository gates, full unit suite, web/desktop builds, local
  macOS packaged UI evidence, and a cross-platform CI-ready WDIO spec.

- [ ] **Step 1: Verify the working tree scope**

Run:

```bash
git status --short
git diff --stat HEAD~5
```

Expected: only the task commits plus the pre-existing unstaged
`apps/desktop/src-tauri/src/bridge.rs` modification are present. Do not stage
that Rust file.

- [ ] **Step 2: Run the complete unit test suite**

Run:

```bash
pnpm exec vp run test
```

Expected: all TypeScript and Rust unit/integration test packages PASS.

- [ ] **Step 3: Run the required repository checks**

Run:

```bash
pnpm exec vp check
pnpm exec vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 4: Build the web and desktop pipelines**

Run:

```bash
pnpm exec vp run --filter @t4code/web build
pnpm exec vp run build:desktop
```

Expected: both builds exit 0 and the web output contains the hashed WOFF2
asset. Because Tauri packages that same Vite output on every platform, no
platform-specific asset path is introduced.

- [ ] **Step 5: Re-run the packaged macOS UI validation after all checks**

Run:

```bash
pnpm run test:ui:desktop:build
T4CODE_E2E_SPEC=./specs/terminal-font.e2e.ts pnpm run test:ui:desktop
```

Expected: PASS with a visually correct
`terminal-nerd-font-glyphs.png` artifact.

- [ ] **Step 6: Confirm Windows, macOS, and Linux CI coverage**

Run:

```bash
pnpm exec vp test run scripts/ci-platform-contract.test.ts
git diff --check
git status --short
```

Expected:

- The CI platform contract test passes.
- `.github/workflows/desktop-ui-smoke.yml` still covers Linux x64, Windows x64,
  macOS arm64, and macOS x64.
- The new terminal font spec is in the default WDIO suite consumed by that
  matrix.
- `git diff --check` reports no whitespace errors.
- The unrelated `bridge.rs` change remains unstaged.

- [ ] **Step 7: Review the final commits**

Run:

```bash
git log --oneline --max-count=6
git status --short
```

Expected: separate commits exist for client settings, bundled asset/resolver,
Settings UI, live xterm updates, and packaged UI coverage. No additional commit
is necessary when all verification is green.
