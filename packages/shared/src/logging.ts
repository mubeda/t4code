// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  readonly fileSystem?: RotatingFileSinkFileSystem;
}

export interface RotatingFileSinkFileSystem {
  readonly mkdirSync: typeof NodeFS.mkdirSync;
  readonly statSync: typeof NodeFS.statSync;
  readonly openSync: typeof NodeFS.openSync;
  readonly fstatSync: typeof NodeFS.fstatSync;
  readonly writeSync: typeof NodeFS.writeSync;
  readonly ftruncateSync: typeof NodeFS.ftruncateSync;
  readonly closeSync: typeof NodeFS.closeSync;
  readonly existsSync: typeof NodeFS.existsSync;
  readonly rmSync: typeof NodeFS.rmSync;
  readonly renameSync: typeof NodeFS.renameSync;
  readonly readdirSync: typeof NodeFS.readdirSync;
}

const defaultRotatingFileSinkFileSystem: RotatingFileSinkFileSystem = NodeFS;

export class RotatingFileSinkConfigurationError extends Schema.TaggedErrorClass<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= ${this.minimum} (received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedErrorClass<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

export class RotatingFileSinkRollbackError extends Schema.TaggedErrorClass<RotatingFileSinkRollbackError>()(
  "RotatingFileSinkRollbackError",
  {
    filePath: Schema.String,
    writeCause: Schema.Defect(),
    rollbackCause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to roll back partial rotating log write ${this.filePath}`;
  }
}

export class RotatingFileSinkCloseError extends Schema.TaggedErrorClass<RotatingFileSinkCloseError>()(
  "RotatingFileSinkCloseError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
    transactionCause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);
export const isRotatingFileSinkRollbackError = Schema.is(RotatingFileSinkRollbackError);
const isRotatingFileSinkCloseError = Schema.is(RotatingFileSinkCloseError);
export const isRotatingFileSinkTerminalError = (cause: unknown): boolean =>
  isRotatingFileSinkRollbackError(cause) || isRotatingFileSinkCloseError(cause);

const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly fileSystem: RotatingFileSinkFileSystem;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxBytes",
        received: options.maxBytes,
        minimum: 1,
      });
    }
    if (options.maxFiles < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxFiles",
        received: options.maxFiles,
        minimum: 1,
      });
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.fileSystem = options.fileSystem ?? defaultRotatingFileSinkFileSystem;

    try {
      this.fileSystem.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw new RotatingFileSinkError({
        operation: "initialize",
        filePath: this.filePath,
        cause,
      });
    }
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      this.currentSize = this.appendTransaction(buffer);

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch (cause) {
      if (isRotatingFileSinkError(cause) || isRotatingFileSinkTerminalError(cause)) {
        throw cause;
      }
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "write",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  private appendTransaction(buffer: Buffer): number {
    let descriptor: number | undefined;
    let failure: unknown;
    let nextSize = 0;
    try {
      try {
        try {
          descriptor = this.fileSystem.openSync(this.filePath, "r+");
        } catch (cause) {
          if (!isFileNotFoundError(cause)) {
            throw cause;
          }
          descriptor = this.fileSystem.openSync(this.filePath, "w+");
        }
        const stats = this.fileSystem.fstatSync(descriptor);
        if (!stats.isFile()) {
          throw Object.assign(new Error(`Rotating log target is not a file: ${this.filePath}`), {
            code: "EISDIR",
          });
        }
        const startingSize = stats.size;
        try {
          let offset = 0;
          while (offset < buffer.length) {
            const written = this.fileSystem.writeSync(
              descriptor,
              buffer,
              offset,
              buffer.length - offset,
              startingSize + offset,
            );
            if (written <= 0) {
              throw new Error("Rotating file write made no progress");
            }
            offset += written;
          }
        } catch (writeCause) {
          try {
            this.fileSystem.ftruncateSync(descriptor, startingSize);
          } catch (rollbackCause) {
            throw new RotatingFileSinkRollbackError({
              filePath: this.filePath,
              writeCause,
              rollbackCause,
            });
          }
          throw writeCause;
        }
        nextSize = startingSize + buffer.length;
      } catch (cause) {
        failure = cause;
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          this.fileSystem.closeSync(descriptor);
        } catch (closeCause) {
          failure = new RotatingFileSinkCloseError({
            filePath: this.filePath,
            cause: closeCause,
            ...(failure === undefined ? {} : { transactionCause: failure }),
          });
        }
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    return nextSize;
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (this.fileSystem.existsSync(oldest)) {
        this.fileSystem.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (this.fileSystem.existsSync(source)) {
          this.fileSystem.renameSync(source, target);
        }
      }

      if (this.fileSystem.existsSync(this.filePath)) {
        this.fileSystem.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "rotate",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of this.fileSystem.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        this.fileSystem.rmSync(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "prune",
          filePath: this.filePath,
          cause,
        });
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return this.fileSystem.statSync(this.filePath).size;
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        return 0;
      }
      throw new RotatingFileSinkError({
        operation: "read",
        filePath: this.filePath,
        cause,
      });
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
