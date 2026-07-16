import { Exit, Option, SchemaIssue } from "effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

interface FailureExpectation {
  readonly rootTag: SchemaIssue.Issue["_tag"];
  readonly paths?: ReadonlyArray<ReadonlyArray<PropertyKey>>;
  readonly containsTag?: SchemaIssue.Issue["_tag"];
}

const collectIssues = (issue: SchemaIssue.Issue): ReadonlyArray<SchemaIssue.Issue> => {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return [issue, ...collectIssues(issue.issue)];
    case "Composite":
    case "AnyOf":
      return [issue, ...issue.issues.flatMap(collectIssues)];
    default:
      return [issue];
  }
};

const collectPointerPaths = (
  issue: SchemaIssue.Issue,
  prefix: ReadonlyArray<PropertyKey> = [],
): ReadonlyArray<ReadonlyArray<PropertyKey>> => {
  switch (issue._tag) {
    case "Pointer": {
      const path = [...prefix, ...issue.path];
      const nested = collectPointerPaths(issue.issue, path);
      return nested.length === 0 ? [path] : nested;
    }
    case "Filter":
    case "Encoding":
      return collectPointerPaths(issue.issue, prefix);
    case "Composite":
    case "AnyOf": {
      const nested = issue.issues.flatMap((child) => collectPointerPaths(child, prefix));
      return nested.length === 0 && prefix.length > 0 ? [prefix] : nested;
    }
    default:
      return prefix.length > 0 ? [prefix] : [];
  }
};

const expectSchemaFailure = (
  exit: Exit.Exit<unknown, Schema.SchemaError>,
  expected: FailureExpectation,
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;

  const error = Exit.findErrorOption(exit);
  expect(Option.isSome(error)).toBe(true);
  if (!Option.isSome(error)) return;

  expect(Schema.isSchemaError(error.value)).toBe(true);
  if (!Schema.isSchemaError(error.value)) return;

  const issue = error.value.issue;
  const issues = collectIssues(issue);
  const actualPaths = collectPointerPaths(issue);
  expect(issue._tag).toBe(expected.rootTag);
  for (const path of expected.paths ?? []) {
    expect(actualPaths).toContainEqual([...path]);
  }
  if (expected.containsTag !== undefined) {
    expect(issues.map((nested) => nested._tag)).toContain(expected.containsTag);
  }
};

export const expectDecodeFailure = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  expected: FailureExpectation,
): void => {
  expectSchemaFailure(Schema.decodeUnknownExit(schema as never)(input), expected);
};

export const expectEncodeFailure = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  expected: FailureExpectation,
): void => {
  expectSchemaFailure(Schema.encodeUnknownExit(schema as never)(input), expected);
};

export const makeInvalidClassInstance = <A extends object>(
  prototype: A,
  fields: Readonly<Record<PropertyKey, unknown>>,
): A => Object.assign(Object.create(prototype) as A, fields);
