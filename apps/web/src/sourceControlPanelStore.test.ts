import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t4code/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "./sourceControlPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("sourceControlPanelStore", () => {
  beforeEach(() => useSourceControlPanelStore.setState({ byThreadKey: {} }));

  it("returns a default draft for an unknown thread", () => {
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      message: "",
    });
  });

  it("sets the commit message", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "fix: thing");
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF)
        .message,
    ).toBe("fix: thing");
  });

  it("clears the draft on removeThread", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "wip");
    useSourceControlPanelStore.getState().removeThread(THREAD_REF);
    expect(useSourceControlPanelStore.getState().byThreadKey).toEqual({});
  });
});
