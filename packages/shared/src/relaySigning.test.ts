import { describe, expect, it } from "@effect/vitest";

import { stableStringify } from "./relaySigning.ts";

describe("relaySigning", () => {
  it("canonicalizes object keys recursively", () => {
    expect(
      stableStringify({
        z: 1,
        a: {
          y: true,
          b: null,
        },
        list: [{ c: "three", a: "one" }],
      }),
    ).toBe('{"a":{"b":null,"y":true},"list":[{"a":"one","c":"three"}],"z":1}');
  });

  it("orders keys by UTF-16 code units instead of the host locale", () => {
    expect(stableStringify({ a: 1, Z: 2, "\u00e9": 3 })).toBe('{"Z":2,"a":1,"\u00e9":3}');
  });

  it("matches JSON body semantics for primitives, arrays, and omitted object values", () => {
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(false)).toBe("false");
    expect(stableStringify("\u2713")).toBe('"\u2713"');
    expect(stableStringify([undefined, "", 0])).toBe('[null,"",0]');
    expect(stableStringify({ body: "", omitted: undefined })).toBe('{"body":""}');
  });
});
