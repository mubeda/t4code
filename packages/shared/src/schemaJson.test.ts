import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeJsonResult,
  decodeUnknownJsonResult,
  extractJsonObject,
  formatSchemaError,
  fromJsonStringPretty,
  fromLenientJson,
} from "./schemaJson.ts";

const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

function formatFailedExit(exit: Exit.Exit<unknown, Schema.SchemaError>): string {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected schema decoding to fail");
  }
  return formatSchemaError(exit.cause);
}

const decodeShortString = Schema.decodeUnknownExit(Schema.String.check(Schema.isMinLength(5)));
const decodeMissingToken = Schema.decodeUnknownExit(Schema.Struct({ token: Schema.String }));
const decodeUnexpectedToken = Schema.decodeUnknownExit(Schema.Struct({ token: Schema.String }), {
  onExcessProperty: "error",
});
const forbiddenSchema = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.forbidden(() => "decoding is disabled"),
    encode: SchemaGetter.passthrough(),
  }),
);
const decodeForbidden = Schema.decodeUnknownExit(forbiddenSchema);
const decodeOneOf = Schema.decodeUnknownExit(
  Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.Number })], {
    mode: "oneOf",
  }),
);
const decodeFiniteFromString = Schema.decodeUnknownExit(Schema.FiniteFromString);
const decodeNestedNumbers = Schema.decodeUnknownExit(
  Schema.Struct({ items: Schema.Array(Schema.Number) }),
);
const decodeComposite = Schema.decodeUnknownExit(
  Schema.Struct({ count: Schema.Number, name: Schema.String }),
  { errors: "all" },
);
const decodeConstrainedUnion = Schema.decodeUnknownExit(
  Schema.Union([
    Schema.String.check(Schema.isMinLength(2)),
    Schema.String.check(Schema.isPattern(/^required-prefix/u)),
  ]),
  { errors: "all" },
);
const decodeEmptyUnion = Schema.decodeUnknownExit(Schema.Union([]));

const issueLimitFields: Record<string, typeof Schema.Number> = {};
const issueLimitInput: Record<string, unknown> = {};
for (let index = 0; index < 10; index += 1) {
  issueLimitFields[`field-${index}`] = Schema.Number;
  issueLimitInput[`field-${index}`] = `credential=secret-value-${index}`;
}
const decodeIssueLimit = Schema.decodeUnknownExit(Schema.Struct(issueLimitFields), {
  errors: "all",
});

describe("schemaJson helpers", () => {
  it("extracts a balanced JSON object from surrounding text", () => {
    expect(
      extractJsonObject(`Sure, here is the JSON:
\`\`\`json
{
  "subject": "Update README",
  "body": ""
}
\`\`\`
Done.`),
    ).toBe(`{
  "subject": "Update README",
  "body": ""
}`);
  });

  it("ignores braces inside strings while finding the object boundary", () => {
    expect(
      extractJsonObject('prefix {"message":"literal } brace","nested":{"ok":true}} suffix'),
    ).toBe('{"message":"literal } brace","nested":{"ok":true}}');
  });

  it("tracks escaped quotes and unterminated objects", () => {
    expect(extractJsonObject('prefix {"message":"escaped \\\" } quote","ok":true} suffix')).toBe(
      '{"message":"escaped \\\" } quote","ok":true}',
    );
    expect(extractJsonObject('prefix {"message":"trailing \\\\"} suffix')).toBe(
      '{"message":"trailing \\\\"}',
    );
    expect(extractJsonObject('prefix {"nested":{"ok":true}')).toBe('{"nested":{"ok":true}');
    expect(extractJsonObject("   ")).toBe("");
  });

  it("returns trimmed input when no JSON object starts", () => {
    expect(extractJsonObject("  no structured output  ")).toBe("no structured output");
  });

  it("decodes JSON with comments and trailing commas", () => {
    expect(
      decodeLenientJson(`{
        // Comments are valid in settings files.
        "enabled": true,
        "values": [1, 2,],
      }`),
    ).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("preserves comment markers and escaped quotes inside strings", () => {
    expect(
      decodeLenientJson(`{
        "url": "https://example.test/a//b",
        "literal": "/* not a comment */",
        "quote": "say \\"hello\\"",
        /* Remove this block. */
        "enabled": true // and this line
      }`),
    ).toEqual({
      url: "https://example.test/a//b",
      literal: "/* not a comment */",
      quote: 'say "hello"',
      enabled: true,
    });
  });

  it("rejects malformed JSON after lenient preprocessing", () => {
    expect(() => decodeLenientJson('{ "enabled": true,, }')).toThrow();
  });

  it("formats schema failures with paths without exposing invalid values", () => {
    const decodeCredential = decodeJsonResult(Schema.Struct({ token: Schema.Number }));
    const decoded = decodeCredential('{"token":"credential=secret-value"}');

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(formatSchemaError(decoded.failure)).toBe('Invalid type\n  at ["token"]');
    }
  });

  it("decodes known and unknown JSON inputs as Results", () => {
    const decodeKnown = decodeJsonResult(Schema.Struct({ count: Schema.Number }));
    const decodeUnknown = decodeUnknownJsonResult(Schema.Struct({ count: Schema.Number }));

    expect(decodeKnown('{"count":1}')).toEqual(Result.succeed({ count: 1 }));
    expect(Result.isFailure(decodeKnown('{"count":"one"}'))).toBe(true);
    expect(decodeUnknown('{"count":2}')).toEqual(Result.succeed({ count: 2 }));
    expect(Result.isFailure(decodeUnknown({ count: 2 }))).toBe(true);
  });

  it("formats leaf diagnostics produced by public schema operations", () => {
    const invalidValue = formatFailedExit(decodeShortString("secret-value".slice(0, 1)));
    const missingKey = formatFailedExit(decodeMissingToken({}));
    const unexpectedKey = formatFailedExit(
      decodeUnexpectedToken({ token: "ok", secret: "credential=secret-value" }),
    );
    const forbidden = formatFailedExit(decodeForbidden("credential=secret-value"));
    const oneOf = formatFailedExit(decodeOneOf({ a: "credential=secret-value", b: 1 }));

    expect(invalidValue).toBe("Invalid value");
    expect(missingKey).toBe('Missing key\n  at ["token"]');
    expect(unexpectedKey).toBe('Unexpected key\n  at ["secret"]');
    expect(forbidden).toBe("Forbidden operation");
    expect(oneOf).toBe("Expected exactly one schema member to match");
    for (const diagnostic of [invalidValue, missingKey, unexpectedKey, forbidden, oneOf]) {
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("flattens transformation, nested, composite, and union failures", () => {
    const transformation = formatFailedExit(decodeFiniteFromString("credential=secret-value"));
    const nested = formatFailedExit(decodeNestedNumbers({ items: [1, "credential=secret-value"] }));
    const composite = formatFailedExit(
      decodeComposite({ count: "credential=secret-value", name: 1 }),
    );
    const union = formatFailedExit(decodeConstrainedUnion(""));
    const emptyUnion = formatFailedExit(decodeEmptyUnion("secret"));

    expect(transformation).toBe("Invalid value");
    expect(nested).toBe('Invalid type\n  at ["items"][1]');
    expect(composite).toBe('Invalid type\n  at ["count"]\nInvalid type\n  at ["name"]');
    expect(union).toBe("Invalid value\nInvalid value");
    expect(emptyUnion).toBe("Invalid value");
    for (const diagnostic of [transformation, nested, composite, union, emptyUnion]) {
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("bounds and sanitizes paths emitted by a public refinement", () => {
    const path: ReadonlyArray<PropertyKey> = [
      `${"long".repeat(20)}-secret`,
      2,
      Symbol.for("token"),
      ...Array.from({ length: 15 }, (_, index) => index),
    ];
    const schema = Schema.String.check(
      Schema.makeFilter(() => ({ path, issue: "credential is invalid" })),
    );
    const diagnostic = formatFailedExit(
      Schema.decodeUnknownExit(schema)("credential=secret-value"),
    );

    expect(diagnostic).toMatch(/\["(?:long){10,}l?\.\.\."\]/u);
    expect(diagnostic).toContain('[2]["Symbol(token)"]');
    expect(diagnostic).toContain("[...]");
    expect(diagnostic).not.toContain("secret");
  });

  it("preserves nested paths reported by schema filters", () => {
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({
          path: ["session", "token"],
          issue: "credential is invalid",
        })),
      ),
    );
    const decoded = decode('"credential=secret-value"');

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      const diagnostic = formatSchemaError(decoded.failure);
      expect(diagnostic).toBe('Invalid value\n  at ["session"]["token"]');
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("does not expose malformed lenient JSON input in diagnostics", () => {
    const decode = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
    const exit = decode('{"token":"credential=secret-value",,}');

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const diagnostic = formatSchemaError(exit.cause);
      expect(diagnostic).toBe("Invalid value");
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("summarizes unexpected defects without serializing their messages", () => {
    const diagnostic = formatSchemaError(Cause.die(new Error("credential=secret-value")));

    expect(diagnostic).toBe(
      "Schema validation failed (failureCount=0, defectCount=1, interruptionCount=0).",
    );
  });

  it("counts defect and interruption reasons without leaking them", () => {
    const cause = Cause.combine(Cause.die(new Error("credential=secret-value")), Cause.interrupt());

    expect(formatSchemaError(cause)).toBe(
      "Schema validation failed (failureCount=0, defectCount=1, interruptionCount=1).",
    );
  });

  it("bounds the number of formatted schema issues", () => {
    const diagnostic = formatFailedExit(decodeIssueLimit(issueLimitInput));
    expect(diagnostic.match(/Invalid type/g)).toHaveLength(8);
    expect(diagnostic).toContain("... and 2 more issue(s)");
    expect(diagnostic).not.toContain("credential=secret-value");
  });

  it("retains the omitted issue count when bounding long diagnostics", () => {
    const longPath = Array.from({ length: 16 }, (_, index) => `${index}-${"segment".repeat(16)}`);
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({ path: longPath, issue: "credential is invalid" })),
      ),
    );
    const failures: Array<Cause.Cause<Schema.SchemaError>> = [];
    for (let index = 0; index < 10; index += 1) {
      const decoded = decode(`"credential=secret-value-${index}"`);
      if (Result.isFailure(decoded)) {
        failures.push(decoded.failure);
      }
    }

    const cause = Cause.fromReasons(failures.flatMap((cause) => cause.reasons));
    const diagnostic = formatSchemaError(cause);
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic.endsWith("\n... and 2 more issue(s)")).toBe(true);
  });

  it("encodes lenient schemas as strict JSON", () => {
    const schema = fromLenientJson(Schema.Struct({ enabled: Schema.Boolean }));

    expect(Schema.encodeUnknownSync(schema)({ enabled: true })).toBe('{"enabled":true}');
  });

  it("decodes and encodes pretty JSON strings", () => {
    const schema = fromJsonStringPretty(Schema.Struct({ enabled: Schema.Boolean }));

    expect(Schema.decodeUnknownSync(schema)('{"enabled":true}')).toEqual({ enabled: true });
    expect(Schema.encodeUnknownSync(schema)({ enabled: true })).toBe('{\n  "enabled": true\n}');
  });
});
