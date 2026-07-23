import {
  EnvironmentId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t4code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  applyServerConfigProjection,
  createServerEnvironmentAtoms,
  projectServerWelcome,
} from "./server.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
} as unknown as ServerConfig;

describe("server state projection", () => {
  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = { ...CONFIG.settings };
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });
});

describe("server provider usage commands", () => {
  it.effect("sends reset requests to the selected environment and returns the decoded result", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-reset");
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      const expected = {
        outcome: "reset" as const,
        usage: {
          readAt: DateTime.makeUnsafe("2026-07-22T12:00:00.000Z"),
          isFetching: false,
          providers: [],
        },
      };
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.serverConsumeCodexRateLimitReset]: (input: unknown) =>
              Effect.sync(() => {
                calls.push({ method: WS_METHODS.serverConsumeCodexRateLimitReset, input });
                return expected;
              }),
          },
        } as never),
      );
      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId, label: "Reset environment" },
        session,
      } as never);
      const selectedEnvironments: string[] = [];
      const run: EnvironmentRegistry["Service"]["run"] = (selectedEnvironmentId, effect) => {
        selectedEnvironments.push(selectedEnvironmentId);
        return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
      };
      const environmentRegistry = EnvironmentRegistry.of({
        run,
      } as never);
      const atoms = createServerEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
        { initialConfigValueAtom: () => Atom.make(null) },
      );
      const command = atoms.consumeCodexRateLimitReset;
      expect(command).toBeDefined();
      const atomRegistry = AtomRegistry.make();

      const result = yield* Effect.promise(() =>
        command.run(atomRegistry, {
          environmentId,
          input: { requestId: "request-123" },
        }),
      );

      expect(selectedEnvironments).toEqual([environmentId]);
      expect(calls).toEqual([
        {
          method: "server.consumeCodexRateLimitReset",
          input: { requestId: "request-123" },
        },
      ]);
      expect(result).toMatchObject({ _tag: "Success", value: expected, waiting: false });
      atomRegistry.dispose();
    }),
  );

  it.effect("shares one active reset request within the same environment", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-single-flight");
      const latch = Latch.makeUnsafe();
      let executions = 0;
      const expected = {
        outcome: "nothingToReset" as const,
        usage: {
          readAt: DateTime.makeUnsafe("2026-07-22T12:00:00.000Z"),
          isFetching: false,
          providers: [],
        },
      };
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.serverConsumeCodexRateLimitReset]: () =>
              Effect.sync(() => {
                executions += 1;
              }).pipe(Effect.andThen(latch.await), Effect.as(expected)),
          },
        } as never),
      );
      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId, label: "Single-flight environment" },
        session,
      } as never);
      const run: EnvironmentRegistry["Service"]["run"] = (_selectedEnvironmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.of({
        run,
      } as never);
      const atoms = createServerEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
        { initialConfigValueAtom: () => Atom.make(null) },
      );
      const atomRegistry = AtomRegistry.make();

      const first = atoms.consumeCodexRateLimitReset.run(atomRegistry, {
        environmentId,
        input: { requestId: "request-1" },
      });
      const second = atoms.consumeCodexRateLimitReset.run(atomRegistry, {
        environmentId,
        input: { requestId: "request-2" },
      });
      yield* Effect.yieldNow;
      latch.openUnsafe();
      const results = yield* Effect.promise(() => Promise.all([first, second]));

      expect(executions).toBe(1);
      expect(results).toEqual([
        expect.objectContaining({ _tag: "Success", value: expected }),
        expect.objectContaining({ _tag: "Success", value: expected }),
      ]);
      atomRegistry.dispose();
    }),
  );
});
