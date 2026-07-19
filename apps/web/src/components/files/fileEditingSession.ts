import type { AtomCommandResult } from "@t4code/client-runtime/state/runtime";
import type { DiffLineAnnotation, FileContents } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/editor";

import {
  FileSaveCoordinator,
  type FileSaveFlushResult,
  type FileSaveSettleResult,
  type FileSaveSnapshot,
} from "./fileSaveCoordinator";

export type FileEditorChangeHandler<LAnnotation> = (
  file: FileContents,
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[],
) => void;

export interface FileEditingSessionSnapshot {
  readonly save: FileSaveSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface FileEditingSessionOptions<A, E> {
  readonly cwd: string;
  readonly relativePath: string;
  readonly debounceMs: number;
  readonly persist: (relativePath: string, contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onConfirmed: (relativePath: string, contents: string) => void;
}

let nextSessionCacheKey = 0;

function createSessionCacheKey(cwd: string): string {
  nextSessionCacheKey += 1;
  return `${cwd}:file-editing-session:${nextSessionCacheKey}`;
}

export class FileEditingSession<LAnnotation, A = unknown, E = unknown> {
  private readonly cwd: string;
  private currentRelativePath: string;
  private currentCacheKey: string;
  private readonly coordinator: FileSaveCoordinator<A, E>;
  private readonly unsubscribeCoordinator: () => void;
  private readonly listeners = new Set<() => void>();
  private editorChangeHandler: FileEditorChangeHandler<LAnnotation> | null = null;
  private snapshot!: FileEditingSessionSnapshot;
  editor: Editor<LAnnotation>;

  constructor(private readonly options: FileEditingSessionOptions<A, E>) {
    this.cwd = options.cwd;
    this.currentRelativePath = options.relativePath;
    this.currentCacheKey = createSessionCacheKey(options.cwd);
    this.coordinator = new FileSaveCoordinator({
      debounceMs: options.debounceMs,
      persist: (contents) => options.persist(this.currentRelativePath, contents),
      onPendingChange: (pending) => options.onPendingChange(this.currentRelativePath, pending),
      onConfirmed: (contents) => options.onConfirmed(this.currentRelativePath, contents),
    });
    this.editor = this.createEditor();
    this.snapshot = this.readSnapshot();
    this.unsubscribeCoordinator = this.coordinator.subscribe(() => this.publish());
  }

  get relativePath(): string {
    return this.currentRelativePath;
  }

  get cacheKey(): string {
    return this.currentCacheKey;
  }

  private createEditor(): Editor<LAnnotation> {
    const editorOptions: EditorOptions<LAnnotation> = {
      persistState: true,
      onAttach: () => this.publish(),
      onChange: (file, lineAnnotations) => {
        this.coordinator.change(file.contents);
        this.editorChangeHandler?.(file, lineAnnotations);
        this.publish();
      },
    };
    return new Editor<LAnnotation>(editorOptions);
  }

  private readSnapshot(): FileEditingSessionSnapshot {
    return {
      save: this.coordinator.getSnapshot(),
      canUndo: this.editor.canUndo,
      canRedo: this.editor.canRedo,
    };
  }

  private publish(): void {
    const next = this.readSnapshot();
    if (
      next.save === this.snapshot.save &&
      next.canUndo === this.snapshot.canUndo &&
      next.canRedo === this.snapshot.canRedo
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): FileEditingSessionSnapshot => this.snapshot;

  setEditorChangeHandler(handler: FileEditorChangeHandler<LAnnotation> | null): void {
    this.editorChangeHandler = handler;
  }

  async flush(): Promise<FileSaveFlushResult> {
    return this.coordinator.flush();
  }

  async settle(): Promise<FileSaveSettleResult> {
    return this.coordinator.settle();
  }

  pauseSaving(): void {
    this.coordinator.pauseSaving();
  }

  resumeSaving(): void {
    this.coordinator.resumeSaving();
  }

  discardPendingSave(): void {
    this.coordinator.discardPendingSave();
  }

  undo(): void {
    if (!this.editor.canUndo) return;
    this.editor.undo();
    this.publish();
  }

  redo(): void {
    if (!this.editor.canRedo) return;
    this.editor.redo();
    this.publish();
  }

  rename(relativePath: string): void {
    this.currentRelativePath = relativePath;
  }

  changeOutsideEditor(contents: string): void {
    this.editor.cleanUp();
    this.currentCacheKey = createSessionCacheKey(this.cwd);
    this.editor = this.createEditor();
    this.coordinator.change(contents);
    this.publish();
  }

  dispose(): void {
    this.unsubscribeCoordinator();
    this.coordinator.dispose();
    this.editor.cleanUp();
    this.editorChangeHandler = null;
    this.listeners.clear();
  }
}
