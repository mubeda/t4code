import {
  TerminalLaunchCommand,
  type TerminalLaunchCommand as TerminalLaunchCommandValue,
} from "@t4code/contracts";
import * as Schema from "effect/Schema";

const decodeTerminalLaunchCommandOption = Schema.decodeUnknownOption(TerminalLaunchCommand);

export function decodeTerminalLaunchCommand(value: unknown): TerminalLaunchCommandValue | null {
  const decoded = decodeTerminalLaunchCommandOption(value);
  return decoded._tag === "Some" ? decoded.value : null;
}
