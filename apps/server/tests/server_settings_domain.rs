use t4code_server::server_settings;

use server_settings::{
    ObservabilitySettingsPatch, ProviderEnvironmentVariableInput, ProviderInstanceInput,
    ProviderSettingsPatch, ProviderSettingsState, ProviderSettingsStore, ProvidersPatch,
    ServerSettingsPatch, ServerSettingsReadError,
};
use tempfile::TempDir;

#[tokio::test]
async fn trims_observability_settings_and_defaults_blank_binary_paths() {
    let temp = TempDir::new().expect("temp");
    let store = ProviderSettingsStore::new(temp.path());

    let next = store
        .update(ServerSettingsPatch {
            add_project_base_directory: Some("  ~/Development  ".to_owned()),
            observability: Some(ObservabilitySettingsPatch {
                otlp_traces_url: Some("  http://localhost:4318/v1/traces  ".to_owned()),
                otlp_metrics_url: Some("  http://localhost:4318/v1/metrics  ".to_owned()),
            }),
            providers: Some(ProvidersPatch {
                codex: Some(ProviderSettingsPatch {
                    binary_path: Some("   ".to_owned()),
                    ..ProviderSettingsPatch::default()
                }),
                claude_agent: Some(ProviderSettingsPatch {
                    binary_path: Some(String::new()),
                    ..ProviderSettingsPatch::default()
                }),
                ..ProvidersPatch::default()
            }),
            ..ServerSettingsPatch::default()
        })
        .await
        .expect("update");

    assert_eq!(next.add_project_base_directory, "~/Development");
    assert_eq!(
        next.observability.otlp_traces_url,
        "http://localhost:4318/v1/traces"
    );
    assert_eq!(
        next.observability.otlp_metrics_url,
        "http://localhost:4318/v1/metrics"
    );
    assert_eq!(next.providers.codex.binary_path, "codex");
    assert_eq!(next.providers.claude_agent.binary_path, "claude");
}

#[tokio::test]
async fn writes_only_non_default_server_settings_to_disk() {
    let temp = TempDir::new().expect("temp");
    let store = ProviderSettingsStore::new(temp.path());

    let next = store
        .update(ServerSettingsPatch {
            add_project_base_directory: Some("~/Development".to_owned()),
            observability: Some(ObservabilitySettingsPatch {
                otlp_traces_url: Some("http://localhost:4318/v1/traces".to_owned()),
                otlp_metrics_url: Some("http://localhost:4318/v1/metrics".to_owned()),
            }),
            providers: Some(ProvidersPatch {
                codex: Some(ProviderSettingsPatch {
                    binary_path: Some("/opt/homebrew/bin/codex".to_owned()),
                    ..ProviderSettingsPatch::default()
                }),
                ..ProvidersPatch::default()
            }),
            automatic_git_fetch_interval_ms: Some(10_000),
            ..ServerSettingsPatch::default()
        })
        .await
        .expect("update");

    assert_eq!(next.providers.codex.binary_path, "/opt/homebrew/bin/codex");
    let raw = tokio::fs::read_to_string(temp.path().join("settings.json"))
        .await
        .expect("settings file");
    assert!(raw.contains("\"addProjectBaseDirectory\": \"~/Development\""));
    assert!(raw.contains("\"automaticGitFetchInterval\": 10000"));
    assert!(!raw.contains("\"claudeAgent\""));
}

#[tokio::test]
async fn stores_sensitive_environment_values_outside_settings_json_and_roundtrips() {
    let temp = TempDir::new().expect("temp");
    let store = ProviderSettingsStore::new(temp.path());

    let next = store
        .update(ServerSettingsPatch {
            provider_instances: Some(std::collections::BTreeMap::from([(
                "codex_personal".to_owned(),
                ProviderInstanceInput {
                    driver: "codex".to_owned(),
                    display_name: None,
                    environment: vec![
                        ProviderEnvironmentVariableInput {
                            name: "OPENROUTER_API_KEY".to_owned(),
                            value: "sk-or-secret".to_owned(),
                            sensitive: true,
                            value_redacted: false,
                        },
                        ProviderEnvironmentVariableInput {
                            name: "ANTHROPIC_BASE_URL".to_owned(),
                            value: "https://openrouter.ai/api".to_owned(),
                            sensitive: false,
                            value_redacted: false,
                        },
                    ],
                },
            )])),
            ..ServerSettingsPatch::default()
        })
        .await
        .expect("update");

    let environment = &next
        .provider_instances
        .get("codex_personal")
        .expect("instance")
        .environment;
    assert_eq!(environment[0].value, "sk-or-secret");
    assert!(environment[0].value_redacted);

    let raw = tokio::fs::read_to_string(temp.path().join("settings.json"))
        .await
        .expect("settings file");
    assert!(!raw.contains("sk-or-secret"));
    assert!(raw.contains("\"valueRedacted\": true"));

    let round_tripped = store
        .update(ServerSettingsPatch {
            provider_instances: Some(std::collections::BTreeMap::from([(
                "codex_personal".to_owned(),
                ProviderInstanceInput {
                    driver: "codex".to_owned(),
                    display_name: Some("Codex Personal".to_owned()),
                    environment: vec![
                        ProviderEnvironmentVariableInput {
                            name: "OPENROUTER_API_KEY".to_owned(),
                            value: String::new(),
                            sensitive: true,
                            value_redacted: true,
                        },
                        ProviderEnvironmentVariableInput {
                            name: "ANTHROPIC_BASE_URL".to_owned(),
                            value: "https://openrouter.ai/api".to_owned(),
                            sensitive: false,
                            value_redacted: false,
                        },
                    ],
                },
            )])),
            ..ServerSettingsPatch::default()
        })
        .await
        .expect("round trip");

    assert_eq!(
        round_tripped
            .provider_instances
            .get("codex_personal")
            .expect("instance")
            .environment[0]
            .value,
        "sk-or-secret"
    );
}

#[tokio::test]
async fn missing_redacted_secret_returns_the_expected_read_error() {
    let temp = TempDir::new().expect("temp");
    let settings = ProviderSettingsState {
        provider_instances: std::collections::BTreeMap::from([(
            "codex_personal".to_owned(),
            server_settings::ProviderInstanceState {
                driver: "codex".to_owned(),
                display_name: None,
                environment: vec![server_settings::ProviderEnvironmentVariableState {
                    name: "OPENROUTER_API_KEY".to_owned(),
                    value: String::new(),
                    sensitive: true,
                    value_redacted: true,
                }],
            },
        )]),
        ..ProviderSettingsState::default()
    };
    tokio::fs::write(
        temp.path().join("settings.json"),
        serde_json::to_vec_pretty(&settings).expect("encode"),
    )
    .await
    .expect("write settings");

    let store = ProviderSettingsStore::new(temp.path());
    let error = store.get().await.expect_err("missing secret");
    assert!(matches!(
        error,
        ServerSettingsReadError::MissingSecret {
            ref instance_id,
            ref environment_variable,
            ..
        } if instance_id == "codex_personal" && environment_variable == "OPENROUTER_API_KEY"
    ));
}
