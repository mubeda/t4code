import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderSessionDefault,
  type ServerSettings,
} from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderInstanceUpdatePatch,
  createProviderSessionDefaultsDraft,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function defaultValue(model: string): ProviderSessionDefault {
  return { model };
}

function defaults(
  codex = "codex-initial",
  claude = "claude-initial",
): ServerSettings["providerSessionDefaults"] {
  return {
    [CODEX]: defaultValue(codex),
    [CLAUDE]: defaultValue(claude),
  };
}

describe("createProviderSessionDefaultsDraft", () => {
  it("keeps S2 over an acknowledged S1 snapshot and clears at the exact S2 acknowledgment", () => {
    const initial = defaults();
    const draft = createProviderSessionDefaultsDraft(initial);
    const submittedS1 = draft.submit(CODEX, defaultValue("codex-s1"));
    const submittedS2 = draft.submit(CODEX, defaultValue("codex-s2"));

    expect(draft.reconcile(submittedS1)).toEqual(submittedS2);
    expect(draft.reconcile(submittedS1)).toEqual(submittedS2);
    expect(draft.reconcile(submittedS2)).toEqual(submittedS2);
  });

  it("accepts a rollback or divergent same-driver authority instead of masking it", () => {
    const initial = defaults();
    const rollbackDraft = createProviderSessionDefaultsDraft(initial);
    rollbackDraft.submit(CODEX, defaultValue("codex-pending"));
    expect(rollbackDraft.reconcile(initial)).toEqual(initial);

    const externalDraft = createProviderSessionDefaultsDraft(initial);
    externalDraft.submit(CODEX, defaultValue("codex-pending"));
    const external = defaults("codex-external");
    expect(externalDraft.reconcile(external)).toEqual(external);
  });

  it("accepts a later external update after the latest local edit is acknowledged", () => {
    const draft = createProviderSessionDefaultsDraft(defaults());
    const submitted = draft.submit(CLAUDE, defaultValue("claude-submitted"));

    expect(draft.reconcile(submitted)).toEqual(submitted);
    const external = defaults("codex-external", "claude-external");
    expect(draft.reconcile(external)).toEqual(external);
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t4code/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
