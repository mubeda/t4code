export async function loadTerminalWebglAddon(): Promise<typeof import("@xterm/addon-webgl")> {
  return import("@xterm/addon-webgl");
}
