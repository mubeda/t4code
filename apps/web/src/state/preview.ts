import { createPreviewEnvironmentAtoms } from "@t4code/client-runtime/state/preview";

import { connectionAtomRuntime } from "../connection/runtime";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
