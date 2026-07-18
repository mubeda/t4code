import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

async function main(): Promise<void> {
  if (import.meta.env.VITE_T4CODE_DESKTOP_E2E === "1") {
    await import("@wdio/tauri-plugin");
  }
  const { renderApplication } = await import("./bootstrap");
  await renderApplication();
}

void main();
