use std::path::PathBuf;

use serde_json::json;
use t4code_server::production::{
    operational_logs::{OperationalLogOptions, ProviderOperationalLog},
    provider_runtime::ProviderEvent,
};
use t4code_server::{
    production::operational_logs::TerminalOperationalLog, terminal::TerminalEvent,
};
use tempfile::TempDir;

#[tokio::test]
async fn provider_events_without_a_lifecycle_suffix_are_marked_observed() {
    let temp = TempDir::new().expect("temporary log directory");
    let path = temp.path().join("events.log");
    let log = ProviderOperationalLog::start(path.clone(), OperationalLogOptions::default())
        .await
        .expect("provider log starts");

    assert!(log.record(&ProviderEvent {
        event_type: "assistant.message.delta".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: Some("turn-1".to_owned()),
        request_id: None,
        payload: json!({
            "text": "PRIVATE_PROVIDER_MESSAGE",
            "arguments": { "token": "PRIVATE_CREDENTIAL" },
            "environment": { "SECRET": "PRIVATE_ENVIRONMENT" },
            "raw": "PRIVATE_RAW_PAYLOAD"
        }),
    }));
    log.shutdown().await.expect("provider log shuts down");

    let contents = std::fs::read_to_string(path).expect("read provider log");
    let record: serde_json::Value = serde_json::from_str(contents.trim()).expect("provider record");
    assert_eq!(record["status"], "observed");
    for private_value in [
        "PRIVATE_PROVIDER_MESSAGE",
        "PRIVATE_CREDENTIAL",
        "PRIVATE_ENVIRONMENT",
        "PRIVATE_RAW_PAYLOAD",
    ] {
        assert!(!contents.contains(private_value));
    }
}

#[tokio::test]
async fn terminal_output_is_persisted_as_metadata_without_data() {
    let temp = TempDir::new().expect("temporary log directory");
    let path = temp.path().join("terminal-events.log");
    let log = TerminalOperationalLog::start(path.clone(), OperationalLogOptions::default())
        .await
        .expect("terminal log starts");

    assert!(log.record(&TerminalEvent::Output {
        thread_id: "thread-1".to_owned(),
        terminal_id: "terminal-1".to_owned(),
        sequence: 7,
        data: "PRIVATE_TERMINAL_OUTPUT".to_owned(),
    }));
    log.shutdown().await.expect("terminal log shuts down");

    let contents = std::fs::read_to_string(path).expect("read terminal log");
    let record: serde_json::Value = serde_json::from_str(contents.trim()).expect("terminal record");
    assert_eq!(record["eventType"], "activity");
    assert_eq!(record["activityType"], "output");
    assert_eq!(record["byteCount"], 23);
    assert!(record.get("data").is_none());
    assert!(!contents.contains("PRIVATE_TERMINAL_OUTPUT"));
}

#[tokio::test]
async fn startup_removes_provider_log_files_that_exceed_the_configured_bound() {
    let temp = TempDir::new().expect("temporary log directory");
    let path = temp.path().join("events.log");
    std::fs::write(&path, vec![b'x'; 256]).expect("oversized existing log");
    let log = ProviderOperationalLog::start(
        path.clone(),
        OperationalLogOptions {
            max_file_bytes: 100,
            retained_files: 2,
            queue_capacity: 2,
        },
    )
    .await
    .expect("provider log starts");

    assert!(log.record(&ProviderEvent {
        event_type: "turn.completed".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: None,
        request_id: None,
        payload: json!({ "text": "must not be persisted" }),
    }));
    log.shutdown().await.expect("provider log shuts down");

    assert!(std::fs::metadata(&path).expect("active log").len() <= 100);
    let rotated = PathBuf::from(format!("{}.1", path.display()));
    assert!(!rotated.exists() || std::fs::metadata(rotated).expect("rotated log").len() <= 100);
}
