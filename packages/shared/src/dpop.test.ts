import { assert, describe, it } from "@effect/vitest";
import * as Encoding from "effect/Encoding";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  type DpopPublicJwk,
  verifyDpopProof,
} from "./dpop.ts";

const textEncoder = new TextEncoder();

function encodeJson(value: unknown): string {
  return Encoding.encodeBase64Url(textEncoder.encode(JSON.stringify(value)));
}

async function generateDpopKeyPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
}> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y) {
    throw new Error("WebCrypto did not export a public P-256 JWK.");
  }
  return {
    privateKey: keyPair.privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y },
  };
}

const primaryKeyPair = generateDpopKeyPair();
const secondaryKeyPair = generateDpopKeyPair();

async function signDpopProof(input: {
  readonly privateKey: CryptoKey;
  readonly publicJwk: unknown;
  readonly method?: string;
  readonly url?: string;
  readonly jti?: string;
  readonly iat?: number;
  readonly accessToken?: string;
  readonly nonce?: string;
  readonly header?: Readonly<Record<string, unknown>>;
  readonly payload?: Readonly<Record<string, unknown>>;
}): Promise<string> {
  const header = encodeJson(
    input.header ?? { typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk },
  );
  const payload = encodeJson(
    input.payload ?? {
      htm: input.method ?? "POST",
      htu: input.url ?? "https://example.com/oauth/token",
      jti: input.jti ?? "proof-1",
      iat: input.iat ?? 100,
      ...(input.accessToken !== undefined
        ? { ath: computeDpopAccessTokenHash(input.accessToken) }
        : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    },
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    textEncoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
}

async function validFixture(input?: {
  readonly method?: string;
  readonly url?: string;
  readonly jti?: string;
  readonly iat?: number;
  readonly accessToken?: string;
  readonly nonce?: string;
}) {
  const keyPair = await primaryKeyPair;
  return {
    ...keyPair,
    proof: await signDpopProof({ ...input, ...keyPair }),
  };
}

function expectRejected(
  result: ReturnType<typeof verifyDpopProof>,
  reason: string,
): asserts result is { readonly ok: false; readonly reason: string } {
  if (result.ok) assert.fail(`Expected rejection: ${reason}`);
  assert.equal(result.reason, reason);
}

describe("verifyDpopProof", () => {
  it("verifies a generated ES256 proof and returns its signed replay identity", async () => {
    const { proof, publicJwk } = await validFixture({ jti: "replay-id", iat: 100 });
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const result = verifyDpopProof({
      proof,
      method: "post",
      url: "HTTPS://EXAMPLE.COM:443/oauth/token?code=secret#fragment",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
    });

    if (!result.ok) assert.fail(result.reason);
    assert.equal(result.thumbprint, thumbprint);
    assert.equal(result.jti, "replay-id");
    assert.equal(result.iat, 100);
  });

  it("rejects missing and malformed compact proofs", () => {
    for (const proof of [null, undefined, "", "   "]) {
      expectRejected(
        verifyDpopProof({
          proof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        "Missing DPoP proof.",
      );
    }
    for (const proof of ["one.two", "one.two.three.four", ".two.three", "one..three", "one.two."]) {
      expectRejected(
        verifyDpopProof({
          proof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        "Invalid DPoP compact JWT.",
      );
    }
  });

  it("rejects malformed JSON and unsupported header algorithms, curves, and key types", async () => {
    const { proof, privateKey, publicJwk } = await validFixture();
    const [, payload, signature] = proof.split(".");
    if (!payload || !signature) assert.fail("Expected compact DPoP fixture.");

    expectRejected(
      verifyDpopProof({
        proof: `${Encoding.encodeBase64Url(textEncoder.encode("{"))}.${payload}.${signature}`,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 100,
      }),
      "Invalid DPoP JWT header.",
    );

    const invalidHeaders = [
      { typ: "JWT", alg: "ES256", jwk: publicJwk },
      { typ: "dpop+jwt", alg: "ES384", jwk: publicJwk },
      { typ: "dpop+jwt", alg: "ES256", jwk: { ...publicJwk, crv: "P-384" } },
      { typ: "dpop+jwt", alg: "ES256", jwk: { ...publicJwk, kty: "OKP" } },
      { typ: "dpop+jwt", alg: "ES256", jwk: { ...publicJwk, x: "" } },
    ];
    for (const header of invalidHeaders) {
      const invalidProof = await signDpopProof({ privateKey, publicJwk, header });
      expectRejected(
        verifyDpopProof({
          proof: invalidProof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        "Invalid DPoP JWT header.",
      );
    }
  });

  it("rejects malformed payload encodings and missing or invalid required claims", async () => {
    const { proof, privateKey, publicJwk } = await validFixture();
    const [header, , signature] = proof.split(".");
    if (!header || !signature) assert.fail("Expected compact DPoP fixture.");

    expectRejected(
      verifyDpopProof({
        proof: `${header}.${Encoding.encodeBase64Url(textEncoder.encode("{"))}.${signature}`,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 100,
      }),
      "Invalid DPoP JWT payload.",
    );

    const invalidPayloads = [
      { htu: "https://example.com/oauth/token", jti: "proof-1", iat: 100 },
      { htm: "POST", htu: "", jti: "proof-1", iat: 100 },
      { htm: "POST", htu: "https://example.com/oauth/token", jti: "", iat: 100 },
      { htm: "POST", htu: "https://example.com/oauth/token", jti: "proof-1", iat: 100.5 },
    ];
    for (const payload of invalidPayloads) {
      const invalidProof = await signDpopProof({ privateKey, publicJwk, payload });
      expectRejected(
        verifyDpopProof({
          proof: invalidProof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        "Invalid DPoP JWT payload.",
      );
    }
  });

  it("enforces thumbprint, method, URL, and access-token bindings", async () => {
    const { proof, publicJwk } = await validFixture({ accessToken: "access-token" });
    const thumbprint = computeDpopJwkThumbprint(publicJwk);

    expectRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: "",
      }),
      "DPoP key thumbprint mismatch.",
    );
    expectRejected(
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
      "DPoP method mismatch.",
    );
    expectRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "not a URL",
        nowEpochSeconds: 101,
      }),
      "DPoP URL mismatch.",
    );
    expectRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/other",
        nowEpochSeconds: 101,
      }),
      "DPoP URL mismatch.",
    );
    expectRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedAccessToken: "",
      }),
      "DPoP access token hash mismatch.",
    );
    assert.equal(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedAccessToken: "access-token",
      }).ok,
      true,
    );
  });

  it("enforces default and custom age limits at their exact boundaries", async () => {
    const keyPair = await primaryKeyPair;
    const cases = [
      { iat: 1_005, now: 1_000, ok: true },
      { iat: 1_006, now: 1_000, ok: false },
      { iat: 700, now: 1_000, ok: true },
      { iat: 699, now: 1_000, ok: false },
    ];
    for (const testCase of cases) {
      const proof = await signDpopProof({ ...keyPair, iat: testCase.iat });
      assert.equal(
        verifyDpopProof({
          proof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: testCase.now,
        }).ok,
        testCase.ok,
      );
    }

    const customBoundary = await signDpopProof({ ...keyPair, iat: 999 });
    const customExpired = await signDpopProof({ ...keyPair, iat: 998 });
    assert.equal(
      verifyDpopProof({
        proof: customBoundary,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        maxAgeSeconds: 1,
      }).ok,
      true,
    );
    expectRejected(
      verifyDpopProof({
        proof: customExpired,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        maxAgeSeconds: 1,
      }),
      "DPoP proof is outside the allowed time window.",
    );
  });

  it("rejects signature/key mismatches, malformed signatures, and malformed coordinates", async () => {
    const primary = await primaryKeyPair;
    const secondary = await secondaryKeyPair;
    const mismatchedProof = await signDpopProof({
      privateKey: primary.privateKey,
      publicJwk: secondary.publicJwk,
    });
    expectRejected(
      verifyDpopProof({
        proof: mismatchedProof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 100,
      }),
      "Invalid DPoP signature.",
    );

    const proof = await signDpopProof(primary);
    const [header, payload] = proof.split(".");
    if (!header || !payload) assert.fail("Expected compact DPoP fixture.");
    for (const [signature, reason] of [
      ["%", "Invalid DPoP proof."],
      [Encoding.encodeBase64Url(new Uint8Array(63)), "Invalid DPoP signature."],
    ] as const) {
      expectRejected(
        verifyDpopProof({
          proof: `${header}.${payload}.${signature}`,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        reason,
      );
    }

    for (const publicJwk of [
      { ...primary.publicJwk, x: Encoding.encodeBase64Url(new Uint8Array(31)) },
      { ...primary.publicJwk, y: Encoding.encodeBase64Url(new Uint8Array(31)) },
      { ...primary.publicJwk, x: "%" },
    ]) {
      const malformedKeyProof = await signDpopProof({ ...primary, publicJwk });
      expectRejected(
        verifyDpopProof({
          proof: malformedKeyProof,
          method: "POST",
          url: "https://example.com/oauth/token",
          nowEpochSeconds: 100,
        }),
        "Invalid DPoP proof.",
      );
    }
  });

  it("rejects private JWK material and accepts signed nonce claims without leaking them", async () => {
    const keyPair = await primaryKeyPair;
    const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    const privateProof = await signDpopProof({ ...keyPair, publicJwk: privateJwk });
    expectRejected(
      verifyDpopProof({
        proof: privateProof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 100,
      }),
      "Invalid DPoP JWT header.",
    );

    const nonce = "nonce-secret-value";
    const { proof } = await validFixture({ nonce, jti: "same-jti" });
    const first = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 100,
    });
    const second = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 100,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) assert.fail("Expected stateless proof verification.");
    assert.equal(first.jti, second.jti);
    assert.equal(JSON.stringify(first).includes(nonce), false);
  });
});

describe("DPoP helpers", () => {
  it("normalizes URL case/default ports and rejects malformed URLs", () => {
    assert.equal(
      normalizeDpopHtu("HTTPS://EXAMPLE.COM:443/token?authorization=secret#fragment"),
      "https://example.com/token",
    );
    assert.equal(normalizeDpopHtu("not a URL"), null);
  });

  it("computes deterministic, input-sensitive thumbprints and access-token hashes", async () => {
    const primary = await primaryKeyPair;
    const secondary = await secondaryKeyPair;

    assert.equal(
      computeDpopJwkThumbprint(primary.publicJwk),
      computeDpopJwkThumbprint(primary.publicJwk),
    );
    assert.notEqual(
      computeDpopJwkThumbprint(primary.publicJwk),
      computeDpopJwkThumbprint(secondary.publicJwk),
    );
    assert.equal(computeDpopAccessTokenHash(""), computeDpopAccessTokenHash(""));
    assert.notEqual(
      computeDpopAccessTokenHash("access-token"),
      computeDpopAccessTokenHash("other-access-token"),
    );
  });
});
