use t4code_server::telemetry;

use telemetry::{AnalyticsEnvelope, AnalyticsService, TelemetryIdentity};
use tempfile::TempDir;

#[tokio::test]
async fn uses_the_persisted_anonymous_id_when_provider_identities_are_absent() {
    let temp = TempDir::new().expect("temp");
    tokio::fs::create_dir_all(temp.path().join("userdata"))
        .await
        .expect("userdata");
    tokio::fs::write(
        temp.path().join("userdata/anonymous-id"),
        "persisted-anonymous-id",
    )
    .await
    .expect("anonymous id");

    let identifier = TelemetryIdentity::for_home(
        temp.path().join("home"),
        temp.path().join("userdata/anonymous-id"),
    )
    .await
    .expect("identifier");

    assert_eq!(
        identifier,
        "ce0f18f873e58a66a49e58515db654eb3bff137fbdcf17a247150914beed6b00"
    );
}

#[tokio::test]
async fn falls_back_from_malformed_codex_auth_without_leaking_the_secret() {
    let temp = TempDir::new().expect("temp");
    let home = temp.path().join("home");
    tokio::fs::create_dir_all(home.join(".codex"))
        .await
        .expect("codex dir");
    tokio::fs::create_dir_all(temp.path().join("userdata"))
        .await
        .expect("userdata");
    tokio::fs::write(
        home.join(".codex/auth.json"),
        r#"{"tokens":{"access_token":"private-codex-access-token"}}"#,
    )
    .await
    .expect("codex auth");
    tokio::fs::write(
        temp.path().join("userdata/anonymous-id"),
        "decode-fallback-anonymous-id",
    )
    .await
    .expect("anonymous id");

    let identifier = TelemetryIdentity::for_home(home, temp.path().join("userdata/anonymous-id"))
        .await
        .expect("identifier");
    assert_eq!(
        identifier,
        "419ec7fefdf208916f23b6e518442335f233ef66047780af7a1501d0f5f7332c"
    );
}

#[tokio::test]
async fn analytics_service_flushes_batches_and_requeues_on_failure() {
    let deliveries = std::sync::Arc::new(std::sync::Mutex::new(Vec::<AnalyticsEnvelope>::new()));
    let fail_first = std::sync::Arc::new(std::sync::Mutex::new(true));
    let service = AnalyticsService::new("identifier-1".to_owned(), 2, 8, {
        let deliveries = deliveries.clone();
        let fail_first = fail_first.clone();
        move |payload| {
            let deliveries = deliveries.clone();
            let fail_first = fail_first.clone();
            Box::pin(async move {
                let mut first = fail_first.lock().expect("fail_first");
                if *first {
                    *first = false;
                    return Err("network failed".to_owned());
                }
                deliveries.lock().expect("deliveries").push(payload);
                Ok(())
            })
        }
    });

    service.record("event-1", serde_json::json!({"n": 1})).await;
    service.record("event-2", serde_json::json!({"n": 2})).await;
    assert!(service.flush().await.is_err());
    assert_eq!(service.buffer_len().await, 2);
    service.flush().await.expect("second flush");
    assert_eq!(service.buffer_len().await, 0);
    assert_eq!(deliveries.lock().expect("deliveries").len(), 1);
}
