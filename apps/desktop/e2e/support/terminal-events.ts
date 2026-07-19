// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests inspect native log artifacts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function terminalOutputEventCount(stateRoot: string): number {
  const eventsPath = NodePath.join(stateRoot, "userdata", "logs", "terminals", "events.log");
  if (!NodeFS.existsSync(eventsPath)) return 0;

  return NodeFS.readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes('"eventType":"activity"') && line.includes('"output"')).length;
}
