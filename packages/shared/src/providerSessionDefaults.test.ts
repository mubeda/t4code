import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderSessionDefault,
  type ServerProviderModel,
} from "@t4code/contracts";

import { createModelSelection } from "./model.ts";
import {
  getProviderSessionDefaultControls,
  resolveProviderSessionDefault,
  updateProviderSessionDefault,
} from "./providerSessionDefaults.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");
const UNKNOWN = ProviderDriverKind.make("custom-driver");

const CODEX_ID = ProviderInstanceId.make("codex_personal");
const CLAUDE_ID = ProviderInstanceId.make("claude_work");
const OPENCODE_ID = ProviderInstanceId.make("opencode");
const OTHER_ID = ProviderInstanceId.make("other");

const reasoningEffortDescriptor: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
  ],
  currentValue: "medium",
};

const serviceTierDescriptor: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "fast", label: "Fast" },
  ],
  currentValue: "default",
};

const claudeEffortDescriptor: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
  ],
  currentValue: "high",
};

const cursorReasoningDescriptor: ProviderOptionDescriptor = {
  id: "reasoning",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "standard", label: "Standard", isDefault: true },
    { id: "deep", label: "Deep" },
  ],
  currentValue: "standard",
};

const fastModeDescriptor: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast Mode",
  type: "boolean",
  currentValue: false,
};

const contextWindowDescriptor: ProviderOptionDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  type: "select",
  options: [
    { id: "200k", label: "200k", isDefault: true },
    { id: "1m", label: "1M" },
  ],
  currentValue: "200k",
};

const variantDescriptor: ProviderOptionDescriptor = {
  id: "variant",
  label: "Variant",
  type: "select",
  options: [
    { id: "standard", label: "Standard", isDefault: true },
    { id: "max", label: "Max" },
  ],
  currentValue: "standard",
};

const agentDescriptor: ProviderOptionDescriptor = {
  id: "agent",
  label: "Agent",
  type: "select",
  options: [
    { id: "build", label: "Build", isDefault: true },
    { id: "plan", label: "Plan" },
  ],
  currentValue: "build",
};

function model(
  slug: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  input: { readonly name?: string; readonly isCustom?: boolean } = {},
): ServerProviderModel {
  return {
    slug,
    name: input.name ?? slug,
    isCustom: input.isCustom ?? false,
    capabilities: { optionDescriptors: [...descriptors] },
  };
}

const codexModels = [
  model("gpt-5.4", [reasoningEffortDescriptor, serviceTierDescriptor, contextWindowDescriptor]),
  model(
    "gpt-5.4-mini",
    [
      {
        ...reasoningEffortDescriptor,
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      serviceTierDescriptor,
    ],
    { name: "GPT 5.4 Mini" },
  ),
] satisfies ReadonlyArray<ServerProviderModel>;

const claudeModels = [
  model("claude-sonnet-5", [claudeEffortDescriptor, fastModeDescriptor, contextWindowDescriptor]),
] satisfies ReadonlyArray<ServerProviderModel>;

const cursorModels = [
  model("auto", [cursorReasoningDescriptor, fastModeDescriptor]),
] satisfies ReadonlyArray<ServerProviderModel>;

const opencodeModels = [
  model("openai/gpt-5", [variantDescriptor, agentDescriptor]),
] satisfies ReadonlyArray<ServerProviderModel>;

describe("getProviderSessionDefaultControls", () => {
  const cases = [
    {
      name: "Codex reasoningEffort and serviceTier",
      driver: CODEX,
      models: codexModels,
      configuredDefault: {
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      },
      expected: {
        effortId: "reasoningEffort",
        effort: "high",
        fastModeSupported: true,
        fastMode: true,
      },
    },
    {
      name: "Claude effort and boolean fastMode",
      driver: CLAUDE,
      models: claudeModels,
      configuredDefault: {
        model: "claude-sonnet-5",
        options: [
          { id: "effort", value: "medium" },
          { id: "fastMode", value: true },
        ],
      },
      expected: {
        effortId: "effort",
        effort: "medium",
        fastModeSupported: true,
        fastMode: true,
      },
    },
    {
      name: "Cursor reasoning and boolean fastMode",
      driver: CURSOR,
      models: cursorModels,
      configuredDefault: {
        model: "auto",
        options: [
          { id: "reasoning", value: "deep" },
          { id: "fastMode", value: false },
        ],
      },
      expected: {
        effortId: "reasoning",
        effort: "deep",
        fastModeSupported: true,
        fastMode: false,
      },
    },
    {
      name: "OpenCode variant and agent are not effort",
      driver: OPENCODE,
      models: opencodeModels,
      configuredDefault: {
        model: "openai/gpt-5",
        options: [
          { id: "variant", value: "max" },
          { id: "agent", value: "plan" },
        ],
      },
      expected: {
        effortId: null,
        effort: null,
        fastModeSupported: false,
        fastMode: null,
      },
    },
    {
      name: "context-window selects are not effort",
      driver: CLAUDE,
      models: [model("claude-context-only", [contextWindowDescriptor])],
      configuredDefault: {
        model: "claude-context-only",
        options: [{ id: "contextWindow", value: "1m" }],
      },
      expected: {
        effortId: null,
        effort: null,
        fastModeSupported: false,
        fastMode: null,
      },
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly driver: typeof CODEX;
    readonly models: ReadonlyArray<ServerProviderModel>;
    readonly configuredDefault: ProviderSessionDefault;
    readonly expected: {
      readonly effortId: string | null;
      readonly effort: string | null;
      readonly fastModeSupported: boolean;
      readonly fastMode: boolean | null;
    };
  }>;

  for (const testCase of cases) {
    it(`normalizes ${testCase.name}`, () => {
      const controls = getProviderSessionDefaultControls(testCase);

      expect(controls.configuredModel).toBe(testCase.configuredDefault.model);
      expect(controls.resolvedModel).toBe(testCase.configuredDefault.model);
      expect(controls.modelAvailable).toBe(true);
      expect(controls.effortDescriptor?.id ?? null).toBe(testCase.expected.effortId);
      expect(controls.effort).toBe(testCase.expected.effort);
      expect(controls.fastModeSupported).toBe(testCase.expected.fastModeSupported);
      expect(controls.fastMode).toBe(testCase.expected.fastMode);
    });
  }

  it("normalizes an invalid configured effort to the descriptor current/default value", () => {
    const controls = getProviderSessionDefaultControls({
      driver: CODEX,
      models: codexModels,
      configuredDefault: {
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "retired-value" }],
      },
    });

    expect(controls.effort).toBe("medium");
  });

  it("keeps an unavailable configured model during discovery failure without exposing capabilities", () => {
    const configuredDefault: ProviderSessionDefault = {
      model: "private-model",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const snapshot = structuredClone(configuredDefault);

    expect(
      getProviderSessionDefaultControls({
        driver: CODEX,
        models: [],
        configuredDefault,
      }),
    ).toEqual({
      configuredModel: "private-model",
      resolvedModel: "private-model",
      modelAvailable: false,
      effortDescriptor: null,
      effort: null,
      fastModeSupported: false,
      fastMode: null,
    });
    expect(configuredDefault).toEqual(snapshot);
  });
});

describe("Codex-only serviceTier fast-mode binding", () => {
  const driver = ProviderDriverKind.make("custom-tiered");
  const instanceId = ProviderInstanceId.make("custom-tiered");
  const models = [model("tiered-model", [serviceTierDescriptor])];
  const configuredDefault: ProviderSessionDefault = {
    model: "tiered-model",
    options: [{ id: "serviceTier", value: "fast" }],
  };

  it("does not expose a non-Codex serviceTier as fast mode", () => {
    const controls = getProviderSessionDefaultControls({
      driver,
      models,
      configuredDefault,
    });

    expect(controls.fastModeSupported).toBe(false);
    expect(controls.fastMode).toBeNull();
  });

  it("does not resolve a non-Codex serviceTier as fast mode", () => {
    const resolved = resolveProviderSessionDefault({
      driver,
      instanceId,
      models,
      configuredDefault,
    });

    expect(resolved.fastMode).toBeNull();
  });

  it("does not persist a non-Codex serviceTier through a fast-mode mutation", () => {
    expect(
      updateProviderSessionDefault({
        driver,
        models,
        current: configuredDefault,
        change: { type: "fastMode", value: false },
      }),
    ).toEqual({ model: "tiered-model" });
  });
});

describe("resolveProviderSessionDefault", () => {
  it("uses explicit, project, configured, then discovered defaults in precedence order", () => {
    const configuredDefault: ProviderSessionDefault = {
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const projectSelection = createModelSelection(CODEX_ID, "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
    ]);
    const explicitSelection = createModelSelection(CODEX_ID, "gpt-5.4-mini", [
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "fast" },
    ]);

    const explicit = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault,
      projectSelection,
      explicitSelection,
    });
    const project = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault,
      projectSelection,
    });
    const configured = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault,
    });
    const discovered = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
    });

    expect(explicit.modelSelection.model).toBe("gpt-5.4-mini");
    expect(explicit.effort).toBe("medium");
    expect(explicit.fastMode).toBe(true);
    expect(project.modelSelection.model).toBe("gpt-5.4");
    expect(project.effort).toBe("high");
    expect(configured.modelSelection.model).toBe("gpt-5.4");
    expect(configured.effort).toBe("low");
    expect(discovered.modelSelection.model).toBe("gpt-5.4");
    expect(discovered.configuredModelAvailable).toBe(true);
    expect(discovered.fallback).toBeNull();
  });

  it("ignores mismatched explicit and project instances instead of rerouting", () => {
    const configuredDefault: ProviderSessionDefault = {
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const projectSelection = createModelSelection(CODEX_ID, "gpt-5.4-mini", [
      { id: "reasoningEffort", value: "high" },
    ]);
    const explicitSelection = createModelSelection(OTHER_ID, "gpt-5.4", [
      { id: "reasoningEffort", value: "xhigh" },
    ]);

    const projectResult = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault,
      projectSelection,
      explicitSelection,
    });
    const configuredResult = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault,
      projectSelection: createModelSelection(OTHER_ID, "gpt-5.4-mini"),
      explicitSelection,
    });

    expect(projectResult.modelSelection.instanceId).toBe(CODEX_ID);
    expect(projectResult.modelSelection.model).toBe("gpt-5.4-mini");
    expect(projectResult.effort).toBe("high");
    expect(configuredResult.modelSelection.instanceId).toBe(CODEX_ID);
    expect(configuredResult.modelSelection.model).toBe("gpt-5.4");
    expect(configuredResult.effort).toBe("low");
  });

  it("uses the first non-custom model before an earlier custom model", () => {
    const custom = model("custom-first", [], { isCustom: true });
    const builtIn = model("built-in-second", []);

    const result = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: [custom, builtIn],
      configuredDefault: { model: "retired" },
    });

    expect(result.modelSelection.model).toBe("built-in-second");
    expect(result.configuredModelAvailable).toBe(false);
    expect(result.fallback).toEqual({
      driver: CODEX,
      instanceId: CODEX_ID,
      configuredModel: "retired",
      resolvedModel: "built-in-second",
      reason: "configured-model-unavailable",
    });
  });

  it("uses the first custom model when there is no built-in model", () => {
    const result = resolveProviderSessionDefault({
      driver: OPENCODE,
      instanceId: OPENCODE_ID,
      models: [
        model("custom-first", [], { isCustom: true }),
        model("custom-second", [], { isCustom: true }),
      ],
      configuredDefault: { model: "retired" },
    });

    expect(result.modelSelection.model).toBe("custom-first");
    expect(result.fallback?.reason).toBe("configured-model-unavailable");
  });

  it("uses provider and global constants when model discovery is unavailable", () => {
    const known = resolveProviderSessionDefault({
      driver: CLAUDE,
      instanceId: CLAUDE_ID,
      models: [],
      configuredDefault: { model: "retired-claude" },
    });
    const unknown = resolveProviderSessionDefault({
      driver: UNKNOWN,
      instanceId: ProviderInstanceId.make("custom"),
      models: [],
      configuredDefault: { model: "retired-custom" },
    });

    expect(known.modelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER[CLAUDE]);
    expect(known.fallback).toEqual({
      driver: CLAUDE,
      instanceId: CLAUDE_ID,
      configuredModel: "retired-claude",
      resolvedModel: DEFAULT_MODEL_BY_PROVIDER[CLAUDE],
      reason: "models-unavailable",
    });
    expect(unknown.modelSelection.model).toBe(DEFAULT_MODEL);
    expect(unknown.fallback?.reason).toBe("models-unavailable");
  });

  it("resolves aliases and display names before falling back", () => {
    const alias = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault: { model: "5.4" },
    });
    const displayName = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault: { model: "GPT 5.4 Mini" },
    });

    expect(alias.modelSelection.model).toBe("gpt-5.4");
    expect(alias.configuredModelAvailable).toBe(true);
    expect(alias.fallback).toBeNull();
    expect(displayName.modelSelection.model).toBe("gpt-5.4-mini");
    expect(displayName.fallback).toBeNull();
  });

  it("normalizes descriptor-compatible options and omits unsupported selections", () => {
    const result = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault: {
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "retired" },
          { id: "serviceTier", value: "fast" },
          { id: "unsupported", value: "keep-out" },
        ],
      },
    });

    expect(result.modelSelection).toEqual({
      instanceId: CODEX_ID,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "fast" },
        { id: "contextWindow", value: "200k" },
      ],
    });
    expect(result.effort).toBe("medium");
    expect(result.fastMode).toBe(true);
  });

  it("maps boolean fastMode and Codex standard service tier to false", () => {
    const claude = resolveProviderSessionDefault({
      driver: CLAUDE,
      instanceId: CLAUDE_ID,
      models: claudeModels,
      configuredDefault: {
        model: "claude-sonnet-5",
        options: [{ id: "fastMode", value: true }],
      },
    });
    const codex = resolveProviderSessionDefault({
      driver: CODEX,
      instanceId: CODEX_ID,
      models: codexModels,
      configuredDefault: {
        model: "gpt-5.4",
        options: [{ id: "serviceTier", value: "default" }],
      },
    });

    expect(claude.fastMode).toBe(true);
    expect(codex.fastMode).toBe(false);
  });
});

describe("updateProviderSessionDefault", () => {
  it("persists provider-native effort and fast options but drops unrelated defaults", () => {
    const current: ProviderSessionDefault = {
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "fast" },
        { id: "contextWindow", value: "1m" },
        { id: "variant", value: "max" },
        { id: "agent", value: "plan" },
        { id: "thinking", value: true },
      ],
    };

    expect(
      updateProviderSessionDefault({
        driver: CODEX,
        models: codexModels,
        current,
        change: { type: "effort", value: "high" },
      }),
    ).toEqual({
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
  });

  it("maps fast-mode changes to provider-native values", () => {
    expect(
      updateProviderSessionDefault({
        driver: CODEX,
        models: codexModels,
        current: {
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
        change: { type: "fastMode", value: false },
      }),
    ).toEqual({
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    });

    expect(
      updateProviderSessionDefault({
        driver: CLAUDE,
        models: claudeModels,
        current: {
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "medium" }],
        },
        change: { type: "fastMode", value: true },
      }),
    ).toEqual({
      model: "claude-sonnet-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("preserves compatible values and resets incompatible values on model changes", () => {
    const current: ProviderSessionDefault = {
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const compatible = updateProviderSessionDefault({
      driver: CODEX,
      models: codexModels,
      current,
      change: { type: "model", value: "GPT 5.4 Mini" },
    });
    const incompatible = updateProviderSessionDefault({
      driver: CODEX,
      models: [
        ...codexModels,
        model("reasoning-lite", [
          {
            ...reasoningEffortDescriptor,
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
            ],
          },
        ]),
      ],
      current: {
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "serviceTier", value: "fast" },
        ],
      },
      change: { type: "model", value: "reasoning-lite" },
    });

    expect(compatible).toEqual({
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
    expect(incompatible).toEqual({
      model: "reasoning-lite",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it("omits unsupported effort and fast-mode changes", () => {
    expect(
      updateProviderSessionDefault({
        driver: OPENCODE,
        models: opencodeModels,
        current: {
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "max" },
            { id: "agent", value: "plan" },
          ],
        },
        change: { type: "effort", value: "high" },
      }),
    ).toEqual({ model: "openai/gpt-5" });

    expect(
      updateProviderSessionDefault({
        driver: OPENCODE,
        models: opencodeModels,
        current: { model: "openai/gpt-5" },
        change: { type: "fastMode", value: true },
      }),
    ).toEqual({ model: "openai/gpt-5" });
  });

  it("does not write a runtime fallback over an unavailable configured model", () => {
    expect(
      updateProviderSessionDefault({
        driver: CODEX,
        models: codexModels,
        current: {
          model: "private-model",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
        change: { type: "effort", value: "low" },
      }),
    ).toEqual({
      model: "private-model",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "fast" },
      ],
    });
  });

  it("uses the discovered default model when creating a new default", () => {
    expect(
      updateProviderSessionDefault({
        driver: CURSOR,
        models: cursorModels,
        change: { type: "effort", value: "deep" },
      }),
    ).toEqual({
      model: "auto",
      options: [
        { id: "reasoning", value: "deep" },
        { id: "fastMode", value: false },
      ],
    });
  });
});
