use serde_json::json;
use t4code_server::diagnostics::TraceDiagnosticsStore;

#[test]
fn actionable_failures_are_redacted_and_survive_restart() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("logs/server.trace.ndjson");

    {
        let store = TraceDiagnosticsStore::new(trace_path.clone());
        store
            .record_failure(
                "git.createWorktree",
                &json!({
                    "_tag": "GitCommandError",
                    "detail": "fatal: bad config line 3 in .gitmodules\nAuthorization: Bearer super-secret"
                }),
            )
            .expect("failure is persisted");
    }

    let restarted = TraceDiagnosticsStore::new(trace_path.clone());
    let diagnostics = restarted.read();

    assert_eq!(
        diagnostics["traceFilePath"],
        trace_path.to_string_lossy().as_ref()
    );
    assert_eq!(diagnostics["recordCount"], 1);
    assert_eq!(diagnostics["failureCount"], 1);
    assert_eq!(
        diagnostics["latestFailures"][0]["name"],
        "git.createWorktree"
    );
    let cause = diagnostics["latestFailures"][0]["cause"]
        .as_str()
        .expect("failure cause");
    assert!(cause.contains("bad config line 3 in .gitmodules"));
    assert!(!cause.contains("super-secret"));
    assert!(cause.contains("[REDACTED]"));
}

#[test]
fn browser_otlp_envelopes_are_persisted_as_individual_spans() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("server.trace.ndjson");
    let store = TraceDiagnosticsStore::new(trace_path);

    store
        .record_otlp_payload(&json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "trace-browser",
                        "spanId": "span-browser",
                        "name": "RpcClient.project.create",
                        "startTimeUnixNano": "1000000000",
                        "endTimeUnixNano": "2500000000",
                        "status": { "code": 2, "message": "worktree request failed" },
                        "events": []
                    }]
                }]
            }]
        }))
        .expect("browser traces are persisted");

    let diagnostics = TraceDiagnosticsStore::new(store.path().to_path_buf()).read();
    assert_eq!(diagnostics["recordCount"], 1);
    assert_eq!(diagnostics["failureCount"], 1);
    assert_eq!(diagnostics["slowSpanCount"], 1);
    assert_eq!(diagnostics["latestFailures"][0]["traceId"], "trace-browser");
    assert_eq!(diagnostics["latestFailures"][0]["durationMs"], 1_500.0);
}

#[test]
fn malformed_persisted_lines_are_counted_without_hiding_valid_failures() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("server.trace.ndjson");
    std::fs::write(&trace_path, "not-json\n").expect("malformed fixture");
    let store = TraceDiagnosticsStore::new(trace_path);
    store
        .record_failure("vcs.createWorktree", &json!({ "message": "failed" }))
        .expect("valid failure");

    let diagnostics = store.read();
    assert_eq!(diagnostics["parseErrorCount"], 1);
    assert_eq!(diagnostics["recordCount"], 1);
    assert_eq!(diagnostics["failureCount"], 1);
}
