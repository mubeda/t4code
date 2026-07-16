import { Exit, Option, Schema, SchemaIssue } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  BrowserNavigationTarget,
  PREVIEW_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClickInput,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationExecutionError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNavigateInput,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationOpenInput,
  PreviewAutomationOperation,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationResizeResult,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResizeInput,
  PreviewAutomationResponse,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationStreamEvent,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationTypeInput,
  PreviewAutomationUnavailableError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationWaitForInput,
  PreviewUrlResolution,
} from "./previewAutomation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeNavigationTarget = Schema.decodeUnknownSync(BrowserNavigationTarget);
const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeNavigateInput = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeClickInput = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeTypeInput = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePressInput = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScrollInput = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
const decodeWaitForInput = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);
const decodeOperation = Schema.decodeUnknownSync(PreviewAutomationOperation);
const decodeStreamEvent = Schema.decodeUnknownSync(PreviewAutomationStreamEvent);
const decodeStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const encodeStatus = Schema.encodeSync(PreviewAutomationStatus);
const decodeResizeResult = Schema.decodeUnknownSync(PreviewAutomationResizeResult);
const encodeResizeResult = Schema.encodeSync(PreviewAutomationResizeResult);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);
const encodeSnapshot = Schema.encodeSync(PreviewAutomationSnapshot);
const decodeRecordingStatus = Schema.decodeUnknownSync(PreviewAutomationRecordingStatus);
const encodeRecordingStatus = Schema.encodeSync(PreviewAutomationRecordingStatus);
const decodeRecordingArtifact = Schema.decodeUnknownSync(PreviewAutomationRecordingArtifact);
const encodeRecordingArtifact = Schema.encodeSync(PreviewAutomationRecordingArtifact);
const decodeHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const encodeHost = Schema.encodeSync(PreviewAutomationHost);
const decodeHostFocus = Schema.decodeUnknownSync(PreviewAutomationHostFocus);
const encodeHostFocus = Schema.encodeSync(PreviewAutomationHostFocus);
const decodeResponse = Schema.decodeUnknownSync(PreviewAutomationResponse);
const encodeResponse = Schema.encodeSync(PreviewAutomationResponse);
const decodeUrlResolution = Schema.decodeUnknownSync(PreviewUrlResolution);
const encodeUrlResolution = Schema.encodeSync(PreviewUrlResolution);
const decodeAutomationError = Schema.decodeUnknownSync(PreviewAutomationError);
const encodeAutomationError = Schema.encodeSync(PreviewAutomationError);

interface DecodeFailureExpectation {
  readonly rootTag: SchemaIssue.Issue["_tag"];
  readonly paths?: ReadonlyArray<ReadonlyArray<PropertyKey>>;
  readonly containsTag?: SchemaIssue.Issue["_tag"];
  readonly childIssueCount?: number;
}

const collectIssues = (issue: SchemaIssue.Issue): ReadonlyArray<SchemaIssue.Issue> => {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return [issue, ...collectIssues(issue.issue)];
    case "Composite":
    case "AnyOf":
      return [issue, ...issue.issues.flatMap((child) => collectIssues(child))];
    default:
      return [issue];
  }
};

const expectDecodeFailure = (
  schema: Schema.Decoder<unknown, never>,
  input: unknown,
  expected: DecodeFailureExpectation,
): void => {
  const exit = Schema.decodeUnknownExit(schema)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;

  const error = Exit.findErrorOption(exit);
  expect(Option.isSome(error)).toBe(true);
  if (!Option.isSome(error)) return;

  expect(Schema.isSchemaError(error.value)).toBe(true);
  if (!Schema.isSchemaError(error.value)) return;

  const issue = error.value.issue;
  const issues = collectIssues(issue);
  expect(issue._tag).toBe(expected.rootTag);
  for (const path of expected.paths ?? []) {
    const paths = issues.flatMap((nested) => (nested._tag === "Pointer" ? [[...nested.path]] : []));
    expect(paths).toContainEqual([...path]);
  }
  if (expected.containsTag !== undefined) {
    expect(issues.map((nested) => nested._tag)).toContain(expected.containsTag);
  }
  if (expected.childIssueCount !== undefined) {
    expect(issue._tag === "Composite" || issue._tag === "AnyOf").toBe(true);
    if (issue._tag === "Composite" || issue._tag === "AnyOf") {
      expect(issue.issues).toHaveLength(expected.childIssueCount);
    }
  }
};

describe("preview automation navigation", () => {
  it("keeps legacy operations stable and adds resize to current hosts", () => {
    const expectedV1Operations = [
      "status",
      "open",
      "navigate",
      "snapshot",
      "click",
      "type",
      "press",
      "scroll",
      "evaluate",
      "waitFor",
      "recordingStart",
      "recordingStop",
    ] as const;

    expect(PREVIEW_AUTOMATION_V1_OPERATIONS).toEqual(expectedV1Operations);
    expect(PREVIEW_AUTOMATION_OPERATIONS).toEqual([...expectedV1Operations, "resize"]);
    expect(PREVIEW_AUTOMATION_OPERATIONS.map((operation) => decodeOperation(operation))).toEqual(
      PREVIEW_AUTOMATION_OPERATIONS,
    );
  });

  it("decodes both direct and environment-relative targets", () => {
    expect(decodeNavigationTarget({ kind: "url", url: "https://example.com" })).toEqual({
      kind: "url",
      url: "https://example.com",
    });
    expect(
      decodeNavigationTarget({
        kind: "environment-port",
        port: 5173,
        protocol: "http",
        path: "/settings?tab=account",
      }),
    ).toEqual({
      kind: "environment-port",
      port: 5173,
      protocol: "http",
      path: "/settings?tab=account",
    });
    expectDecodeFailure(
      BrowserNavigationTarget,
      { kind: "environment-port", port: 0 },
      { rootTag: "AnyOf", paths: [["port"]], containsTag: "InvalidValue" },
    );
    expectDecodeFailure(
      BrowserNavigationTarget,
      { kind: "url", url: " https://example.com " },
      { rootTag: "AnyOf", paths: [["url"]], containsTag: "InvalidValue" },
    );
  });

  it("accepts coherent open options and rejects contradictory tab reuse", () => {
    expect(decodeOpenInput({})).toEqual({});
    expect(decodeOpenInput({ tabId: "tab-1", reuseExistingTab: true })).toMatchObject({
      tabId: "tab-1",
      reuseExistingTab: true,
    });
    expectDecodeFailure(
      PreviewAutomationOpenInput,
      { tabId: "tab-1", reuseExistingTab: false },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("requires exactly one navigation source", () => {
    expect(decodeNavigateInput({ url: "https://example.com", readiness: "load" })).toMatchObject({
      url: "https://example.com",
      readiness: "load",
    });
    expect(
      decodeNavigateInput({
        target: { kind: "environment-port", port: 5173 },
        readiness: "domContentLoaded",
        timeoutMs: 20_000,
      }),
    ).toMatchObject({ target: { kind: "environment-port", port: 5173 } });
    expectDecodeFailure(
      PreviewAutomationNavigateInput,
      {},
      {
        rootTag: "Composite",
        containsTag: "InvalidValue",
      },
    );
    expectDecodeFailure(
      PreviewAutomationNavigateInput,
      { url: "https://example.com", target: { kind: "environment-port", port: 5173 } },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });
});

describe("PreviewAutomationResizeInput", () => {
  it("decodes every coherent viewport mode", () => {
    expect(decodeResizeInput({ mode: "fill" })).toEqual({ mode: "fill" });
    expect(decodeResizeInput({ mode: "freeform", width: 1024, height: 768 })).toEqual({
      mode: "freeform",
      width: 1024,
      height: 768,
    });
    expect(
      decodeResizeInput({ mode: "preset", preset: "pixel-7", orientation: "landscape" }),
    ).toEqual({ mode: "preset", preset: "pixel-7", orientation: "landscape" });
  });

  it("rejects partial dimensions before mode-specific validation", () => {
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "freeform", width: 1024 },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("rejects fields that fill mode does not accept", () => {
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "fill", orientation: "portrait" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("requires freeform dimensions without preset metadata", () => {
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "freeform" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "freeform", width: 1024, height: 768, preset: "pixel-7" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("requires preset metadata without custom dimensions", () => {
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "preset" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "preset", preset: "pixel-7", width: 1024, height: 768 },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("rejects a freeform viewport whose area is too large", () => {
    expectDecodeFailure(
      PreviewAutomationResizeInput,
      { mode: "freeform", width: 3840, height: 3840 },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });
});

describe("preview automation interaction inputs", () => {
  it("decodes locator and coordinate clicks while trimming locators", () => {
    expect(decodeClickInput({ locator: "  role=button[name='Save']  " })).toEqual({
      locator: "role=button[name='Save']",
    });
    expect(decodeClickInput({ x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
  });

  it("rejects incomplete, missing, and competing click targets", () => {
    expectDecodeFailure(
      PreviewAutomationClickInput,
      { x: 100 },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
    expectDecodeFailure(
      PreviewAutomationClickInput,
      {},
      {
        rootTag: "Composite",
        containsTag: "InvalidValue",
      },
    );
    expectDecodeFailure(
      PreviewAutomationClickInput,
      { selector: "button", locator: "role=button" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
    expectDecodeFailure(
      PreviewAutomationClickInput,
      { locator: "role=button", x: 100, y: 200 },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("allows focused typing or one explicit target and rejects two targets", () => {
    expect(decodeTypeInput({ text: "hello" })).toEqual({ text: "hello" });
    expect(decodeTypeInput({ text: "hello", selector: "  textarea  ", clear: true })).toEqual({
      text: "hello",
      selector: "textarea",
      clear: true,
    });
    expectDecodeFailure(
      PreviewAutomationTypeInput,
      { text: "hello", selector: "textarea", locator: "role=textbox" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("validates keyboard and evaluation refinements", () => {
    expect(decodePressInput({ key: "Enter", modifiers: ["Control", "Shift"] })).toEqual({
      key: "Enter",
      modifiers: ["Control", "Shift"],
    });
    expectDecodeFailure(
      PreviewAutomationPressInput,
      { key: " Enter " },
      {
        rootTag: "Composite",
        paths: [["key"]],
        containsTag: "InvalidValue",
      },
    );

    expect(decodeEvaluateInput({ expression: "document.title", awaitPromise: true })).toEqual({
      expression: "document.title",
      awaitPromise: true,
    });
    expectDecodeFailure(
      PreviewAutomationEvaluateInput,
      { expression: " ".repeat(2) },
      { rootTag: "Composite", paths: [["expression"]], containsTag: "InvalidValue" },
    );
  });

  it("accepts either scroll delta and rejects missing deltas or competing targets", () => {
    expect(decodeScrollInput({ deltaX: 20 })).toEqual({ deltaX: 20 });
    expect(decodeScrollInput({ deltaY: -40, locator: "main" })).toEqual({
      deltaY: -40,
      locator: "main",
    });
    expectDecodeFailure(
      PreviewAutomationScrollInput,
      {},
      {
        rootTag: "Composite",
        containsTag: "InvalidValue",
      },
    );
    expectDecodeFailure(
      PreviewAutomationScrollInput,
      { deltaY: 10, selector: "main", locator: "main" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });

  it("accepts wait conditions independently or together", () => {
    const cases = [
      { selector: "#ready" },
      { locator: "role=button[name='Ready']" },
      { text: "Ready" },
      { urlIncludes: "/ready" },
      { selector: "#ready", text: "Ready", urlIncludes: "/ready" },
    ];
    for (const input of cases) {
      expect(decodeWaitForInput(input)).toMatchObject(input);
    }
  });

  it("rejects empty waits and competing selector formats", () => {
    expectDecodeFailure(
      PreviewAutomationWaitForInput,
      {},
      {
        rootTag: "Composite",
        containsTag: "InvalidValue",
      },
    );
    expectDecodeFailure(
      PreviewAutomationWaitForInput,
      { selector: "#ready", locator: "text=Ready" },
      { rootTag: "Composite", containsTag: "InvalidValue" },
    );
  });
});

describe("preview automation status and viewport results", () => {
  it("round-trips legacy and viewport-aware status payloads", () => {
    const statuses = [
      {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      },
      {
        available: true,
        visible: true,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        loading: false,
        viewportSetting: {
          _tag: "preset" as const,
          presetId: "pixel-7" as const,
          width: 412,
          height: 915,
        },
        viewport: { width: 412, height: 915 },
      },
    ];

    for (const status of statuses) {
      expect(encodeStatus(decodeStatus(status))).toEqual(status);
    }
  });

  it("rejects a non-boolean availability flag at its field pointer", () => {
    expectDecodeFailure(
      PreviewAutomationStatus,
      {
        available: "yes",
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      },
      { rootTag: "Composite", paths: [["available"]], containsTag: "InvalidType" },
    );
  });

  it("round-trips an applied resize result", () => {
    const result = {
      tabId: "tab-1",
      setting: { _tag: "freeform" as const, width: 1024, height: 768 },
      viewport: { width: 1024, height: 768 },
    };

    expect(encodeResizeResult(decodeResizeResult(result))).toEqual(result);
  });

  it("rejects a non-positive rendered viewport width through nested pointers", () => {
    expectDecodeFailure(
      PreviewAutomationResizeResult,
      {
        tabId: "tab-1",
        setting: { _tag: "fill" },
        viewport: { width: 0, height: 768 },
      },
      {
        rootTag: "Composite",
        paths: [["viewport"], ["width"]],
        containsTag: "InvalidValue",
      },
    );
  });
});

describe("preview automation snapshot and recording schemas", () => {
  const snapshot = {
    url: "https://example.com",
    title: "Example",
    loading: false,
    visibleText: "Ready Save",
    interactiveElements: [
      {
        tag: "button",
        role: "button",
        name: "Save",
        selector: "role=button[name='Save']",
        x: 24,
        y: 48,
        width: 120,
        height: 40,
      },
    ],
    accessibilityTree: { role: "document", children: [{ role: "button", name: "Save" }] },
    consoleEntries: [
      { level: "info", text: "ready", timestamp: "2026-07-13T12:00:00.000Z", source: "app.ts" },
    ],
    networkEntries: [
      {
        url: "https://example.com/api/status",
        method: "GET",
        status: 200,
        failed: false,
        timestamp: "2026-07-13T12:00:01.000Z",
      },
    ],
    actionTimeline: [
      {
        id: "action-1",
        action: "click",
        status: "succeeded" as const,
        startedAt: "2026-07-13T12:00:02.000Z",
        completedAt: "2026-07-13T12:00:03.000Z",
      },
    ],
    screenshot: { mimeType: "image/png" as const, data: "iVBORw0KGgo=", width: 1280, height: 720 },
  };

  it("round-trips a snapshot with every nested collection populated", () => {
    expect(encodeSnapshot(decodeSnapshot(snapshot))).toEqual(snapshot);
  });

  it("rejects a non-PNG screenshot through nested pointers", () => {
    expectDecodeFailure(
      PreviewAutomationSnapshot,
      { ...snapshot, screenshot: { ...snapshot.screenshot, mimeType: "image/jpeg" } },
      {
        rootTag: "Composite",
        paths: [["screenshot"], ["mimeType"]],
        containsTag: "InvalidType",
      },
    );
  });

  it("round-trips active and inactive recording status payloads", () => {
    const statuses = [
      { tabId: "tab-1", recording: true, startedAt: "2026-07-13T12:00:00.000Z" },
      { tabId: "tab-1", recording: false, startedAt: null },
    ];

    for (const status of statuses) {
      expect(encodeRecordingStatus(decodeRecordingStatus(status))).toEqual(status);
    }
  });

  it("rejects a non-boolean recording flag at its field pointer", () => {
    expectDecodeFailure(
      PreviewAutomationRecordingStatus,
      { tabId: "tab-1", recording: "yes", startedAt: null },
      { rootTag: "Composite", paths: [["recording"]], containsTag: "InvalidType" },
    );
  });

  it("round-trips recording artifact metadata", () => {
    const artifact = {
      id: "recording-1",
      tabId: "tab-1",
      path: "recordings/recording-1.webm",
      mimeType: "video/webm",
      sizeBytes: 65_536,
      createdAt: "2026-07-13T12:05:00.000Z",
    };

    expect(encodeRecordingArtifact(decodeRecordingArtifact(artifact))).toEqual(artifact);
  });

  it("rejects a fractional artifact size at its field pointer", () => {
    expectDecodeFailure(
      PreviewAutomationRecordingArtifact,
      {
        id: "recording-1",
        tabId: "tab-1",
        path: "recordings/recording-1.webm",
        mimeType: "video/webm",
        sizeBytes: 1.5,
        createdAt: "2026-07-13T12:05:00.000Z",
      },
      { rootTag: "Composite", paths: [["sizeBytes"]], containsTag: "InvalidValue" },
    );
  });
});

describe("preview automation host and response schemas", () => {
  it("round-trips legacy and capability-advertising hosts", () => {
    const hosts = [
      { clientId: "legacy-client", environmentId: "environment-1" },
      {
        clientId: "current-client",
        environmentId: "environment-1",
        supportedOperations: ["status" as const, "resize" as const],
      },
    ];

    for (const host of hosts) {
      expect(encodeHost(decodeHost(host))).toEqual(host);
    }
  });

  it("rejects an unadvertised host operation through array pointers", () => {
    expectDecodeFailure(
      PreviewAutomationHost,
      {
        clientId: "client-1",
        environmentId: "environment-1",
        supportedOperations: ["launch"],
      },
      {
        rootTag: "Composite",
        paths: [["supportedOperations"], [0]],
        containsTag: "AnyOf",
      },
    );
  });

  it("trims and round-trips host focus identity", () => {
    const decoded = decodeHostFocus({
      clientId: " client-1 ",
      environmentId: "environment-1",
      connectionId: " connection-1 ",
      focused: true,
    });

    expect(encodeHostFocus(decoded)).toEqual({
      clientId: "client-1",
      environmentId: "environment-1",
      connectionId: "connection-1",
      focused: true,
    });
  });

  it("rejects an overlong host connection identifier", () => {
    expectDecodeFailure(
      PreviewAutomationHostFocus,
      {
        clientId: "client-1",
        environmentId: "environment-1",
        connectionId: "x".repeat(65),
        focused: true,
      },
      { rootTag: "Composite", paths: [["connectionId"]], containsTag: "InvalidValue" },
    );
  });

  it("round-trips successful and failed response envelopes", () => {
    const responses = [
      {
        clientId: "client-1",
        connectionId: "connection-1",
        requestId: "request-1",
        ok: true,
        result: { title: "Example" },
      },
      {
        clientId: "client-1",
        connectionId: "connection-1",
        requestId: "request-2",
        ok: false,
        error: {
          _tag: "RemoteFailure",
          message: "Remote operation failed.",
          detail: { retryable: false },
        },
      },
    ];

    for (const response of responses) {
      expect(encodeResponse(decodeResponse(response))).toEqual(response);
    }
  });

  it("rejects a blank response request identifier at its field pointer", () => {
    expectDecodeFailure(
      PreviewAutomationResponse,
      { clientId: "client-1", connectionId: "connection-1", requestId: "   ", ok: true },
      { rootTag: "Composite", paths: [["requestId"]], containsTag: "InvalidValue" },
    );
  });
});

describe("PreviewUrlResolution", () => {
  it("round-trips direct and private-network resolutions", () => {
    const resolutions = [
      {
        requestedUrl: "https://example.com",
        resolvedUrl: "https://example.com/",
        resolutionKind: "direct" as const,
        environmentId: "environment-1",
      },
      {
        requestedUrl: "localhost:5173",
        resolvedUrl: "http://127.0.0.1:5173/",
        resolutionKind: "direct-private-network" as const,
        environmentId: "environment-1",
      },
    ];

    for (const resolution of resolutions) {
      expect(encodeUrlResolution(decodeUrlResolution(resolution))).toEqual(resolution);
    }
  });

  it("rejects an unknown resolution kind at its field pointer", () => {
    expectDecodeFailure(
      PreviewUrlResolution,
      {
        requestedUrl: "https://example.com",
        resolvedUrl: "https://example.com/",
        resolutionKind: "proxy",
        environmentId: "environment-1",
      },
      { rootTag: "Composite", paths: [["resolutionKind"]], containsTag: "AnyOf" },
    );
  });
});

describe("PreviewAutomationStreamEvent", () => {
  it("decodes connected and request alternatives with optional tab metadata", () => {
    expect(decodeStreamEvent({ type: "connected", connectionId: " connection-1 " })).toEqual({
      type: "connected",
      connectionId: "connection-1",
    });

    expect(
      decodeStreamEvent({
        type: "request",
        connectionId: "connection-1",
        request: {
          requestId: "request-1",
          threadId: "thread-1",
          tabId: "tab-1",
          tabIdExplicit: true,
          operation: "click",
          input: { locator: "role=button" },
          timeoutMs: 1000,
        },
      }),
    ).toMatchObject({ type: "request", request: { tabIdExplicit: true, operation: "click" } });
  });
});

describe("PreviewAutomationError", () => {
  it("constructs and round-trips every public error alternative", () => {
    const cause = new Error("remote failure");
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const scope = {
      operation: "click" as const,
      environmentId,
      threadId,
      providerSessionId: "provider-session-1",
      providerInstanceId,
    };
    const request = {
      ...scope,
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      timeoutMs: 1000,
    };
    const remote = {
      ...request,
      remoteTag: "RemoteError",
      remoteMessageLength: 12,
      remoteDetailKind: "object" as const,
      cause,
    };
    const cases = [
      {
        error: new PreviewAutomationUnavailableError({
          capability: "preview",
          environmentId: scope.environmentId,
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        }),
        message: "MCP credential does not grant the preview capability.",
      },
      {
        error: new PreviewAutomationNoAvailableHostError(scope),
        message: "No preview automation host is available for click in environment environment-1.",
      },
      {
        error: new PreviewAutomationUnsupportedClientError(remote),
        message: "Preview automation client client-1 does not support click.",
      },
      {
        error: new PreviewAutomationTabNotFoundError({ ...remote, tabId: "tab-1" }),
        message: "Preview tab tab-1 was not found for click.",
      },
      {
        error: new PreviewAutomationTimeoutError(request),
        message: "Preview automation click timed out after 1000ms.",
      },
      {
        error: new PreviewAutomationControlInterruptedError(remote),
        message: "Preview automation click was interrupted on client client-1.",
      },
      {
        error: new PreviewAutomationExecutionError(remote),
        message: "Preview automation click failed on client client-1.",
      },
      {
        error: new PreviewAutomationInvalidSelectorError({
          ...remote,
          selectorKind: "locator",
          selectorLength: 18,
        }),
        message: "Preview automation click received an invalid locator (18 characters).",
      },
      {
        error: new PreviewAutomationTargetNotEditableError({
          ...remote,
          selectorKind: "focused-element",
        }),
        message: "Preview automation click requires an editable focused element.",
      },
      {
        error: new PreviewAutomationResultTooLargeError({ ...remote, maximumBytes: 4096 }),
        message: "Preview automation click produced a result larger than 4096 bytes.",
      },
      {
        error: new PreviewAutomationClientDisconnectedError(request),
        message: "Preview automation client client-1 disconnected during click.",
      },
      {
        error: new PreviewAutomationRequestQueueClosedError(request),
        message: "Preview automation client client-1 stopped accepting click requests.",
      },
      {
        error: new PreviewAutomationRemoteUnavailableError(remote),
        message: "Preview automation click is unavailable on client client-1.",
      },
      {
        error: new PreviewAutomationMalformedResponseError(request),
        message: "Preview automation client client-1 returned a malformed response for click.",
      },
    ];

    for (const { error, message } of cases) {
      expect(error.message).toBe(message);
      const decoded = decodeAutomationError(encodeAutomationError(error));
      expect(decoded._tag).toBe(error._tag);
      expect(decoded.message).toBe(message);
    }
  });

  it("describes absent tabs and generic selector, editability, and size failures", () => {
    const cause = new Error("remote failure");
    const remote = {
      operation: "type" as const,
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      timeoutMs: 1000,
      remoteTag: "RemoteError",
      remoteMessageLength: 12,
      cause,
    };

    expect(new PreviewAutomationTabNotFoundError(remote).message).toBe(
      "No active preview tab was found for type.",
    );
    expect(new PreviewAutomationInvalidSelectorError(remote).message).toBe(
      "Preview automation type received an invalid selector.",
    );
    expect(new PreviewAutomationTargetNotEditableError(remote).message).toBe(
      "Preview automation type requires an editable target.",
    );
    expect(
      new PreviewAutomationTargetNotEditableError({
        ...remote,
        selectorKind: "selector",
        selectorLength: 9,
      }).message,
    ).toBe("Preview automation type requires an editable selector (9 characters).");
    expect(new PreviewAutomationResultTooLargeError(remote).message).toBe(
      "Preview automation type produced a result that is too large.",
    );
  });
});
