import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessHostname,
  HostProcessPlatform,
  isHostWindows,
} from "./hostProcess.ts";

describe("hostProcess", () => {
  it.effect("reads the current host identity and environment from the default references", () =>
    Effect.gen(function* () {
      expect(yield* HostProcessPlatform).toEqual(expect.any(String));
      expect(yield* HostProcessArchitecture).toEqual(expect.any(String));
      expect(yield* HostProcessHostname).toBe(NodeOS.hostname());
      expect(yield* HostProcessEnvironment).toBe(process.env);
    }),
  );

  it.effect("classifies injected Windows, Linux, and macOS hosts", () =>
    Effect.gen(function* () {
      expect(yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "win32"))).toBe(
        true,
      );
      expect(yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "linux"))).toBe(
        false,
      );
      expect(yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "darwin"))).toBe(
        false,
      );
    }),
  );
});
