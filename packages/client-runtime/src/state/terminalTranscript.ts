export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MIN_DEAD_CHUNKS_BEFORE_COMPACTION = 64;

interface TranscriptChunk {
  bytes: Uint8Array;
  start: number;
}

export interface TerminalTranscript {
  /** Appends a delta, encoding only the new delta before evicting the oldest overflow. */
  append(delta: string): void;
  clear(): void;
  /** Materializes the retained transcript only when a snapshot is requested. */
  snapshot(): string;
  byteLength(): number;
}

export function createTerminalTranscript(
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalTranscript {
  const chunks: Array<TranscriptChunk | null> = [];
  let head = 0;
  let totalBytes = 0;

  const compactDeadChunks = () => {
    if (head >= MIN_DEAD_CHUNKS_BEFORE_COMPACTION && head * 2 >= chunks.length) {
      chunks.splice(0, head);
      head = 0;
    }
  };

  const dropFrontChunk = () => {
    const front = chunks[head]!;
    totalBytes -= front.bytes.byteLength - front.start;
    chunks[head] = null;
    head += 1;
    compactDeadChunks();
  };

  const evictOverflow = () => {
    while (totalBytes > maxBufferBytes && head < chunks.length) {
      const overflow = totalBytes - maxBufferBytes;
      const front = chunks[head]!;
      if (front.bytes.byteLength - front.start <= overflow) {
        dropFrontChunk();
        continue;
      }

      let start = front.start + overflow;
      while (
        start < front.bytes.byteLength &&
        (front.bytes[start]! & 0b1100_0000) === 0b1000_0000
      ) {
        start += 1;
      }

      const retainedByteLength = front.bytes.byteLength - start;
      if (retainedByteLength === 0) {
        dropFrontChunk();
      } else {
        totalBytes -= start - front.start;
        if (start >= retainedByteLength) {
          front.bytes = front.bytes.slice(start);
          front.start = 0;
        } else {
          front.start = start;
        }
      }
    }
  };

  return {
    append(delta) {
      if (delta.length === 0) {
        return;
      }

      const encoded = encoder.encode(delta);
      chunks.push({ bytes: encoded, start: 0 });
      totalBytes += encoded.byteLength;
      if (totalBytes > maxBufferBytes) {
        evictOverflow();
      }
    },
    clear() {
      chunks.length = 0;
      head = 0;
      totalBytes = 0;
    },
    snapshot() {
      const retainedText: Array<string> = [];
      for (let index = head; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        retainedText.push(decoder.decode(chunk.bytes.subarray(chunk.start)));
      }
      return retainedText.join("");
    },
    byteLength() {
      return totalBytes;
    },
  };
}
