import { expect, it, vi } from "vite-plus/test";

const WebglAddon = vi.hoisted(
  () =>
    class WebglAddon {
      readonly kind = "webgl";
    },
);

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon }));

import { loadTerminalWebglAddon } from "./terminalWebgl";

it("lazily resolves the installed WebGL addon module", async () => {
  const module = await loadTerminalWebglAddon();

  expect(module.WebglAddon).toBe(WebglAddon);
});
