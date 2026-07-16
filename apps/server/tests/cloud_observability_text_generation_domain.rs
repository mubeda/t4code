use t4code_server::{cloud, observability, text_generation};

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
