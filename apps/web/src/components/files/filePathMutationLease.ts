export interface FilePathMutationLease {
  commitRename(toRelativePath: string): void;
  commitDelete(): void;
  release(): void;
}
