import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  LegacyProviderOptionSelections,
  ProviderOptionDescriptorType,
  ProviderOptionSelections,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { expectEncodeFailure } from "./test/schemaAssertions.ts";

const decodeSelections = Schema.decodeUnknownSync(ProviderOptionSelections);
const encodeSelections = Schema.encodeUnknownSync(ProviderOptionSelections);
const decodeLegacySelections = Schema.decodeUnknownSync(LegacyProviderOptionSelections);
const encodeLegacySelections = Schema.encodeUnknownSync(LegacyProviderOptionSelections);
const decodeDescriptorType = Schema.decodeUnknownSync(ProviderOptionDescriptorType);
const decodeValue = Schema.decodeUnknownSync(ProviderOptionSelectionValue);

describe("ProviderOptionSelections", () => {
  const legacyInput = {
    "": "ignored",
    " reasoningEffort ": " high ",
    fastMode: false,
    whitespace: "   ",
    count: 3,
    nested: { value: true },
    absent: null,
  };
  const normalizedSelections = [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: false },
  ] as const;

  it("normalizes legacy values through the named compatibility schema", () => {
    expect(decodeLegacySelections(legacyInput)).toEqual(normalizedSelections);
  });

  it("decodes legacy values through the public selections union", () => {
    expect(decodeSelections(legacyInput)).toEqual(normalizedSelections);
  });

  it("encodes canonical values to the legacy object through the compatibility schema", () => {
    expect(
      encodeLegacySelections([
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({ reasoningEffort: "high", fastMode: true });
  });

  it("encodes canonical selections without restoring the legacy object shape", () => {
    expect(
      encodeSelections([
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("reports the invalid selection path during encoding", () => {
    expectEncodeFailure(ProviderOptionSelections, [{ id: "reasoningEffort", value: 3 }], {
      rootTag: "AnyOf",
      paths: [[0, "value"]],
      containsTag: "AnyOf",
    });
  });
});

describe("provider option literals", () => {
  it("keeps descriptor and selection alternatives stable", () => {
    expect(["select", "boolean"].map((value) => decodeDescriptorType(value))).toEqual([
      "select",
      "boolean",
    ]);
    expect(decodeValue("high")).toBe("high");
    expect(decodeValue(false)).toBe(false);
  });
});
