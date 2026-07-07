import { describe, expect, it } from "vite-plus/test";
import { QrCode, QrSegment } from "./qrCode.ts";

// Renders the module matrix as a string of 0/1 rows so two QR Codes can be
// compared for exact equality of every module.
function moduleMatrix(qr: QrCode): string {
  const rows: Array<string> = [];
  for (let y = 0; y < qr.size; y++) {
    let row = "";
    for (let x = 0; x < qr.size; x++) row += qr.getModule(x, y) ? "1" : "0";
    rows.push(row);
  }
  return rows.join("\n");
}

describe("QrCode.encodeText", () => {
  it("encodes short text as a version 1 symbol with size = version * 4 + 17", () => {
    const qr = QrCode.encodeText("HELLO", QrCode.Ecc.LOW);
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
  });

  it("boosts the error correction level when the data still fits", () => {
    // 5 alphanumeric chars use 41 bits; version 1 HIGH holds 72 data bits.
    const qr = QrCode.encodeText("HELLO", QrCode.Ecc.LOW);
    expect(qr.errorCorrectionLevel).toBe(QrCode.Ecc.HIGH);
  });

  it("encodes the empty string", () => {
    const qr = QrCode.encodeText("", QrCode.Ecc.LOW);
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
  });

  it("selects a larger version for longer payloads", () => {
    const qr = QrCode.encodeText("A".repeat(200), QrCode.Ecc.LOW);
    expect(qr.version).toBeGreaterThan(1);
    expect(qr.size).toBe(qr.version * 4 + 17);
  });

  it("is deterministic for the same input", () => {
    const a = QrCode.encodeText("https://example.com/pair#token=abc", QrCode.Ecc.MEDIUM);
    const b = QrCode.encodeText("https://example.com/pair#token=abc", QrCode.Ecc.MEDIUM);
    expect(a.version).toBe(b.version);
    expect(a.mask).toBe(b.mask);
    expect(moduleMatrix(a)).toBe(moduleMatrix(b));
  });

  it("matches encodeSegments over the auto-generated segments", () => {
    const text = "HELLO WORLD";
    const viaText = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
    const viaSegments = QrCode.encodeSegments(QrSegment.makeSegments(text), QrCode.Ecc.MEDIUM);
    expect(moduleMatrix(viaText)).toBe(moduleMatrix(viaSegments));
  });

  it("throws when the text cannot fit any version", () => {
    expect(() => QrCode.encodeText("A".repeat(5000), QrCode.Ecc.LOW)).toThrow(RangeError);
    expect(() => QrCode.encodeText("A".repeat(5000), QrCode.Ecc.LOW)).toThrow("Data too long");
  });
});

describe("QrCode.encodeBinary", () => {
  it("encodes bytes identically to byte-mode text encoding", () => {
    // "hi" is neither numeric nor alphanumeric (lowercase), so encodeText
    // falls back to byte mode over the UTF-8 bytes [104, 105].
    const viaBinary = QrCode.encodeBinary([104, 105], QrCode.Ecc.MEDIUM);
    const viaText = QrCode.encodeText("hi", QrCode.Ecc.MEDIUM);
    expect(moduleMatrix(viaBinary)).toBe(moduleMatrix(viaText));
  });

  it("rejects byte values outside 0-255", () => {
    expect(() => QrCode.encodeBinary([256], QrCode.Ecc.LOW)).toThrow(RangeError);
  });
});

describe("QrCode.encodeSegments", () => {
  it("rejects invalid version ranges and masks", () => {
    const segs = QrSegment.makeSegments("HI");
    expect(() => QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 0, 40)).toThrow("Invalid value");
    expect(() => QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 1, 41)).toThrow("Invalid value");
    expect(() => QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 5, 3)).toThrow("Invalid value");
    expect(() => QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 1, 40, -2)).toThrow("Invalid value");
    expect(() => QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 1, 40, 8)).toThrow("Invalid value");
  });

  it("throws Data too long when the payload exceeds maxVersion capacity", () => {
    // Version 1 LOW holds 19 data codewords; 30 bytes cannot fit.
    const seg = QrSegment.makeBytes(new Array<number>(30).fill(0));
    expect(() => QrCode.encodeSegments([seg], QrCode.Ecc.LOW, 1, 1)).toThrow("Data too long");
  });

  it("keeps the requested error correction level when boostEcl is false", () => {
    const segs = QrSegment.makeSegments("HELLO");
    const qr = QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 1, 40, -1, false);
    expect(qr.errorCorrectionLevel).toBe(QrCode.Ecc.LOW);
  });

  it("honors each forced mask value 0 through 7", () => {
    const segs = QrSegment.makeSegments("HI");
    for (let m = 0; m <= 7; m++) {
      const qr = QrCode.encodeSegments(segs, QrCode.Ecc.LOW, 1, 40, m);
      expect(qr.mask).toBe(m);
    }
  });

  it("auto-selects a mask in range that matches the same mask forced", () => {
    const segs = QrSegment.makeSegments("HTTPS://EXAMPLE.COM");
    const auto = QrCode.encodeSegments(segs, QrCode.Ecc.MEDIUM, 1, 40, -1);
    expect(auto.mask).toBeGreaterThanOrEqual(0);
    expect(auto.mask).toBeLessThanOrEqual(7);
    const forced = QrCode.encodeSegments(segs, QrCode.Ecc.MEDIUM, 1, 40, auto.mask);
    expect(moduleMatrix(forced)).toBe(moduleMatrix(auto));
  });

  it("respects minVersion, drawing version information for version >= 7", () => {
    const qr = QrCode.encodeSegments(QrSegment.makeSegments("HI"), QrCode.Ecc.LOW, 7, 40);
    expect(qr.version).toBe(7);
    expect(qr.size).toBe(45);
    // The two version-information blocks are transposed copies of each other.
    for (let i = 0; i < 18; i++) {
      const a = qr.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      expect(qr.getModule(a, b)).toBe(qr.getModule(b, a));
    }
  });

  it("handles the version 32 alignment pattern special case", () => {
    const qr = QrCode.encodeSegments(QrSegment.makeSegments("HELLO"), QrCode.Ecc.LOW, 32, 40, 3);
    expect(qr.version).toBe(32);
    expect(qr.size).toBe(32 * 4 + 17);
    expect(qr.mask).toBe(3);
  });

  it("accepts a leading ECI segment", () => {
    const segs = [QrSegment.makeEci(26), ...QrSegment.makeSegments("hi")];
    const qr = QrCode.encodeSegments(segs, QrCode.Ecc.MEDIUM);
    expect(qr.version).toBe(1);
  });
});

describe("QrCode structural invariants", () => {
  const qr = QrCode.encodeText("HELLO WORLD", QrCode.Ecc.MEDIUM);

  it("always sets the dark module at (8, size - 8)", () => {
    expect(qr.getModule(8, qr.size - 8)).toBe(true);
  });

  it("draws finder patterns in three corners", () => {
    // Centers are dark; the ring at Chebyshev distance 2 is light; the
    // separator at distance 4 is light; distance 3 border is dark.
    expect(qr.getModule(3, 3)).toBe(true);
    expect(qr.getModule(qr.size - 4, 3)).toBe(true);
    expect(qr.getModule(3, qr.size - 4)).toBe(true);
    expect(qr.getModule(5, 3)).toBe(false);
    expect(qr.getModule(3, 7)).toBe(false);
    expect(qr.getModule(0, 0)).toBe(true);
  });

  it("draws alternating timing patterns", () => {
    for (let i = 8; i <= qr.size - 9; i++) {
      expect(qr.getModule(i, 6)).toBe(i % 2 === 0);
      expect(qr.getModule(6, i)).toBe(i % 2 === 0);
    }
  });

  it("draws an alignment pattern at (18, 18) for version 2", () => {
    const v2 = QrCode.encodeSegments(QrSegment.makeSegments("HI"), QrCode.Ecc.LOW, 2, 40);
    expect(v2.version).toBe(2);
    expect(v2.getModule(18, 18)).toBe(true); // center dark
    expect(v2.getModule(17, 18)).toBe(false); // ring at distance 1 light
    expect(v2.getModule(16, 18)).toBe(true); // ring at distance 2 dark
  });

  it("returns false (light) for out-of-bounds getModule coordinates", () => {
    expect(qr.getModule(-1, 0)).toBe(false);
    expect(qr.getModule(0, -1)).toBe(false);
    expect(qr.getModule(qr.size, 0)).toBe(false);
    expect(qr.getModule(0, qr.size)).toBe(false);
  });
});

describe("QrCode low-level constructor", () => {
  it("builds a symbol from raw data codewords", () => {
    // Version 1 LOW carries exactly 19 data codewords.
    const qr = new QrCode(1, QrCode.Ecc.LOW, new Array<number>(19).fill(0), 0);
    expect(qr.size).toBe(21);
    expect(qr.mask).toBe(0);
    expect(qr.errorCorrectionLevel).toBe(QrCode.Ecc.LOW);
  });

  it("rejects versions outside 1-40", () => {
    const codewords = new Array<number>(19).fill(0);
    expect(() => new QrCode(0, QrCode.Ecc.LOW, codewords, 0)).toThrow(
      "Version value out of range",
    );
    expect(() => new QrCode(41, QrCode.Ecc.LOW, codewords, 0)).toThrow(
      "Version value out of range",
    );
  });

  it("rejects masks outside -1..7", () => {
    const codewords = new Array<number>(19).fill(0);
    expect(() => new QrCode(1, QrCode.Ecc.LOW, codewords, 8)).toThrow("Mask value out of range");
    expect(() => new QrCode(1, QrCode.Ecc.LOW, codewords, -2)).toThrow("Mask value out of range");
  });

  it("rejects a data codeword array of the wrong length", () => {
    expect(() => new QrCode(1, QrCode.Ecc.LOW, new Array<number>(18).fill(0), 0)).toThrow(
      RangeError,
    );
  });
});

describe("QrCode.Ecc", () => {
  it("exposes the four standard levels with their ordinals", () => {
    expect(QrCode.Ecc.LOW.ordinal).toBe(0);
    expect(QrCode.Ecc.MEDIUM.ordinal).toBe(1);
    expect(QrCode.Ecc.QUARTILE.ordinal).toBe(2);
    expect(QrCode.Ecc.HIGH.ordinal).toBe(3);
  });

  it("exposes the standard format bits", () => {
    expect(QrCode.Ecc.LOW.formatBits).toBe(1);
    expect(QrCode.Ecc.MEDIUM.formatBits).toBe(0);
    expect(QrCode.Ecc.QUARTILE.formatBits).toBe(3);
    expect(QrCode.Ecc.HIGH.formatBits).toBe(2);
  });
});

describe("QrSegment.makeBytes", () => {
  it("packs each byte as 8 bits in big-endian order", () => {
    const seg = QrSegment.makeBytes([0xff, 0x01]);
    expect(seg.mode).toBe(QrSegment.Mode.BYTE);
    expect(seg.numChars).toBe(2);
    expect(seg.getData()).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("accepts an empty byte array", () => {
    const seg = QrSegment.makeBytes([]);
    expect(seg.numChars).toBe(0);
    expect(seg.getData()).toEqual([]);
  });
});

describe("QrSegment.makeNumeric", () => {
  it("packs 3 digits into 10 bits", () => {
    const seg = QrSegment.makeNumeric("012");
    expect(seg.mode).toBe(QrSegment.Mode.NUMERIC);
    expect(seg.numChars).toBe(3);
    // 12 as a 10-bit value
    expect(seg.getData()).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
  });

  it("packs a trailing group of 2 digits into 7 bits", () => {
    const seg = QrSegment.makeNumeric("01234");
    expect(seg.numChars).toBe(5);
    // 012 -> 10 bits, 34 -> 7 bits
    expect(seg.getData()).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("packs a trailing single digit into 4 bits", () => {
    const seg = QrSegment.makeNumeric("7");
    expect(seg.getData()).toEqual([0, 1, 1, 1]);
  });

  it("rejects non-numeric input", () => {
    expect(() => QrSegment.makeNumeric("12a")).toThrow(RangeError);
    expect(() => QrSegment.makeNumeric("12a")).toThrow("non-numeric");
  });
});

describe("QrSegment.makeAlphanumeric", () => {
  it("packs pairs of characters into 11 bits", () => {
    // A=10, B=11 -> 10 * 45 + 11 = 461
    const seg = QrSegment.makeAlphanumeric("AB");
    expect(seg.mode).toBe(QrSegment.Mode.ALPHANUMERIC);
    expect(seg.numChars).toBe(2);
    expect(seg.getData()).toEqual([0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1]);
  });

  it("packs a trailing odd character into 6 bits", () => {
    // C = 12
    const seg = QrSegment.makeAlphanumeric("ABC");
    expect(seg.numChars).toBe(3);
    expect(seg.getData()).toEqual([0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0]);
  });

  it("rejects characters outside the alphanumeric charset", () => {
    expect(() => QrSegment.makeAlphanumeric("abc")).toThrow(RangeError);
    expect(() => QrSegment.makeAlphanumeric("A#B")).toThrow("unencodable");
  });
});

describe("QrSegment.makeSegments", () => {
  it("returns no segments for the empty string", () => {
    expect(QrSegment.makeSegments("")).toEqual([]);
  });

  it("selects numeric mode for digit strings", () => {
    const segs = QrSegment.makeSegments("31415926");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.mode).toBe(QrSegment.Mode.NUMERIC);
  });

  it("selects alphanumeric mode for uppercase text", () => {
    const segs = QrSegment.makeSegments("HELLO WORLD $1/2:3");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.mode).toBe(QrSegment.Mode.ALPHANUMERIC);
  });

  it("falls back to byte mode with UTF-8 encoding for other text", () => {
    const segs = QrSegment.makeSegments("é"); // "é" -> UTF-8 bytes C3 A9
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.mode).toBe(QrSegment.Mode.BYTE);
    expect(seg.numChars).toBe(2);
    expect(seg.getData()).toEqual([1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 1]);
  });
});

describe("QrSegment.makeEci", () => {
  it("encodes small assignment values in 8 bits", () => {
    const seg = QrSegment.makeEci(26);
    expect(seg.mode).toBe(QrSegment.Mode.ECI);
    expect(seg.numChars).toBe(0);
    expect(seg.getData()).toEqual([0, 0, 0, 1, 1, 0, 1, 0]);
    expect(QrSegment.makeEci(127).getData()).toHaveLength(8);
  });

  it("encodes medium assignment values in 16 bits", () => {
    expect(QrSegment.makeEci(128).getData()).toHaveLength(16);
    expect(QrSegment.makeEci(16383).getData()).toHaveLength(16);
  });

  it("encodes large assignment values in 24 bits", () => {
    expect(QrSegment.makeEci(16384).getData()).toHaveLength(24);
    expect(QrSegment.makeEci(999999).getData()).toHaveLength(24);
  });

  it("rejects out-of-range assignment values", () => {
    expect(() => QrSegment.makeEci(-1)).toThrow(RangeError);
    expect(() => QrSegment.makeEci(1000000)).toThrow(RangeError);
  });
});

describe("QrSegment.isNumeric / isAlphanumeric", () => {
  it("classifies numeric strings", () => {
    expect(QrSegment.isNumeric("0123456789")).toBe(true);
    expect(QrSegment.isNumeric("")).toBe(true);
    expect(QrSegment.isNumeric("12.5")).toBe(false);
    expect(QrSegment.isNumeric("-1")).toBe(false);
  });

  it("classifies alphanumeric strings", () => {
    expect(QrSegment.isAlphanumeric("ABC XYZ $%*+-./: 09")).toBe(true);
    expect(QrSegment.isAlphanumeric("")).toBe(true);
    expect(QrSegment.isAlphanumeric("abc")).toBe(false);
    expect(QrSegment.isAlphanumeric("A,B")).toBe(false);
  });
});

describe("QrSegment constructor and getData", () => {
  it("rejects a negative character count", () => {
    expect(() => new QrSegment(QrSegment.Mode.BYTE, -1, [])).toThrow(RangeError);
  });

  it("defensively copies the bit buffer on construction and access", () => {
    const bits: Array<number> = [1, 0, 1];
    const seg = new QrSegment(QrSegment.Mode.BYTE, 1, bits);
    bits.push(1);
    expect(seg.getData()).toEqual([1, 0, 1]);
    const out = seg.getData();
    out.push(0);
    expect(seg.getData()).toEqual([1, 0, 1]);
  });
});

describe("QrSegment.getTotalBits", () => {
  it("sums header and data bits using version-dependent count field widths", () => {
    const segs = [QrSegment.makeNumeric("123")];
    // 4 mode bits + char-count bits (10/12/14 by version band) + 10 data bits
    expect(QrSegment.getTotalBits(segs, 1)).toBe(24);
    expect(QrSegment.getTotalBits(segs, 9)).toBe(24);
    expect(QrSegment.getTotalBits(segs, 10)).toBe(26);
    expect(QrSegment.getTotalBits(segs, 26)).toBe(26);
    expect(QrSegment.getTotalBits(segs, 27)).toBe(28);
    expect(QrSegment.getTotalBits(segs, 40)).toBe(28);
  });

  it("returns 0 for no segments", () => {
    expect(QrSegment.getTotalBits([], 1)).toBe(0);
  });

  it("returns Infinity when a segment length overflows its count field", () => {
    // Numeric char count field is 10 bits at version 1, so 1024 overflows.
    const seg = new QrSegment(QrSegment.Mode.NUMERIC, 1024, []);
    expect(QrSegment.getTotalBits([seg], 1)).toBe(Infinity);
  });
});

describe("QrSegment.Mode", () => {
  it("exposes the standard mode indicator bits", () => {
    expect(QrSegment.Mode.NUMERIC.modeBits).toBe(0x1);
    expect(QrSegment.Mode.ALPHANUMERIC.modeBits).toBe(0x2);
    expect(QrSegment.Mode.BYTE.modeBits).toBe(0x4);
    expect(QrSegment.Mode.KANJI.modeBits).toBe(0x8);
    expect(QrSegment.Mode.ECI.modeBits).toBe(0x7);
  });

  it("reports the character count field width per version band", () => {
    expect(QrSegment.Mode.BYTE.numCharCountBits(1)).toBe(8);
    expect(QrSegment.Mode.BYTE.numCharCountBits(10)).toBe(16);
    expect(QrSegment.Mode.KANJI.numCharCountBits(40)).toBe(12);
    expect(QrSegment.Mode.ECI.numCharCountBits(20)).toBe(0);
  });
});
