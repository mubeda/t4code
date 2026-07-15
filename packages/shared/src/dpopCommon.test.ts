import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DpopPublicJwk, normalizeDpopHtu } from "./dpopCommon.ts";

const decodeDpopPublicJwk = Schema.decodeUnknownSync(DpopPublicJwk);

describe("dpopCommon", () => {
  it("decodes public P-256 JWKs through the exported schema", () => {
    const jwk = { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" } as const;

    expect(decodeDpopPublicJwk(jwk)).toEqual(jwk);
    expect(() => decodeDpopPublicJwk({ ...jwk, crv: "P-384" })).toThrow();
    expect(() => decodeDpopPublicJwk({ ...jwk, x: "" })).toThrow();
  });

  it("normalizes an htu without query or fragment and rejects malformed URLs", () => {
    expect(normalizeDpopHtu("HTTPS://EXAMPLE.COM:443/token?code=secret#fragment")).toBe(
      "https://example.com/token",
    );
    expect(normalizeDpopHtu("not a URL")).toBeNull();
  });
});
