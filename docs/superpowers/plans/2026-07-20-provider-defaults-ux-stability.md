# Provider Defaults UX Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep provider default model, effort, and fast-mode controls stable through every provider refresh, and prove every newly created chat, chat panel, and supported AI terminal receives the latest saved defaults.

**Architecture:** Provider inventory will distinguish quick, successful-rich, and failed-rich probe results and merge them without erasing last-known model metadata. Provider-owned fallback descriptors will cover first launch, while the shared resolver supplies a minimal defensive invariant model for malformed or legacy empty snapshots. The React settings row will render from that stable shape, and all creation paths will continue consuming the one shared resolver.

**Tech Stack:** Rust/Axum/Tokio server, serde JSON provider snapshots, TypeScript, React 19, Vite+, Tauri 2, macOS Computer Use QA.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before completion.
- Use `vp test` for focused Vite+ tests and `vp run test` only for the repository package-script suite.
- Codex always shows Default model, Default effort, and Fast by default.
- Claude always shows Default model and Default effort; show Fast by default only when the selected Claude model supports it.
- Provider controls remain mounted and keep their values when a provider is disabled; only interactivity changes.
- Codex fast mode is a provider-level invariant and persists as `serviceTier=fast` or `serviceTier=default`.
- Shared defaults apply to every new chat/session after the settings save completes; existing sessions never change.
- One shared default set is keyed by provider driver and is used by every instance of that provider.
- Do not modify files under `.repos/`.
- Preserve existing generation checks so stale quick or full probes cannot overwrite newer settings.

---

## File Structure

- `apps/server/src/provider/codex/model.rs`: owns canonical Codex fallback model, effort, and service-tier descriptors.
- `apps/server/src/production/provider_inventory.rs`: returns typed probe results and labels whether rich metadata was requested, succeeded, or failed.
- `apps/server/src/production/control.rs`: merges volatile provider health with retained rich metadata before publishing provider status events.
- `packages/shared/src/providerSessionDefaults.ts`: owns cross-surface provider-default resolution and defensive provider invariants.
- `packages/shared/src/providerSessionDefaults.test.ts`: verifies stable resolution, persistence, model transitions, and immutable inputs.
- `apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx`: renders the stable one-row settings controls.
- `apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx`: verifies control order, visibility, values, and disabled behavior.
- `apps/web/src/hooks/useHandleNewThread.test.tsx`: verifies new normal/worktree chats use the latest defaults and existing chats do not change.
- `apps/web/src/components/ChatView.hooks.test.tsx`: verifies newly added chat panels use the latest defaults.
- `apps/web/src/components/chat/providerTerminalActions.test.ts`: verifies supported CLI argument translations.
- `.superpowers/qa/provider-defaults-stability/`: ignored local screenshots and QA notes from native macOS verification.

### Task 1: Canonical Codex Fallback Metadata

**Files:**
- Modify: `apps/server/src/provider/codex/model.rs`
- Modify: `apps/server/src/production/provider_inventory.rs`

**Interfaces:**
- Produces: `codex::model::fallback_models(configured_model: Option<&str>, configured_effort: Option<&str>, configured_service_tier: Option<&str>, custom_models: &[String]) -> Vec<Value>`.
- Consumes: the existing `ProviderDefinition` plus the driver-keyed `providerSessionDefaults` setting.
- Produces: non-empty Codex model metadata before a successful live Codex probe, including `reasoningEffort` and `serviceTier` descriptors.

- [ ] **Step 1: Write failing Codex fallback tests**

Add these tests to the existing `tests` module in `apps/server/src/provider/codex/model.rs`:

```rust
#[test]
fn fallback_models_expose_codex_effort_and_fast_service_tiers() {
    let models = fallback_models(Some("gpt-private"), Some("max"), Some("fast"), &[]);
    let model = &models[0];
    let descriptors = model["capabilities"]["optionDescriptors"]
        .as_array()
        .expect("fallback option descriptors");
    let effort = descriptors
        .iter()
        .find(|descriptor| descriptor["id"] == "reasoningEffort")
        .expect("reasoning effort descriptor");
    let service_tier = descriptors
        .iter()
        .find(|descriptor| descriptor["id"] == "serviceTier")
        .expect("service tier descriptor");

    assert_eq!(model["slug"], "gpt-private");
    assert!(effort["options"].as_array().unwrap().iter().any(|option| {
        option["id"] == "max" && option["isDefault"] == true
    }));
    assert_eq!(service_tier["options"][0]["id"], "default");
    assert_eq!(service_tier["options"][1]["id"], "fast");
    assert_eq!(service_tier["currentValue"], "fast");
}

#[test]
fn fallback_models_keep_custom_models_unique_and_label_all_known_efforts() {
    let models = fallback_models(
        None,
        Some("ultra"),
        None,
        &["gpt-custom".to_owned(), "gpt-custom".to_owned()],
    );

    assert_eq!(models.iter().filter(|model| model["slug"] == "gpt-custom").count(), 1);
    assert_eq!(reasoning_effort_label("max"), "Max");
    assert_eq!(reasoning_effort_label("ultra"), "Ultra");
}
```

Add this test to `apps/server/src/production/provider_inventory.rs`:

```rust
#[test]
fn codex_inventory_uses_saved_defaults_before_live_discovery() {
    let definitions = definitions(&json!({
        "providerInstances": {
            "codex": { "driver": "codex", "enabled": true, "config": {} }
        },
        "providerSessionDefaults": {
            "codex": {
                "model": "gpt-configured",
                "options": [
                    { "id": "reasoningEffort", "value": "xhigh" },
                    { "id": "serviceTier", "value": "fast" }
                ]
            }
        }
    }));
    let models = provider_models_without_version(&definitions[0]);

    assert_eq!(models[0]["slug"], "gpt-configured");
    assert_eq!(
        models[0]["capabilities"]["optionDescriptors"][0]["currentValue"],
        "xhigh"
    );
    assert_eq!(
        models[0]["capabilities"]["optionDescriptors"][1]["currentValue"],
        "fast"
    );
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
vp run --filter t4code test -- fallback_models_expose_codex_effort_and_fast_service_tiers
vp run --filter t4code test -- codex_inventory_uses_saved_defaults_before_live_discovery
```

Expected: both commands fail because `fallback_models` and the saved-default fields on `ProviderDefinition` do not exist.

- [ ] **Step 3: Implement the provider-owned fallback factory**

In `apps/server/src/provider/codex/model.rs`, add a public factory next to `parse_model_list_response`. Use the stable vocabulary `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; default to `medium`; append a saved unknown effort once; and expose `default` and `fast` service tiers:

```rust
pub fn fallback_models(
    configured_model: Option<&str>,
    configured_effort: Option<&str>,
    configured_service_tier: Option<&str>,
    custom_models: &[String],
) -> Vec<Value> {
    const EFFORTS: [&str; 8] = [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let model = configured_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MODEL);
    let selected_effort = configured_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("medium");
    let selected_service_tier = if configured_service_tier == Some("fast") {
        "fast"
    } else {
        "default"
    };
    let mut efforts = EFFORTS.into_iter().collect::<Vec<_>>();
    if !efforts.contains(&selected_effort) {
        efforts.push(selected_effort);
    }
    let effort_options = efforts
        .into_iter()
        .map(|effort| {
            let mut option = json!({
                "id": effort,
                "label": reasoning_effort_label(effort),
            });
            if effort == selected_effort {
                option["isDefault"] = json!(true);
            }
            option
        })
        .collect::<Vec<_>>();
    let mut models = vec![json!({
        "slug": model,
        "name": to_display_name(model),
        "isCustom": false,
        "capabilities": {
            "optionDescriptors": [
                {
                    "id": "reasoningEffort",
                    "label": "Reasoning",
                    "type": "select",
                    "options": effort_options,
                    "currentValue": selected_effort,
                },
                {
                    "id": "serviceTier",
                    "label": "Service Tier",
                    "type": "select",
                    "options": [
                        {
                            "id": "default",
                            "label": "Standard",
                            "isDefault": selected_service_tier == "default"
                        },
                        {
                            "id": "fast",
                            "label": "Fast",
                            "isDefault": selected_service_tier == "fast"
                        }
                    ],
                    "currentValue": selected_service_tier,
                }
            ]
        }
    })];
    let mut seen = std::collections::HashSet::from([model.to_owned()]);
    models.extend(custom_models.iter().filter_map(|custom| {
        let slug = custom.trim();
        (!slug.is_empty() && seen.insert(slug.to_owned())).then(|| json!({
            "slug": slug,
            "name": slug,
            "isCustom": true,
            "capabilities": null,
        }))
    }));
    models
}
```

Change `reasoning_effort_label` to return `&str`, add `"max" => "Max"` and
`"ultra" => "Ultra"`, and return the input for unknown saved values instead of
mislabeling them as Medium:

```rust
fn reasoning_effort_label(value: &str) -> &str {
    match value {
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        _ => value,
    }
}
```

In `apps/server/src/production/provider_inventory.rs`, add these fields to `ProviderDefinition`:

```rust
configured_model: Option<String>,
configured_effort: Option<String>,
configured_service_tier: Option<String>,
```

While building each definition, read the driver-wide default once:

```rust
let session_default = settings
    .get("providerSessionDefaults")
    .and_then(Value::as_object)
    .and_then(|defaults| defaults.get(driver));
let configured_model = session_default
    .and_then(|value| value.get("model"))
    .and_then(Value::as_str)
    .map(str::to_owned);
let configured_effort = session_default
    .and_then(|value| value.get("options"))
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .find(|selection| {
        matches!(
            selection.get("id").and_then(Value::as_str),
            Some("reasoningEffort" | "effort" | "reasoning")
        )
    })
    .and_then(|selection| selection.get("value"))
    .and_then(Value::as_str)
    .map(str::to_owned);
let configured_service_tier = session_default
    .and_then(|value| value.get("options"))
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .find(|selection| selection.get("id").and_then(Value::as_str) == Some("serviceTier"))
    .and_then(|selection| selection.get("value"))
    .and_then(Value::as_str)
    .map(str::to_owned);
```

Set all three fields on configured and legacy definitions, then add the Codex branch:

```rust
"codex" => codex::model::fallback_models(
    definition.configured_model.as_deref(),
    definition.configured_effort.as_deref(),
    definition.configured_service_tier.as_deref(),
    &definition.custom_models,
),
```

Update every test-only `ProviderDefinition` literal with `configured_model: None`,
`configured_effort: None`, and `configured_service_tier: None`.

- [ ] **Step 4: Run focused Rust tests and verify GREEN**

Run:

```bash
vp run --filter t4code test -- fallback_models
vp run --filter t4code test -- codex_inventory_uses_saved_defaults_before_live_discovery
```

Expected: all matching tests pass; no duplicate custom models; Codex fallback descriptors contain effort and service tier.

- [ ] **Step 5: Commit the fallback metadata slice**

```bash
git add apps/server/src/provider/codex/model.rs apps/server/src/production/provider_inventory.rs
git commit -m "fix: add stable Codex provider metadata"
```

### Task 2: Typed Rich-Metadata Probe Merging

**Files:**
- Modify: `apps/server/src/production/provider_inventory.rs`
- Modify: `apps/server/src/production/control.rs`

**Interfaces:**
- Produces: `ProviderProbeResult { snapshot: Value, rich_metadata: RichMetadataOutcome }`.
- Produces: `RichMetadataOutcome::{NotRequested, Succeeded, Failed}`.
- Changes: `provider_inventory::probe` and `probe_full` return `Vec<ProviderProbeResult>`.
- Consumes: Task 1 fallback snapshots when no previous rich metadata exists.

- [ ] **Step 1: Write failing merge tests**

Add a pure merge helper test block to `apps/server/src/production/control.rs`:

```rust
#[test]
fn quick_and_failed_probes_retain_rich_metadata_but_update_health() {
    let current = json!({
        "instanceId": "codex",
        "status": "ready",
        "checkedAt": "old",
        "models": [{ "slug": "gpt-rich" }],
        "slashCommands": [{ "name": "goal" }],
        "skills": [{ "name": "review" }],
        "agents": [{ "name": "builder" }]
    });
    let quick = provider_inventory::ProviderProbeResult {
        snapshot: json!({
            "instanceId": "codex",
            "status": "warning",
            "checkedAt": "new",
            "models": [{ "slug": "gpt-fallback" }],
            "slashCommands": [{ "name": "goal" }],
            "skills": [],
            "agents": []
        }),
        rich_metadata: provider_inventory::RichMetadataOutcome::NotRequested,
    };
    let failed = provider_inventory::ProviderProbeResult {
        rich_metadata: provider_inventory::RichMetadataOutcome::Failed,
        ..quick.clone()
    };

    for result in [quick, failed] {
        let merged = merge_provider_snapshot(Some(&current), result);
        assert_eq!(merged["status"], "warning");
        assert_eq!(merged["checkedAt"], "new");
        assert_eq!(merged["models"], current["models"]);
        assert_eq!(merged["skills"], current["skills"]);
        assert_eq!(merged["agents"], current["agents"]);
    }
}

#[test]
fn successful_rich_probe_can_authoritatively_clear_metadata() {
    let current = json!({
        "instanceId": "codex",
        "models": [{ "slug": "retired" }],
        "slashCommands": [{ "name": "old" }],
        "skills": [{ "name": "old" }],
        "agents": [{ "name": "old" }]
    });
    let merged = merge_provider_snapshot(
        Some(&current),
        provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "codex",
                "models": [],
                "slashCommands": [],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
        },
    );

    assert_eq!(merged["models"], json!([]));
    assert_eq!(merged["skills"], json!([]));
    assert_eq!(merged["agents"], json!([]));
}
```

Add inventory classification assertions in `apps/server/src/production/provider_inventory.rs`:

```rust
#[tokio::test]
async fn quick_disabled_probe_marks_rich_metadata_not_requested() {
    let settings = json!({
        "providerInstances": {
            "codex": { "driver": "codex", "enabled": false, "config": {} }
        }
    });
    let result = probe(&settings, Some("codex"), Path::new(".")).await;

    assert_eq!(result[0].rich_metadata, RichMetadataOutcome::NotRequested);
    assert!(!result[0].snapshot["models"].as_array().unwrap().is_empty());
}
```

- [ ] **Step 2: Run focused server tests and verify RED**

Run:

```bash
vp run --filter t4code test -- quick_and_failed_probes_retain_rich_metadata_but_update_health
vp run --filter t4code test -- quick_disabled_probe_marks_rich_metadata_not_requested
```

Expected: compilation fails because typed probe results and `merge_provider_snapshot` do not exist.

- [ ] **Step 3: Add the internal typed probe result**

In `apps/server/src/production/provider_inventory.rs`, add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RichMetadataOutcome {
    NotRequested,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderProbeResult {
    pub(crate) snapshot: Value,
    pub(crate) rich_metadata: RichMetadataOutcome,
}

impl ProviderProbeResult {
    fn new(snapshot: Value, rich_metadata: RichMetadataOutcome) -> Self {
        Self { snapshot, rich_metadata }
    }
}
```

Change `probe`, `probe_full`, `probe_inner`, and `probe_one` to return typed results. Classify every exit explicitly:

```rust
let mut rich_metadata = if include_slow_capabilities {
    RichMetadataOutcome::Failed
} else {
    RichMetadataOutcome::NotRequested
};
```

- Quick probes, unavailable providers, and disabled providers use `NotRequested`.
- Codex uses `Succeeded` only when `probe_codex` returns an inventory.
- Cursor uses `Succeeded` only when model discovery returns a catalog and workspace capability discovery completes.
- Claude uses `Succeeded` only after its version-based model catalog and slow capability probes complete; otherwise use `Failed` and retain prior rich metadata.
- OpenCode uses `Succeeded` only when local or endpoint inventory returns successfully.
- Grok uses `Succeeded` when its full built-in/ACP catalog completes.
- Any full-probe executable, transport, timeout, or parse failure uses `Failed`.

Wrap the final snapshot without changing its public JSON shape:

```rust
ProviderProbeResult::new(
    snapshot(
        &definition,
        installed,
        version,
        status,
        auth,
        models,
        capabilities,
        message,
        checked_at,
        "available",
    ),
    rich_metadata,
)
```

- [ ] **Step 4: Implement field-preserving merge semantics**

In `apps/server/src/production/control.rs`, add the pure helper above `impl NativeServerControl`:

```rust
fn merge_provider_snapshot(
    current: Option<&Value>,
    refreshed: provider_inventory::ProviderProbeResult,
) -> Value {
    let mut next = refreshed.snapshot;
    if refreshed.rich_metadata == provider_inventory::RichMetadataOutcome::Succeeded {
        return next;
    }
    let Some(current) = current else {
        return next;
    };
    for field in ["models", "slashCommands", "skills", "agents"] {
        if let Some(value) = current.get(field) {
            next[field] = value.clone();
        }
    }
    next
}
```

Change the publishing and merge signatures from `Vec<Value>` to `Vec<ProviderProbeResult>`. Preserve partial-refresh behavior and full-refresh removal of deleted instances:

```rust
async fn merge_provider_snapshots(
    &self,
    refreshed: Vec<provider_inventory::ProviderProbeResult>,
    partial: bool,
) -> Vec<Value> {
    let mut current = self.providers.write().await;
    if partial {
        for result in refreshed {
            let Some(id) = result
                .snapshot
                .get("instanceId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let position = current.iter().position(|row| {
                row.get("instanceId").and_then(Value::as_str) == Some(id.as_str())
            });
            let merged = merge_provider_snapshot(position.map(|index| &current[index]), result);
            if let Some(position) = position {
                current[position] = merged;
            } else {
                current.push(merged);
            }
        }
    } else {
        let previous = current.clone();
        *current = refreshed
            .into_iter()
            .map(|result| {
                let id = result.snapshot.get("instanceId").and_then(Value::as_str);
                let previous = previous
                    .iter()
                    .find(|row| row.get("instanceId").and_then(Value::as_str) == id);
                merge_provider_snapshot(previous, result)
            })
            .collect();
    }
    current.clone()
}
```

At server startup there is no previous snapshot to merge. Unwrap only the
public snapshots before constructing `NativeServerControl`:

```rust
let providers = provider_inventory::probe(&settings, None, &cwd)
    .await
    .into_iter()
    .map(|result| result.snapshot)
    .collect();
```

Update any provider-inventory unit test that directly indexes a probe result to
index `result.snapshot`; do not serialize `rich_metadata` into the client event.

Keep `publish_provider_snapshots` accepting `&[Value]`; only internal probe/merge types change. Adapt the existing direct merge test near the control smoke tests to construct `ProviderProbeResult`.

- [ ] **Step 5: Run server regression tests and verify GREEN**

Run:

```bash
vp run --filter t4code test -- quick_and_failed_probes_retain_rich_metadata_but_update_health
vp run --filter t4code test -- successful_rich_probe_can_authoritatively_clear_metadata
vp run --filter t4code test -- quick_disabled_probe_marks_rich_metadata_not_requested
vp run --filter t4code test -- concurrent_settings_stream_discards_stale_provider_probes_in_commit_order
```

Expected: every focused test passes; the existing concurrent generation-order test remains green.

- [ ] **Step 6: Commit the probe merge slice**

```bash
git add apps/server/src/production/provider_inventory.rs apps/server/src/production/control.rs
git commit -m "fix: retain rich provider metadata during refresh"
```

### Task 3: Defensive Shared Provider Invariants

**Files:**
- Modify: `packages/shared/src/providerSessionDefaults.ts`
- Modify: `packages/shared/src/providerSessionDefaults.test.ts`

**Interfaces:**
- Produces: `getInvariantProviderModel(driver, model, selections) -> ServerProviderModel | null` as a private helper.
- Preserves public signatures for `resolveProviderSessionDefault`, `getProviderSessionDefaultControls`, and `updateProviderSessionDefault`.
- Guarantees: Codex has effort and fast mode even with an empty/malformed model list; Claude has effort.

- [ ] **Step 1: Replace the old empty-model expectation with failing invariant tests**

In `packages/shared/src/providerSessionDefaults.test.ts`, replace `keeps an unavailable configured model during discovery failure without exposing capabilities` with:

```typescript
it("keeps Codex effort and fast mode available during an empty discovery snapshot", () => {
  const configuredDefault: ProviderSessionDefault = {
    model: "private-model",
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ],
  };
  const controls = getProviderSessionDefaultControls({
    driver: CODEX,
    models: [],
    configuredDefault,
  });

  expect(controls.configuredModel).toBe("private-model");
  expect(controls.effortDescriptor?.id).toBe("reasoningEffort");
  expect(controls.effortDescriptor?.options.map(({ id }) => id)).toContain("xhigh");
  expect(controls.effort).toBe("xhigh");
  expect(controls.fastModeSupported).toBe(true);
  expect(controls.fastMode).toBe(true);
});

it("keeps Claude effort available during an empty discovery snapshot", () => {
  const controls = getProviderSessionDefaultControls({
    driver: CLAUDE,
    models: [],
    configuredDefault: {
      model: "claude-private",
      options: [{ id: "effort", value: "max" }],
    },
  });

  expect(controls.effortDescriptor?.id).toBe("effort");
  expect(controls.effort).toBe("max");
  expect(controls.fastModeSupported).toBe(false);
});
```

Add mutation and creation-resolution tests:

```typescript
it("persists Codex fast and effort changes without a live descriptor", () => {
  const current: ProviderSessionDefault = {
    model: "gpt-offline",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "default" },
    ],
  };

  expect(updateProviderSessionDefault({
    driver: CODEX,
    models: [],
    current,
    change: { type: "fastMode", value: true },
  })).toEqual({
    model: "gpt-offline",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ],
  });
});

it("resolves offline Codex defaults into new-session native options", () => {
  const result = resolveProviderSessionDefault({
    driver: CODEX,
    instanceId: CODEX_ID,
    models: [],
    configuredDefault: {
      model: "gpt-offline",
      options: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "fast" },
      ],
    },
  });

  expect(result.modelSelection).toEqual({
    instanceId: CODEX_ID,
    model: DEFAULT_MODEL_BY_PROVIDER[CODEX],
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ],
  });
  expect(result.effort).toBe("xhigh");
  expect(result.fastMode).toBe(true);
});
```

- [ ] **Step 2: Run the shared tests and verify RED**

Run:

```bash
vp test run packages/shared/src/providerSessionDefaults.test.ts
```

Expected: Codex and Claude invariant tests fail because empty models currently produce no descriptors, effort, or fast support.

- [ ] **Step 3: Implement minimal defensive invariant descriptors**

In `packages/shared/src/providerSessionDefaults.ts`, add driver constants and private helpers. Do not duplicate the full server effort tables; include only the saved value or the provider default so malformed snapshots remain representable until server fallback metadata arrives:

```typescript
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const DEFAULT_EFFORT_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: "medium",
  [CLAUDE_DRIVER_KIND]: "high",
};

function selectedString(
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
  ids: ReadonlyArray<string>,
): string | null {
  const selection = selections?.find(
    (candidate) => ids.includes(candidate.id) && typeof candidate.value === "string",
  );
  return typeof selection?.value === "string" ? selection.value : null;
}

function getInvariantProviderModel(
  driver: ProviderDriverKind,
  model: string,
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): ServerProviderModel | null {
  if (driver !== CODEX_DRIVER_KIND && driver !== CLAUDE_DRIVER_KIND) return null;
  const effortId = driver === CODEX_DRIVER_KIND ? "reasoningEffort" : "effort";
  const effort =
    selectedString(selections, PROVIDER_SESSION_EFFORT_OPTION_IDS) ??
    DEFAULT_EFFORT_BY_PROVIDER[driver]!;
  const optionDescriptors: Array<ProviderOptionDescriptor> = [{
    id: effortId,
    label: "Reasoning",
    type: "select",
    options: [{ id: effort, label: effort, isDefault: true }],
    currentValue: effort,
  }];
  if (driver === CODEX_DRIVER_KIND) {
    const tier = selectedString(selections, [SERVICE_TIER_OPTION_ID]);
    optionDescriptors.push({
      id: SERVICE_TIER_OPTION_ID,
      label: "Service Tier",
      type: "select",
      options: [
        { id: DEFAULT_SERVICE_TIER_VALUE, label: "Standard", isDefault: true },
        { id: FAST_SERVICE_TIER_VALUE, label: "Fast" },
      ],
      currentValue: tier === FAST_SERVICE_TIER_VALUE
        ? FAST_SERVICE_TIER_VALUE
        : DEFAULT_SERVICE_TIER_VALUE,
    });
  }
  return {
    slug: model,
    name: model,
    isCustom: false,
    capabilities: { optionDescriptors },
  };
}
```

In all three public operations, resolve the live model first and then fall back
to the invariant model for option normalization:

```typescript
const selectedModel = configuredServerModel ?? fallbackModel;
const optionsModel =
  selectedModel ?? getInvariantProviderModel(input.driver, configuredModel, selections);
```

For `resolveProviderSessionDefault`, keep the runtime model fallback exactly as
today while normalizing options through `optionsModel`:

```typescript
const resolvedModel = input.models.length === 0
  ? getProviderDefaultModel(input.driver)
  : (selectedModel?.slug ?? configuredModel);
const normalizedOptions = normalizeProviderOptions(
  input.driver,
  optionsModel,
  selections,
);
```

For `getProviderSessionDefaultControls`, use
`const selections = input.configuredDefault?.options` and retain the configured
model as the displayed value during empty discovery. For
`updateProviderSessionDefault`, use the invariant model instead of returning
`{ model: persistedModel }` early, so offline effort/fast changes preserve both
native selections.

- [ ] **Step 4: Run shared tests and verify GREEN**

Run:

```bash
vp test run packages/shared/src/providerSessionDefaults.test.ts
```

Expected: the new invariant tests and all existing precedence, alias, invalid-effort, and immutability tests pass.

- [ ] **Step 5: Commit the shared resolver slice**

```bash
git add packages/shared/src/providerSessionDefaults.ts packages/shared/src/providerSessionDefaults.test.ts
git commit -m "fix: stabilize provider default capabilities"
```

### Task 4: Stable Provider Settings Row

**Files:**
- Modify: `apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx`
- Modify: `apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx`

**Interfaces:**
- Consumes: stable `ProviderSessionDefaultControls` from Task 3.
- Produces: a fixed control row for Codex and Claude that changes disabled state without unmounting supported controls.

- [ ] **Step 1: Write failing rendering and refresh-transition tests**

In `ProviderSessionDefaultsControls.test.tsx`, replace the generic Codex omission test with one that uses a non-Codex driver, and add these Codex regression tests:

```typescript
it("keeps the complete Codex row and values mounted when discovery becomes empty", () => {
  const value: ProviderSessionDefault = {
    model: "gpt-rich",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ],
  };
  const codexModels = [model("gpt-rich", [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "fast", label: "Fast" },
      ],
      currentValue: "default",
    },
  ])];
  const richMarkup = render(baseProps({ models: codexModels, value }));
  const richKinds = controls.entries.map((entry) => entry.kind);
  const emptyMarkup = render(baseProps({ models: [], value }));
  const emptyKinds = controls.entries.map((entry) => entry.kind);

  expect(richMarkup).toContain("Default effort");
  expect(emptyMarkup).toContain("Default effort");
  expect(emptyMarkup).toContain("Fast by default");
  expect(emptyKinds).toEqual(richKinds);
  expect(emptyKinds).toEqual(["Select", "Select", "Switch"]);
  expect(entries("Select")[1]?.value).toBe("high");
  expect(entries("Switch")[0]?.checked).toBe(true);
});

it("changes only interactivity when Codex is disabled and re-enabled", () => {
  render(baseProps({ disabled: true }));
  const disabledShape = controls.entries.map((entry) => entry.kind);
  expect(controls.entries.every((entry) => entry.props.disabled === true)).toBe(true);

  render(baseProps({ disabled: false }));
  expect(controls.entries.map((entry) => entry.kind)).toEqual(disabledShape);
  expect(controls.entries.every((entry) => entry.props.disabled === false)).toBe(true);
});

it("keeps an unavailable saved model selectable so the user can recover", () => {
  render(baseProps({
    models: [richModels[0]!],
    value: { model: "private-model" },
  }));

  expect(entries("Select")[0]).toMatchObject({ disabled: false, value: "private-model" });
});
```

Change `omits effort and fast controls when the selected model does not support them` to use `ProviderDriverKind.make("opencode")`; its expected single model selector remains valid.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
vp test run --project unit apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx
```

Expected: the empty Codex snapshot loses effort/fast controls and the unavailable model selector is disabled.

- [ ] **Step 3: Keep the row interactive based only on provider enabled state**

In `ProviderSessionDefaultsControls.tsx`, change:

```typescript
const modelDisabled = disabled || !controls.modelAvailable;
```

to:

```typescript
const modelDisabled = disabled;
```

Keep the unavailable saved model as the current display value and keep the fallback explanation, but let the enabled selector open so the user can choose a discovered replacement. Task 3 ensures Codex effort and fast controls are always present, so retain the existing conditional JSX for providers whose capability contract genuinely lacks those controls.

Ensure every control still receives exactly `disabled={disabled}` and preserve the grid classes and control order.

- [ ] **Step 4: Run settings component tests and verify GREEN**

Run:

```bash
vp test run --project unit apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx
vp test run --project unit apps/web/src/components/settings/SettingsPanels.test.tsx
```

Expected: both files pass; Codex renders `Select`, `Select`, `Switch` in that order before, during, and after incomplete refreshes.

- [ ] **Step 5: Commit the stable settings row**

```bash
git add apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx
git commit -m "fix: keep provider default controls stable"
```

### Task 5: New Chat, Panel, and AI Terminal Propagation

**Files:**
- Modify: `apps/web/src/hooks/useHandleNewThread.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/chat/providerTerminalActions.test.ts`

**Interfaces:**
- Consumes: `resolveProviderSessionDefault` from Task 3.
- Produces: regression proof that all future surfaces receive current driver-wide defaults and existing sessions remain unchanged.
- Terminal mappings remain: Codex `--model`, `--config model_reasoning_effort=...`, `--config service_tier=...`; Claude `--model`, `--effort`; unsupported fast flags omitted.

- [ ] **Step 1: Add a latest-save new-chat regression**

Add to `useHandleNewThread.test.tsx` after the existing configured-default tests:

```typescript
it("uses the newest saved Codex defaults only for the next chat", async () => {
  testState.projects = [project()];
  configureEnvironment({
    providers: [serverProvider({
      instanceId: codexInstanceId,
      driver: codexDriver,
      models: [providerModel("gpt-next", [reasoningEffortDescriptor, serviceTierDescriptor])],
    })],
    settings: {
      providerSessionDefaults: {
        [codexDriver]: {
          model: "gpt-next",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    },
  });

  await mount(<NewThreadHarness />);
  await clickNewThread();

  expect(createdDraftModelSelection()).toEqual({
    instanceId: codexInstanceId,
    model: "gpt-next",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ],
  });
});
```

Retain the existing `does not overwrite an existing server thread selection after defaults change` test as the immutable-session counterpart.

- [ ] **Step 2: Add an empty-transient panel regression with Codex native options**

In `ChatView.hooks.test.tsx`, add next to the existing configured chat-panel test:

```typescript
it("creates a Codex chat panel with saved effort and fast mode during empty discovery", async () => {
  seedEnvironment(makeEnvironmentPresentation());
  seedProject(makeProject({ defaultModelSelection: null }));
  seedServerThread(makeThread());
  seedGitStatus(true);
  h.settings = {
    ...h.settings,
    providerSessionDefaults: {
      [ProviderDriverKind.make("codex")]: {
        model: "gpt-offline",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      },
    },
  };
  renderServerRoute();
  const header = capturedProps("chatHeader");
  const entry = {
    instanceId: codexInstanceId,
    driverKind: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    models: [],
  } as unknown as ProviderInstanceEntry;

  (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
  await Promise.resolve();
  await Promise.resolve();

  expect(commandCallsFor("thread.create")[0]?.input).toMatchObject({
    input: {
      modelSelection: {
        instanceId: codexInstanceId,
        model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("codex")],
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      },
    },
  });
});
```

- [ ] **Step 3: Add exact Codex and Claude terminal argument regressions**

Add to `providerTerminalActions.test.ts`:

```typescript
it("builds Codex terminal arguments from saved defaults during empty discovery", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerSessionDefaults: {
      [CODEX_DRIVER]: {
        model: "gpt-offline",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "serviceTier", value: "fast" },
        ],
      },
    },
  } satisfies ServerSettings;

  expect(resolveProviderTerminalAction(
    entry("codex", "codex", "Codex", []),
    settings,
  )?.command?.args).toEqual([
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER],
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'service_tier="fast"',
  ]);
});

it("builds Claude model and effort arguments and omits unsupported fast mode", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerSessionDefaults: {
      [CLAUDE_DRIVER]: {
        model: "claude-opus-4-8",
        options: [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
    },
  } satisfies ServerSettings;

  expect(resolveProviderTerminalAction(
    entry("claudeAgent", "claudeAgent", "Claude", [
      model("claude-opus-4-8", [claudeEffortDescriptor, fastModeDescriptor]),
    ]),
    settings,
  )?.command?.args).toEqual([
    "--dangerously-skip-permissions",
    "--model",
    "claude-opus-4-8",
    "--effort",
    "high",
  ]);
});
```

Import `DEFAULT_MODEL_BY_PROVIDER` from `@t4code/contracts` if the test does not already import it.

- [ ] **Step 4: Run creation-path tests and verify the expected state**

Run:

```bash
vp test run --project unit apps/web/src/hooks/useHandleNewThread.test.tsx
vp test run --project unit apps/web/src/components/ChatView.hooks.test.tsx
vp test run --project unit apps/web/src/components/chat/providerTerminalActions.test.ts
```

Expected: all tests pass without production changes because each creation path already
consumes the shared resolver. A failure is evidence that the relevant earlier task is
incomplete; return to that task's failing test instead of adding a second resolver.

- [ ] **Step 5: Commit propagation proof and any minimal convergence fix**

```bash
git add apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts
git commit -m "test: cover provider defaults across new sessions"
```

### Task 6: Repository Gates and Native macOS Workflow QA

**Files:**
- Create ignored local directory: `.superpowers/qa/provider-defaults-stability/`
- Create ignored local note: `.superpowers/qa/provider-defaults-stability/results.md`
- Modify production/test files only if verification exposes a defect; return to the corresponding TDD task before changing code.

**Interfaces:**
- Consumes: the complete implementation from Tasks 1–5.
- Produces: command evidence, screenshots, accessibility snapshots, restart-persistence evidence, and a clean verified worktree.

- [ ] **Step 1: Run focused suites together**

Run:

```bash
vp run --filter t4code test -- provider_inventory
vp test run packages/shared/src/providerSessionDefaults.test.ts
vp test run --project unit apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx apps/web/src/components/settings/SettingsPanels.test.tsx
vp test run --project unit apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 2: Run mandatory repository gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0. Fix any failure at its source and rerun both commands from a clean prompt.

- [ ] **Step 3: Start an isolated current-worktree native app**

Run:

```bash
mkdir -p .superpowers/qa/provider-defaults-stability/home
T4CODE_PORT_OFFSET=0 \
T4CODE_DEV_INSTANCE=provider-defaults-stability \
T4CODE_HOME="$PWD/.superpowers/qa/provider-defaults-stability/home" \
T4CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
vp run dev:desktop
```

Expected: the Tauri app named `T4Code (Alpha)` opens from the current worktree and the dev server reports ready. Keep this terminal running during QA.

- [ ] **Step 4: Verify stable provider panels with Computer Use**

Using the macOS Computer Use skill, take an accessibility snapshot before every action and another immediately after it. Save screenshots as:

```text
.superpowers/qa/provider-defaults-stability/01-initial.png
.superpowers/qa/provider-defaults-stability/02-cursor-enabled-immediate.png
.superpowers/qa/provider-defaults-stability/03-cursor-enabled-settled.png
.superpowers/qa/provider-defaults-stability/04-cursor-disabled-immediate.png
.superpowers/qa/provider-defaults-stability/05-refresh-immediate.png
.superpowers/qa/provider-defaults-stability/06-refresh-settled.png
```

Perform this exact workflow:

1. Open Settings → Providers.
2. Confirm Codex visibly has Default model, Default effort, and Fast by default.
3. Confirm Claude visibly has Default model and Default effort.
4. Toggle Cursor on, capture immediately, wait for the settled provider status, and capture again.
5. Toggle Cursor off, capture immediately, and confirm Codex still has three controls with unchanged values.
6. Toggle Codex off and confirm all three controls remain mounted and disabled.
7. Toggle Codex on and confirm the same values return to enabled state.
8. Toggle Claude off/on and confirm its supported controls never unmount.
9. Trigger provider refresh three times, sampling immediately and after settlement each time.

Expected: control labels, order, values, and row geometry do not flicker; provider toggles only change disabled state.

- [ ] **Step 5: Verify every available model/effort transition and persistence**

In the same app:

1. For Codex, iterate every model in Default model. For each model, open Default effort, record its options in `results.md`, select its highest advertised effort, and toggle Fast by default on.
2. Switch to the next Codex model. Confirm a still-valid effort remains selected; otherwise confirm the declared default/first valid effort is selected without a blank value.
3. Repeat for every Claude model and every advertised Claude effort. Confirm Claude Fast by default appears only for models whose descriptor supports it.
4. Close Settings, reopen it, and confirm the last selections.
5. Quit `T4Code (Alpha)` normally, stop the dev command, restart it with the exact Step 3 environment, reopen Settings, and confirm model, effort, and fast values survived the application restart.

Expected: no blank effort, no disappearing Codex fast toggle, and all saved defaults persist.

- [ ] **Step 6: Verify new chats, added panels, and existing-session immutability**

Perform:

1. Create Chat A with Codex defaults set to a recognizable model/effort/fast combination and record its visible selection.
2. Change Codex settings to a different combination.
3. Return to Chat A and confirm its model/effort/fast selection did not change.
4. Create Chat B and confirm it uses the new combination.
5. From Chat B's header `+` menu, add a Codex chat panel and confirm it uses the same new combination.
6. Repeat once with Claude using a different model and effort.

Save screenshots:

```text
.superpowers/qa/provider-defaults-stability/07-existing-chat-unchanged.png
.superpowers/qa/provider-defaults-stability/08-new-chat-defaults.png
.superpowers/qa/provider-defaults-stability/09-added-panel-defaults.png
```

Expected: only newly created surfaces use changed defaults.

- [ ] **Step 7: Verify AI terminal process arguments**

From the chat header provider-terminal actions:

1. Launch a Codex terminal after selecting a non-default effort and Fast by default on.
2. Inspect the launched terminal command/process arguments and record the exact vector in `results.md`; it must contain `--model`, `--config model_reasoning_effort="..."`, and `--config service_tier="fast"`.
3. Turn Codex fast off, launch another terminal, and confirm `service_tier="default"`.
4. Launch a Claude terminal and confirm `--model` and `--effort` are present while no unsupported fast flag is emitted.
5. Launch any other installed provider terminal action and confirm unsupported model/effort/fast flags remain omitted according to its definition.

Expected: the live commands match `providerTerminalActions.test.ts` exactly.

- [ ] **Step 8: Record final evidence and inspect the diff**

Write the pass/fail outcome, selected combinations, exact terminal vectors, restart result, and screenshot names to `.superpowers/qa/provider-defaults-stability/results.md`. Then run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: `git diff --check` exits 0; only intentional source/test changes or ignored QA artifacts exist; the task commits are visible.
