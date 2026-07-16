import { createReviewEnvironmentAtoms } from "@t4code/client-runtime/state/review";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
