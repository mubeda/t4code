/**
 * Behavior tests for the pairing route surfaces.
 *
 * Instrumented-hooks SSR pattern (see FilePreviewPanel.test.tsx /
 * ProviderInstanceCard.test.tsx): `useState`/`useRef` are replaced so state can
 * be seeded per scenario, setter calls recorded, and `useEffect` bodies captured
 * and run manually. `useCallback` / `startTransition` stay real. The intrinsic
 * `<form onSubmit>` handler is unreachable through a static-markup string, so the
 * credential submit path is exercised through the auto-submit effect instead;
 * leaf UI (Button/Input) is capture-mocked so their handler props are reachable.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import type { AuthSessionState } from "@t4code/contracts";

const harness = vi.hoisted(() => {
  type Matcher = (initial: unknown) => boolean;
  const state = {
    stateSeeds: [] as Array<{ match: Matcher; value: unknown }>,
    setStateCalls: [] as Array<{ initial: unknown; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    refs: [] as Array<{ current: unknown }>,
    reset() {
      state.stateSeeds.length = 0;
      state.setStateCalls.length = 0;
      state.effects.length = 0;
      state.refs.length = 0;
    },
    seedState(match: Matcher, value: unknown) {
      state.stateSeeds.push({ match, value });
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of state.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
  };
  return state;
});

const ui = vi.hoisted(() => {
  const registry = {
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    reset() {
      registry.entries.length = 0;
    },
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        registry.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      return registry.entries
        .filter((entry) => entry.kind === kind && (predicate?.(entry.props) ?? true))
        .map((entry) => entry.props);
    },
    find(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      const found = registry.entries.find(
        (entry) => entry.kind === kind && (predicate?.(entry.props) ?? true),
      )?.props;
      if (!found) throw new Error(`No recorded "${kind}" element matched`);
      return found;
    },
  };
  return registry;
});

const testState = vi.hoisted(() => ({
  pairingToken: null as string | null,
  submit: vi.fn<(credential: string) => Promise<void>>(),
  stripCalls: 0,
  hostedRequest: null as { host: string; token: string; label: string } | null,
  connect: vi.fn<(input: unknown) => Promise<{ _tag: string; error?: unknown }>>(),
  squashError: null as unknown,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const seedIndex = harness.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? harness.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      harness.setStateCalls.push({ initial: resolved, next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  };
  const useRef = (initial?: unknown) => {
    const ref = { current: initial ?? null };
    harness.refs.push(ref);
    return ref;
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useRef: useRef as typeof actual.useRef,
  };
});

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => testState.pairingToken,
  stripPairingTokenFromUrl: () => {
    testState.stripCalls += 1;
  },
  submitServerAuthCredential: (credential: string) => testState.submit(credential),
}));

vi.mock("../../hostedPairing", () => ({
  readHostedPairingRequest: () => testState.hostedRequest,
}));

vi.mock("../../connection/onboarding", () => ({
  connectPairing: { label: "connectPairing" },
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => testState.squashError,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => testState.connect(input),
}));

vi.mock("../../branding", () => ({
  APP_DISPLAY_NAME: "T4Code",
}));

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    ui.record("Button", props);
    return (
      <button type="button" disabled={props.disabled as boolean | undefined}>
        {props.children as ReactNode}
      </button>
    );
  },
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => {
    ui.record("Input", props);
    return <input value={props.value as string | undefined} readOnly />;
  },
}));

import {
  PairingPendingSurface,
  PairingRouteSurface,
  HostedPairingRouteSurface,
} from "./PairingRouteSurface";

function auth(bootstrapMethods: ReadonlyArray<string>): AuthSessionState["auth"] {
  return { bootstrapMethods } as unknown as AuthSessionState["auth"];
}

function render(element: React.ReactElement): string {
  ui.reset();
  harness.setStateCalls.length = 0;
  harness.effects.length = 0;
  harness.refs.length = 0;
  return renderToStaticMarkup(element);
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let reloadSpy: ReturnType<typeof vi.fn>;
let locationHref: string;

beforeEach(() => {
  harness.reset();
  ui.reset();
  testState.pairingToken = null;
  testState.submit.mockReset().mockResolvedValue(undefined);
  testState.stripCalls = 0;
  testState.hostedRequest = null;
  testState.connect.mockReset().mockResolvedValue({ _tag: "Success" });
  testState.squashError = new Error("connect failed");

  reloadSpy = vi.fn();
  locationHref = "";
  vi.stubGlobal("window", {
    location: {
      reload: reloadSpy,
      get href() {
        return locationHref;
      },
      set href(value: string) {
        locationHref = value;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PairingPendingSurface", () => {
  it("renders the app name and the validating copy", () => {
    const markup = renderToStaticMarkup(<PairingPendingSurface />);
    expect(markup).toContain("T4Code");
    expect(markup).toContain("Pairing with this environment");
    expect(markup).toContain("Validating the pairing link");
  });
});

describe("PairingRouteSurface markup", () => {
  it("describes a one-time-token gate and supported methods", () => {
    const markup = render(
      <PairingRouteSurface auth={auth(["one-time-token"])} onAuthenticated={vi.fn()} />,
    );
    expect(markup).toContain("Enter a pairing token to start a session");
    expect(markup).toContain("This environment accepts one-time pairing tokens");
    expect(markup).toContain("Continue");
    expect(markup).toContain("Reload app");
  });

  it("describes a desktop-bootstrap gate", () => {
    const markup = render(
      <PairingRouteSurface auth={auth(["desktop-bootstrap"])} onAuthenticated={vi.fn()} />,
    );
    expect(markup).toContain("expects a trusted pairing credential");
    expect(markup).toContain("This environment is desktop-managed");
  });

  it("describes a combined desktop + one-time-token gate", () => {
    const markup = render(
      <PairingRouteSurface
        auth={auth(["desktop-bootstrap", "one-time-token"])}
        onAuthenticated={vi.fn()}
      />,
    );
    expect(markup).toContain(
      "Desktop-managed pairing and one-time pairing tokens are both accepted",
    );
  });

  it("prefills the token from the url and shows an initial error", () => {
    testState.pairingToken = "seed-token";
    const markup = render(
      <PairingRouteSurface
        auth={auth([])}
        initialErrorMessage="Bad link"
        onAuthenticated={vi.fn()}
      />,
    );
    // credential state initializer used the peeked token.
    expect(ui.find("Input").value).toBe("seed-token");
    expect(markup).toContain("Bad link");
  });

  it("shows the submitting state when isSubmitting is seeded true", () => {
    harness.seedState((initial) => initial === false, true);
    const markup = render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    expect(markup).toContain("Pairing...");
  });

  it("records credential edits through the input onChange", () => {
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    const input = ui.find("Input");
    (input.onChange as (event: unknown) => void)({ currentTarget: { value: "typed" } });
    expect(harness.setStateCalls.some((call) => call.applied === "typed")).toBe(true);
  });

  it("reloads the app from the reload button", () => {
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    const reload = ui.find("Button", (props) => props.children === "Reload app");
    (reload.onClick as () => void)();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});

describe("PairingRouteSurface auto-submit effect", () => {
  it("auto-submits a peeked token and authenticates on success", async () => {
    testState.pairingToken = "auto-token";
    const onAuthenticated = vi.fn();
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={onAuthenticated} />);

    harness.runEffects();
    expect(testState.stripCalls).toBe(1);
    expect(testState.submit).toHaveBeenCalledWith("auto-token");
    await flush();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    // isSubmitting toggled true then false.
    expect(harness.setStateCalls.some((call) => call.applied === true)).toBe(true);
    expect(harness.setStateCalls.some((call) => call.applied === false)).toBe(true);
  });

  it("surfaces an Error message when the credential is rejected", async () => {
    testState.pairingToken = "auto-token";
    testState.submit.mockRejectedValue(new Error("token expired"));
    const onAuthenticated = vi.fn();
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={onAuthenticated} />);

    harness.runEffects();
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "token expired")).toBe(true);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("uses a string rejection verbatim as the error message", async () => {
    testState.pairingToken = "auto-token";
    testState.submit.mockRejectedValue("plain string failure");
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    harness.runEffects();
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "plain string failure")).toBe(
      true,
    );
  });

  it("falls back to a generic message for empty or non-error rejections", async () => {
    testState.pairingToken = "auto-token";
    testState.submit.mockRejectedValue(new Error("   "));
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    harness.runEffects();
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "Authentication failed.")).toBe(
      true,
    );

    harness.setStateCalls.length = 0;
    testState.submit.mockRejectedValue({ not: "an error" });
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    harness.runEffects();
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "Authentication failed.")).toBe(
      true,
    );
  });

  it("does nothing when there is no token to auto-submit", () => {
    testState.pairingToken = null;
    render(<PairingRouteSurface auth={auth([])} onAuthenticated={vi.fn()} />);
    harness.runEffects();
    expect(testState.submit).not.toHaveBeenCalled();
    expect(testState.stripCalls).toBe(0);
  });
});

describe("HostedPairingRouteSurface", () => {
  const request = { host: "https://backend.example", token: "hosted-token", label: "My Backend" };

  it("reports a missing pairing link when no request is present", () => {
    testState.hostedRequest = null;
    const markup = render(<HostedPairingRouteSurface />);
    expect(markup).toContain("Pairing failed");
    expect(markup).toContain("missing its backend host or token");
    // No host row and no retry button.
    expect(ui.filter("Button", (props) => props.children === "Try again")).toHaveLength(0);
  });

  it("shows the host row and the pairing spinner while connecting", () => {
    testState.hostedRequest = request;
    const markup = render(<HostedPairingRouteSurface />);
    expect(markup).toContain("Pairing backend");
    expect(markup).toContain("https://backend.example");
    expect(markup).toContain("Pairing...");
  });

  it("connects on mount and marks the backend paired on success", async () => {
    testState.hostedRequest = request;
    testState.connect.mockResolvedValue({ _tag: "Success" });
    render(<HostedPairingRouteSurface />);

    harness.runEffects();
    expect(testState.stripCalls).toBe(1);
    expect(testState.connect).toHaveBeenCalledWith({
      host: request.host,
      pairingCode: request.token,
    });
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "paired")).toBe(true);
    expect(
      harness.setStateCalls.some(
        (call) => typeof call.applied === "string" && call.applied.includes("My Backend"),
      ),
    ).toBe(true);
  });

  it("marks an error and enables retry when the connection fails", async () => {
    testState.hostedRequest = request;
    testState.connect.mockResolvedValue({ _tag: "Failure", error: "nope" });
    testState.squashError = new Error("backend unreachable");
    render(<HostedPairingRouteSurface />);

    harness.runEffects();
    await flush();
    expect(harness.setStateCalls.some((call) => call.applied === "error")).toBe(true);
    expect(harness.setStateCalls.some((call) => call.applied === true)).toBe(true);
    expect(
      harness.setStateCalls.some(
        (call) => typeof call.applied === "string" && call.applied.includes("backend unreachable"),
      ),
    ).toBe(true);
  });

  it("renders the paired state with an Open app button that navigates home", () => {
    testState.hostedRequest = request;
    harness.seedState((initial) => initial === "pairing", "paired");
    render(<HostedPairingRouteSurface />);
    const openApp = ui.find("Button", (props) => props.children === "Open app");
    (openApp.onClick as () => void)();
    expect(locationHref).toBe("/");
  });

  it("retries the hosted pairing request from the try-again button", async () => {
    testState.hostedRequest = request;
    harness.seedState((initial) => initial === "pairing", "error");
    harness.seedState((initial) => initial === false, true);
    render(<HostedPairingRouteSurface />);

    const retry = ui.find("Button", (props) => props.children === "Try again");
    testState.connect.mockClear();
    (retry.onClick as () => void)();
    await flush();
    expect(testState.connect).toHaveBeenCalledTimes(1);
  });

  it("rejects a token that was already submitted", async () => {
    testState.hostedRequest = request;
    render(<HostedPairingRouteSurface />);
    // tokenSubmittedRef is the third captured ref; force it to true.
    const tokenSubmittedRef = harness.refs[2]!;
    tokenSubmittedRef.current = true;

    harness.runEffects();
    await flush();
    expect(
      harness.setStateCalls.some(
        (call) => typeof call.applied === "string" && call.applied.includes("already submitted"),
      ),
    ).toBe(true);
    expect(testState.connect).not.toHaveBeenCalled();
  });
});
