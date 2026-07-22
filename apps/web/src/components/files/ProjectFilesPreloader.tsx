import type { EnvironmentId } from "@t4code/contracts";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface ProjectFilesPreloaderProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function ProjectFilesPreloader({ environmentId, cwd }: ProjectFilesPreloaderProps): null {
  useProjectEntriesQuery(environmentId, cwd);
  return null;
}
