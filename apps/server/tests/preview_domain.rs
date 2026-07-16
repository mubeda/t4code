use t4code_server::preview;

use preview::{PreviewManager, PreviewNavStatus, PreviewViewportSetting};

#[tokio::test]
async fn opens_a_preview_session_with_normalized_localhost_url_and_emits_opened() {
    let manager = PreviewManager::new();
    let mut events = manager.subscribe_events();

    let snapshot = manager
        .open("thread-1", Some("localhost:5173"))
        .await
        .expect("open");

    assert_eq!(snapshot.thread_id, "thread-1");
    assert!(snapshot.tab_id.starts_with("tab_"));
    assert_eq!(
        snapshot.nav_status,
        PreviewNavStatus::Loading {
            url: "http://localhost:5173/".to_owned(),
            title: String::new()
        }
    );

    let event = events.recv().await.expect("opened event");
    assert_eq!(event.event_type(), "opened");
    assert_eq!(event.tab_id(), snapshot.tab_id);
}

#[tokio::test]
async fn resize_persists_across_navigation_and_status_reports() {
    let manager = PreviewManager::new();
    let opened = manager
        .open("thread-1", Some("http://localhost:5173"))
        .await
        .expect("open");

    let resized = manager
        .resize(
            "thread-1",
            &opened.tab_id,
            PreviewViewportSetting::Freeform {
                width: 1024,
                height: 768,
            },
        )
        .await
        .expect("resize");
    assert_eq!(
        resized.viewport,
        PreviewViewportSetting::Freeform {
            width: 1024,
            height: 768
        }
    );

    let navigated = manager
        .navigate(
            "thread-1",
            &opened.tab_id,
            "http://localhost:5173/about",
            Some("About"),
        )
        .await
        .expect("navigate");
    assert_eq!(navigated.viewport, resized.viewport);

    manager
        .report_status(
            "thread-1",
            &opened.tab_id,
            PreviewNavStatus::Success {
                url: "http://localhost:5173/about".to_owned(),
                title: "About".to_owned(),
            },
            true,
            false,
        )
        .await
        .expect("report status");

    let listed = manager.list("thread-1").await;
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].viewport, resized.viewport);
}

#[tokio::test]
async fn close_is_idempotent_for_unknown_threads() {
    let manager = PreviewManager::new();
    manager.close("thread-missing", None).await.expect("close");
    assert!(manager.list("thread-missing").await.sessions.is_empty());
}
