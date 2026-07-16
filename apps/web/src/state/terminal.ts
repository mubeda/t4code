import { createTerminalEnvironmentAtoms } from "@t4code/client-runtime/state/terminal";

import { connectionAtomRuntime } from "../connection/runtime";

export const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);
