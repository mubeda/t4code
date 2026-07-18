use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
    process::Command,
};

use t4code_server::diagnostic_bundle::DiagnosticBundleService;
use tempfile::TempDir;
use time::OffsetDateTime;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

fn generated_at() -> OffsetDateTime {
    OffsetDateTime::parse(
        "2026-07-15T12:34:56Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("fixed generated-at timestamp")
}

fn validated_zip_entries(bytes: &[u8]) -> Result<(Vec<String>, BTreeMap<String, String>), String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("readable zip: {error}"))?;
    let mut names = Vec::new();
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("zip entry {index}: {error}"))?;
        let name = entry.name().to_owned();
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe diagnostic archive entry: {name}"))?;
        if enclosed.components().count() != 1 {
            return Err(format!(
                "diagnostic archive entry is not at the root: {name}"
            ));
        }
        let mut contents = String::new();
        entry
            .read_to_string(&mut contents)
            .map_err(|error| format!("UTF-8 log entry {name}: {error}"))?;
        names.push(name.clone());
        entries.insert(name, contents);
    }
    Ok((names, entries))
}

fn zip_entries(bytes: &[u8]) -> BTreeMap<String, String> {
    validated_zip_entries(bytes).expect("safe diagnostic zip").1
}

#[tokio::test]
async fn bundle_contains_exact_root_entries_and_oldest_first_server_rotations() {
    let temp = TempDir::new().expect("temporary logs directory");
    for (name, contents) in [
        ("server.log.3", "oldest\n"),
        ("server.log.2", "older\n"),
        ("server.log.1", "recent\n"),
        ("server.log", "active\n"),
        (
            "server.trace.ndjson",
            "{\"name\":\"filesystem.browse\",\"exit\":{\"_tag\":\"Failure\"}}\n",
        ),
    ] {
        std::fs::write(temp.path().join(name), contents).expect("write retained log");
    }
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build("frontend warning\n".to_owned(), generated_at())
        .await
        .expect("diagnostic bundle");

    assert_eq!(bundle.filename, "t4code-diagnostics-20260715T123456Z.zip");
    let (names, entries) = validated_zip_entries(&bundle.bytes).expect("safe diagnostic zip");
    assert_eq!(
        names,
        vec!["server.log", "server.trace.ndjson", "frontend.log"]
    );
    let server = entries.get("server.log").expect("server log entry");
    let positions = ["oldest", "older", "recent", "active"].map(|text| {
        server
            .find(text)
            .unwrap_or_else(|| panic!("missing {text}"))
    });
    assert!(positions.windows(2).all(|window| window[0] < window[1]));
    assert!(server.contains("===== server.log.3 ====="));
    assert!(
        entries
            .get("server.trace.ndjson")
            .unwrap()
            .contains("filesystem.browse")
    );
    assert_eq!(entries.get("frontend.log").unwrap(), "frontend warning\n");
}

#[tokio::test]
async fn bundle_uses_explanatory_placeholders_when_logs_are_empty() {
    let temp = TempDir::new().expect("temporary logs directory");
    std::fs::write(temp.path().join("server.log"), "").expect("write empty active log");
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build(String::new(), generated_at())
        .await
        .expect("diagnostic bundle");
    let entries = zip_entries(&bundle.bytes);

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
    std::fs::write(
        temp.path().join("server.trace.ndjson"),
        "{\"name\":\"trace\",\"authorization\":\"Bearer trace-secret\"}\n",
    )
    .expect("write server trace");
    let service = DiagnosticBundleService::new(temp.path());

    let bundle = service
        .build(
            "request api_key=frontend-secret\nurl=https://user:password@example.com/path\n"
                .to_owned(),
            generated_at(),
        )
        .await
        .expect("diagnostic bundle");
    let entries = zip_entries(&bundle.bytes);
    let combined = entries.values().cloned().collect::<String>();

    assert!(combined.contains("[REDACTED]"));
    assert!(!combined.contains("server-secret"));
    assert!(!combined.contains("trace-secret"));
    assert!(!combined.contains("frontend-secret"));
    assert!(!combined.contains("user:password"));
}

#[tokio::test]
async fn reads_the_zip4_legacy_fixture_with_redaction_and_placeholders() {
    let bytes = include_bytes!("fixtures/diagnostic-bundle-v4.zip");
    let (names, entries) = validated_zip_entries(bytes).expect("read Zip 4 fixture");

    assert_eq!(
        names,
        vec!["server.log", "server.trace.ndjson", "frontend.log"]
    );
    assert!(entries["server.log"].contains("[REDACTED]"));
    assert!(!entries["server.log"].contains("legacy-secret"));
    assert_eq!(
        entries["server.trace.ndjson"],
        "No retained server trace records were found.\n"
    );
    assert_eq!(
        entries["frontend.log"],
        "No frontend warnings or errors were captured.\n"
    );
}

#[test]
fn rejects_path_traversal_entry_names() {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file("../outside.log", options)
        .expect("write malicious fixture entry");
    writer.write_all(b"must not escape").expect("write entry");
    let bytes = writer.finish().expect("finish fixture").into_inner();

    assert_eq!(
        validated_zip_entries(&bytes).expect_err("traversal must be rejected"),
        "unsafe diagnostic archive entry: ../outside.log"
    );
}

#[tokio::test]
async fn current_bundle_is_listable_by_the_native_archive_tool() {
    let temp = TempDir::new().expect("temporary logs directory");
    let bundle = DiagnosticBundleService::new(temp.path())
        .build(String::new(), generated_at())
        .await
        .expect("diagnostic bundle");
    let archive_path = temp.path().join(&bundle.filename);
    std::fs::write(&archive_path, bundle.bytes).expect("write diagnostic archive");

    let output = if cfg!(windows) {
        Command::new("tar")
            .args(["-tf", archive_path.to_str().expect("UTF-8 archive path")])
            .output()
            .expect("Windows tar should list Zip archives")
    } else {
        Command::new("unzip")
            .args(["-t", archive_path.to_str().expect("UTF-8 archive path")])
            .output()
            .expect("unzip should validate Zip archives")
    };
    assert!(
        output.status.success(),
        "native archive validation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let listing = String::from_utf8_lossy(&output.stdout);
    for entry in ["server.log", "server.trace.ndjson", "frontend.log"] {
        assert!(listing.contains(entry), "missing {entry} in {listing}");
    }
}
