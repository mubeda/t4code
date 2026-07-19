export type FilePathMutationRequest =
  | {
      readonly kind: "rename";
      readonly fromRelativePath: string;
      readonly toRelativePath: string;
    }
  | {
      readonly kind: "delete" | "duplicate";
      readonly relativePath: string;
    };

export interface FilePathMutationLease {
  commitRename(toRelativePath: string): void;
  commitDelete(): void;
  release(): void;
}
