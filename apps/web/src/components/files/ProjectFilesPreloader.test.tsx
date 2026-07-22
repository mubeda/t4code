import { EnvironmentId } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const { useProjectEntriesQuery } = vi.hoisted(() => ({
  useProjectEntriesQuery: vi.fn(),
}));

vi.mock("./projectFilesQueryState", () => ({ useProjectEntriesQuery }));

import { ProjectFilesPreloader } from "./ProjectFilesPreloader";

it("starts the project entries query without rendering UI", () => {
  const environmentId = EnvironmentId.make("environment-project-files-preloader-test");

  expect(
    renderToStaticMarkup(<ProjectFilesPreloader environmentId={environmentId} cwd="X:/demo" />),
  ).toBe("");
  expect(useProjectEntriesQuery).toHaveBeenCalledWith(environmentId, "X:/demo");
});
