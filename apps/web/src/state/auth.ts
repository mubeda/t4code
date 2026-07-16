import { createAuthEnvironmentAtoms } from "@t4code/client-runtime/state/auth";

import { connectionAtomRuntime } from "../connection/runtime";

export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);
