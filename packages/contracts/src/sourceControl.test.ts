import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ChangeRequest,
  SourceControlCloneRepositoryInput,
  SourceControlProviderError,
  SourceControlRepositoryError,
} from "./sourceControl.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const decodeCloneRepositoryInput = Schema.decodeUnknownSync(SourceControlCloneRepositoryInput);
const encodeCloneRepositoryInput = Schema.encodeSync(SourceControlCloneRepositoryInput);
const decodeProviderError = Schema.decodeUnknownSync(SourceControlProviderError);
const encodeProviderError = Schema.encodeSync(SourceControlProviderError);
const decodeRepositoryError = Schema.decodeUnknownSync(SourceControlRepositoryError);
const encodeRepositoryError = Schema.encodeSync(SourceControlRepositoryError);

describe("source control schemas", () => {
  it("round-trips clone input with and without optional selection fields", () => {
    const minimal = decodeCloneRepositoryInput({ destinationPath: "/repo" });
    const selected = decodeCloneRepositoryInput({
      provider: "github",
      repository: "owner/repo",
      remoteUrl: "git@github.com:owner/repo.git",
      destinationPath: "/repo",
      protocol: "ssh",
    });

    expect(minimal.provider).toBeUndefined();
    expect(selected.protocol).toBe("ssh");
    expect(encodeCloneRepositoryInput(selected)).toEqual(selected);
  });

  it("reports invalid change-request state on decode and encode", () => {
    const invalid = {
      provider: "github",
      number: 1,
      title: "Change",
      url: "https://example.test/pull/1",
      baseRefName: "main",
      headRefName: "feature",
      state: "draft",
      updatedAt: { _tag: "None" },
    };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["state"]],
      containsTag: "AnyOf" as const,
    };
    expectDecodeFailure(ChangeRequest, invalid, expected);
    expectEncodeFailure(ChangeRequest, invalid, expected);
  });
});

describe("source control errors", () => {
  it("constructs and round-trips provider and repository failures", () => {
    const provider = new SourceControlProviderError({
      provider: "github",
      operation: "resolve pull request",
      cwd: "/repo",
      repository: "owner/repo",
      reference: "#42",
      detail: "not found",
    });
    const repository = new SourceControlRepositoryError({
      provider: "gitlab",
      operation: "publish",
      detail: "permission denied",
      cause: "forbidden",
    });

    expect(provider.message).toBe(
      "Source control provider github failed in resolve pull request: not found",
    );
    expect(repository.message).toBe(
      "Source control repository operation publish failed for gitlab: permission denied",
    );
    expect(decodeProviderError(encodeProviderError(provider))._tag).toBe(
      "SourceControlProviderError",
    );
    expect(decodeRepositoryError(encodeRepositoryError(repository))._tag).toBe(
      "SourceControlRepositoryError",
    );
  });

  it("reports invalid provider paths on decode and encode", () => {
    const invalid = {
      _tag: "SourceControlProviderError",
      provider: "forgejo",
      operation: "lookup",
      cwd: "/repo",
      detail: "unsupported",
    };
    const expectedPath = {
      paths: [["provider"]],
      containsTag: "AnyOf" as const,
    };
    const decodeExpected = {
      ...expectedPath,
      rootTag: "Encoding" as const,
    };
    const encodeExpected = { ...expectedPath, rootTag: "Composite" as const };
    expectDecodeFailure(SourceControlProviderError, invalid, decodeExpected);
    expectEncodeFailure(
      SourceControlProviderError,
      makeInvalidClassInstance(SourceControlProviderError.prototype, invalid),
      encodeExpected,
    );
  });
});
