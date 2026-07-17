use t4code_server::{
    cloud, observability, production::managed_endpoint::ManagedEndpointRuntime, text_generation,
};

use cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus};
use observability::BrowserTraceCollector;
use serde_json::json;
use text_generation::{normalize_cli_error, sanitize_commit_subject, sanitize_thread_title};

#[tokio::test]
async fn relay_client_service_reports_status_and_streams_install_progress() {
    let service = RelayClientService::new(
        || async {
            RelayClientStatus::Missing {
                version: "2026.7.0".to_owned(),
            }
        },
        |report| async move {
            report(RelayClientInstallEvent::Progress {
                stage: "checking".to_owned(),
            })
            .await?;
            report(RelayClientInstallEvent::Progress {
                stage: "downloading".to_owned(),
            })
            .await?;
            Ok(RelayClientStatus::Available {
                executable_path: "/tmp/t4code/tools/cloudflared".to_owned(),
                source: "managed".to_owned(),
                version: "2026.7.0".to_owned(),
            })
        },
    );

    let status = service.resolve().await;
    assert_eq!(
        status,
        RelayClientStatus::Missing {
            version: "2026.7.0".to_owned()
        }
    );

    let events = service.install().await.expect("install");
    assert_eq!(
        events,
        vec![
            RelayClientInstallEvent::Progress {
                stage: "checking".to_owned()
            },
            RelayClientInstallEvent::Progress {
                stage: "downloading".to_owned()
            },
            RelayClientInstallEvent::Complete {
                status: RelayClientStatus::Available {
                    executable_path: "/tmp/t4code/tools/cloudflared".to_owned(),
                    source: "managed".to_owned(),
                    version: "2026.7.0".to_owned(),
                }
            }
        ]
    );
}

#[tokio::test]
async fn managed_endpoint_runtime_handles_disabled_unsupported_and_missing_connectors() {
    let runtime = ManagedEndpointRuntime::default();
    let _endpoint = runtime.endpoint();

    assert_eq!(
        runtime.apply(serde_json::Value::Null).await.unwrap(),
        json!({"status":"disabled"})
    );
    assert_eq!(
        runtime
            .apply(json!({
                "providerKind":"future_provider",
                "connectorToken":"ignored",
            }))
            .await
            .unwrap(),
        json!({"status":"unsupported","providerKind":"future_provider"})
    );
    assert_eq!(
        runtime
            .apply(json!({
                "providerKind":"cloudflare_tunnel",
                "connectorToken":"fixture-token",
                "tunnelId":"tunnel-1",
                "tunnelName":"Fixture tunnel",
            }))
            .await
            .unwrap(),
        json!({
            "status":"failed",
            "providerKind":"cloudflare_tunnel",
            "reason":"The relay client is not installed.",
            "tunnelId":"tunnel-1",
            "tunnelName":"Fixture tunnel",
        })
    );

    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn managed_endpoint_runtime_reuses_replaces_and_stops_connectors() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("connector directory");
    let executable = directory.path().join("t4code-connect");
    std::fs::write(
        &executable,
        "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile true; do sleep 1; done\n",
    )
    .expect("connector fixture should write");
    let mut permissions = std::fs::metadata(&executable)
        .expect("connector metadata")
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).expect("connector should be executable");

    let runtime = ManagedEndpointRuntime::with_executable_override(executable);
    let first_config = json!({
        "providerKind":"cloudflare_tunnel",
        "connectorToken":"fixture-token-1",
        "tunnelId":"tunnel-1",
        "tunnelName":"Fixture tunnel",
    });
    let first = runtime.apply(first_config.clone()).await.unwrap();
    assert_eq!(first["status"], "running");
    assert!(first["pid"].as_u64().is_some());

    let reused = runtime.apply(first_config).await.unwrap();
    assert_eq!(reused["pid"], first["pid"]);

    let replacement = runtime
        .apply(json!({
            "providerKind":"cloudflare_tunnel",
            "connectorToken":"fixture-token-2",
            "tunnelId":"tunnel-2",
            "tunnelName":"Replacement tunnel",
        }))
        .await
        .unwrap();
    assert_eq!(replacement["status"], "running");
    assert_eq!(replacement["tunnelId"], "tunnel-2");
    assert_ne!(replacement["pid"], first["pid"]);

    runtime.shutdown().await;
    runtime.shutdown().await;
}

#[test]
fn browser_trace_collector_evicts_oldest_records_at_capacity() {
    let collector = BrowserTraceCollector::with_capacity(2);
    collector.record(vec![json!({"id": 1}), json!({"id": 2}), json!({"id": 3})]);

    assert_eq!(
        collector.records(),
        vec![json!({"id": 2}), json!({"id": 3})]
    );
}

#[test]
fn browser_trace_collector_records_trace_records_in_order() {
    let collector = BrowserTraceCollector::default();
    collector.record(vec![
        json!({"type":"otlp-span","name":"RpcClient.server.getSettings"}),
        json!({"type":"otlp-span","name":"RpcClient.server.updateSettings"}),
    ]);

    let records = collector.records();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["name"], "RpcClient.server.getSettings");
    assert_eq!(records[1]["name"], "RpcClient.server.updateSettings");
}

#[test]
fn text_generation_helpers_match_current_failure_and_sanitization_behavior() {
    assert_eq!(
        sanitize_commit_subject("  Add a much better commit subject.  "),
        "Add a much better commit subject"
    );
    assert_eq!(
        sanitize_thread_title("   \"A concise first user prompt\"   "),
        "A concise first user prompt"
    );

    let error = normalize_cli_error(
        "codex",
        "generateCommitMessage",
        &std::io::Error::new(std::io::ErrorKind::NotFound, "spawn codex ENOENT"),
        "fallback",
    );
    assert_eq!(error.operation, "generateCommitMessage");
    assert_eq!(
        error.detail,
        "Codex CLI (`codex`) is required but not available on PATH."
    );
}
