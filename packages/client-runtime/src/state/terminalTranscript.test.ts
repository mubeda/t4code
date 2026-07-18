import { describe, expect, it, vi } from "@effect/vitest";

import {
  createTerminalTranscript as createExportedTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES as exportedDefaultMaxBytes,
} from "./terminal.ts";
import { DEFAULT_MAX_TERMINAL_BUFFER_BYTES as sessionDefaultMaxBytes } from "./terminalSession.ts";
import {
  createTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
} from "./terminalTranscript.ts";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("createTerminalTranscript", () => {
  it("exports the shared default byte cap through the terminal API", () => {
    expect(DEFAULT_MAX_TERMINAL_BUFFER_BYTES).toBe(512 * 1024);
    expect(sessionDefaultMaxBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    expect(exportedDefaultMaxBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    expect(createExportedTerminalTranscript).toBe(createTerminalTranscript);
  });

  it("concatenates appended deltas in order", () => {
    const transcript = createTerminalTranscript();

    transcript.append("hello ");
    transcript.append("world");

    expect(transcript.snapshot()).toBe("hello world");
    expect(transcript.byteLength()).toBe(bytes("hello world"));
  });

  it("ignores an empty append", () => {
    const transcript = createTerminalTranscript();

    transcript.append("");

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);
  });

  it("evicts whole oldest chunks only after crossing the byte cap", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("ab");
    transcript.append("cd");
    expect(transcript.snapshot()).toBe("abcd");

    transcript.append("ef");

    expect(transcript.snapshot()).toBe("cdef");
    expect(transcript.byteLength()).toBe(4);
  });

  it("partially trims the oldest chunk when the overflow is smaller than it", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("abc");
    transcript.append("def");

    expect(transcript.snapshot()).toBe("cdef");
    expect(transcript.byteLength()).toBe(4);
  });

  it("trims a prefix at a UTF-8 boundary without producing replacement characters", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("😀😀");

    expect(transcript.snapshot()).toBe("😀");
    expect(transcript.snapshot()).not.toContain("�");
    expect(transcript.byteLength()).toBe(4);
  });

  it("drops a whole scalar when no complete UTF-8 suffix fits", () => {
    const transcript = createTerminalTranscript(1);

    transcript.append("😀");

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);
  });

  it("keeps bounded output ordered through repeated whole-chunk eviction", () => {
    const transcript = createTerminalTranscript(200);

    for (let index = 0; index < 200; index += 1) {
      transcript.append("a");
    }
    for (let index = 0; index < 200; index += 1) {
      transcript.append("b");
    }

    expect(transcript.snapshot()).toBe("b".repeat(200));
    expect(transcript.byteLength()).toBe(200);
  });

  it("encodes only appended deltas while materializing the full text on demand", () => {
    const transcript = createTerminalTranscript(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);

    for (let index = 0; index < 1_000; index += 1) {
      transcript.append(`line ${index}\n`);
    }

    const snapshot = transcript.snapshot();
    expect(snapshot.startsWith("line 0\n")).toBe(true);
    expect(snapshot.endsWith("line 999\n")).toBe(true);
    expect(transcript.byteLength()).toBe(bytes(snapshot));
  });

  it("performs no decoding during repeated partial-prefix eviction", () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");

    try {
      const transcript = createTerminalTranscript(4 * 1024);
      transcript.append("a".repeat(64 * 1024));
      decodeSpy.mockClear();

      for (let index = 0; index < 4_096; index += 1) {
        transcript.append("b");
      }

      expect(decodeSpy).not.toHaveBeenCalled();
      expect(transcript.byteLength()).toBe(4 * 1024);

      expect(transcript.snapshot()).toBe("b".repeat(4 * 1024));
      expect(decodeSpy).toHaveBeenCalled();
    } finally {
      decodeSpy.mockRestore();
    }
  });

  it("matches a deterministic UTF-8 suffix reference model", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const cap = 37;
    const transcript = createTerminalTranscript(cap);
    const deltas = ["a", "é", "😀", "\r\n", "xyz"] as const;
    let expected = "";
    let seed = 0x5eed_1234;

    const trimToCap = (value: string) => {
      const encoded = encoder.encode(value);
      if (encoded.byteLength <= cap) {
        return value;
      }

      let start = encoded.byteLength - cap;
      while (start < encoded.byteLength && (encoded[start]! & 0b1100_0000) === 0b1000_0000) {
        start += 1;
      }
      return decoder.decode(encoded.subarray(start));
    };

    for (let index = 0; index < 1_000; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      if (seed % 97 === 0) {
        transcript.clear();
        expected = "";
      } else {
        const delta = deltas[seed % deltas.length]!;
        transcript.append(delta);
        expected = trimToCap(`${expected}${delta}`);
      }

      expect(transcript.snapshot()).toBe(expected);
      expect(transcript.byteLength()).toBe(bytes(expected));
    }
  });

  it("clears retained chunks and can be reused", () => {
    const transcript = createTerminalTranscript(2);

    transcript.append("ab");
    transcript.append("cd");
    transcript.clear();

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);

    transcript.append("xy");
    expect(transcript.snapshot()).toBe("xy");
    expect(transcript.byteLength()).toBe(2);
  });
});
