import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deepMerge, type DeepPartial } from "./Struct.ts";

const Settings = Schema.Struct({
  nested: Schema.Struct({
    enabled: Schema.Boolean,
    label: Schema.optional(Schema.String),
  }),
  retries: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  tags: Schema.Array(Schema.String),
});

const SettingsPatch = Schema.Struct({
  nested: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      label: Schema.optionalKey(Schema.String),
    }),
  ),
  retries: Schema.optionalKey(Schema.Number),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodeSettings = Schema.decodeUnknownSync(Settings);
const decodeSettingsPatch = Schema.decodeUnknownSync(SettingsPatch);
const decodeSettingsPatchExit = Schema.decodeUnknownExit(SettingsPatch);

const deepMergeRuntime = (current: unknown, patch: unknown): unknown =>
  deepMerge(current as Record<string, unknown>, patch as DeepPartial<Record<string, unknown>>);

describe("deepMerge", () => {
  it("merges schema-decoded nested and optional values while retaining defaults", () => {
    const current = decodeSettings({
      nested: { enabled: true },
      tags: ["stable"],
    });
    const patch = decodeSettingsPatch({
      nested: { label: "patched" },
    });

    expect(deepMerge(current, patch)).toEqual({
      nested: { enabled: true, label: "patched" },
      retries: 3,
      tags: ["stable"],
    });
    expect(current).toEqual({ nested: { enabled: true }, retries: 3, tags: ["stable"] });
  });

  it("replaces arrays and scalar values instead of merging their internals", () => {
    const current = decodeSettings({
      nested: { enabled: true, label: "original" },
      retries: 3,
      tags: ["one", "two"],
    });
    const patch = decodeSettingsPatch({
      nested: { enabled: false },
      retries: 0,
      tags: ["replacement"],
    });

    expect(deepMerge(current, patch)).toEqual({
      nested: { enabled: false, label: "original" },
      retries: 0,
      tags: ["replacement"],
    });
  });

  it("ignores explicit undefined patch values", () => {
    const current: {
      nested: { enabled: boolean; label: string | undefined };
      retries: number | undefined;
    } = { nested: { enabled: true, label: "original" }, retries: 3 };
    expect(
      deepMerge(current, {
        nested: { label: undefined },
        retries: undefined,
      }),
    ).toEqual(current);
  });

  it("keeps invalid patch data in the schema failure channel", () => {
    const decoded = decodeSettingsPatchExit({ retries: "many" });
    expect(Exit.isFailure(decoded)).toBe(true);
  });

  it("returns the patch for malformed non-object top-level runtime inputs", () => {
    const objectPatch = { replacement: true };
    expect(deepMergeRuntime(null, objectPatch)).toBe(objectPatch);
    expect(deepMergeRuntime({ retained: true }, null)).toBeNull();
    expect(deepMergeRuntime(42, "replacement")).toBe("replacement");
  });

  it("treats top-level arrays as replacement values", () => {
    const replacement = ["replacement"];
    expect(deepMergeRuntime([], replacement)).toBe(replacement);
    expect(deepMergeRuntime({ retained: true }, replacement)).toBe(replacement);
  });
});
