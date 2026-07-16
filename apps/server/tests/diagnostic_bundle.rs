use std::{collections::BTreeMap, io::Read};

use t4code_server::diagnostic_bundle::DiagnosticBundleService;
use tempfile::TempDir;
use time::OffsetDateTime;
use zip::ZipArchive;

fn generated_at() -> OffsetDateTime {
    OffsetDateTime::parse(
        "2026-07-15T12:34:56Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("fixed generated-at timestamp")
}

fn zip_entries(bytes: Vec<u8>) -> BTreeMap<String, String> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).expect("readable zip archive");
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("zip entry");
        let mut contents = String::new();
        entry
            .read_to_string(&mut contents)
            .expect("UTF-8 log entry");
        entries.insert(entry.name().to_owned(), contents);
    }
    entries
}

#[tokio::test]
async fn bundle_contains_exact_root_entries_and_oldest_first_server_rotations() {
    let temp = TempDir::new().expect("temporary logs directory");
    for (name, contents) in [
        ("server.log.3", "oldest\n"),
        ("server.log.2", "older\n"),
        ("server.log.1", "recent\n"),
        ("server.log", "active\n"),
    ] {
        std::fs::write(temp.path().join(name), contents).expect("write retained log");
    }
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build("frontend warning\n".to_owned(), generated_at())
        .await
        .expect("diagnostic bundle");

    assert_eq!(bundle.filename, "t4code-diagnostics-20260715T123456Z.zip");
    let entries = zip_entries(bundle.bytes);
    assert_eq!(
        entries.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["frontend.log", "server.log"]
    );
    let server = entries.get("server.log").expect("server log entry");
    let positions = ["oldest", "older", "recent", "active"].map(|text| {
        server
            .find(text)
            .unwrap_or_else(|| panic!("missing {text}"))
    });
    assert!(positions.windows(2).all(|window| window[0] < window[1]));
    assert!(server.contains("===== server.log.3 ====="));
    assert_eq!(entries.get("frontend.log").unwrap(), "frontend warning\n");
}

#[tokio::test]
async fn bundle_uses_explanatory_placeholders_when_logs_are_empty() {
    let temp = TempDir::new().expect("temporary logs directory");
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build(String::new(), generated_at())
        .await
        .expect("diagnostic bundle");
    let entries = zip_entries(bundle.bytes);

    assert_eq!(
        entries.get("server.log").unwrap(),
        "No retained server logs were found.\n"
    );
    assert_eq!(
        entries.get("frontend.log").unwrap(),
        "No frontend warnings or errors were captured.\n"
    );
}

#[tokio::test]
async fn bundle_redacts_credentials_in_both_trust_boundary_inputs() {
    let temp = TempDir::new().expect("temporary logs directory");
    std::fs::write(
        temp.path().join("server.log"),
        "Authorization: Bearer server-secret\n",
    )
    .expect("write server log");
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build(
            "request api_key=frontend-secret\nurl=https://user:password@example.com/path\n"
                .to_owned(),
            generated_at(),
        )
        .await
        .expect("diagnostic bundle");
    let entries = zip_entries(bundle.bytes);
    let combined = entries.values().cloned().collect::<String>();

    assert!(combined.contains("[REDACTED]"));
    assert!(!combined.contains("server-secret"));
    assert!(!combined.contains("frontend-secret"));
    assert!(!combined.contains("user:password"));
}
