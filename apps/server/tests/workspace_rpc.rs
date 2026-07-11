use t4code_server::{assets, project, review, workspace};

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use assets::{AssetAccess, AssetIssueRequest, AssetResource, ResolvedAsset};
use project::ProjectFaviconResolver;
use review::{ReviewBackend, ReviewDiffPreviewInput, ReviewService};
use serde_json::json;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use workspace::{
    AssetContextResolver, EntryKind, SearchLimits, WorkspaceError, WorkspaceRpc,
    WorkspaceRpcDependencies, WorkspaceSearchIndex, WorkspaceService, WorkspaceWatcher,
};

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

async fn write(root: &Path, relative: &str, contents: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.expect("parent");
    }
    tokio::fs::write(path, contents)
        .await
        .expect("write fixture");
}

struct StaticAssetContextResolver {
    roots: std::collections::HashMap<String, PathBuf>,
    failing_thread_id: Option<String>,
}

impl AssetContextResolver for StaticAssetContextResolver {
    fn resolve_workspace_root<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<PathBuf>, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if self.failing_thread_id.as_deref() == Some(thread_id) {
                return Err("projection lookup failed".to_owned());
            }
            Ok(self.roots.get(thread_id).cloned())
        })
    }
}

#[tokio::test]
async fn workspace_rpc_rejects_traversal_and_preserves_wire_error_tag() {
    let root = TempDir::new().expect("root");
    let outside = root.path().parent().expect("parent").join("outside.txt");
    tokio::fs::write(&outside, "secret").await.expect("outside");
    let rpc = WorkspaceRpc::new(WorkspaceService::default());

    let error = rpc
        .handle(
            "projects.readFile",
            json!({"cwd": path_string(root.path()), "relativePath": "../outside.txt"}),
        )
        .await
        .expect_err("traversal must fail");

    assert_eq!(error["_tag"], "ProjectReadFileError");
    assert_eq!(error["failure"], "workspace_path_outside_root");
    assert!(!error.to_string().contains("secret"));
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_rpc_rejects_symlink_escape_for_read_and_delete() {
    use std::os::unix::fs::symlink;

    let root = TempDir::new().expect("root");
    let outside = TempDir::new().expect("outside");
    write(outside.path(), "secret.txt", b"secret").await;
    symlink(outside.path(), root.path().join("escape")).expect("symlink");
    let rpc = WorkspaceRpc::new(WorkspaceService::default());
    let cwd = path_string(root.path());

    for (method, payload) in [
        (
            "projects.readFile",
            json!({"cwd": cwd, "relativePath": "escape/secret.txt"}),
        ),
        (
            "projects.deleteEntry",
            json!({"cwd": cwd, "relativePath": "escape/secret.txt"}),
        ),
    ] {
        let error = rpc.handle(method, payload).await.expect_err("escape");
        assert_eq!(error["failure"], "resolved_path_outside_root");
    }
    assert!(outside.path().join("secret.txt").exists());
}

#[tokio::test]
async fn reads_are_binary_safe_and_bounded_to_one_mebibyte() {
    let root = TempDir::new().expect("root");
    write(root.path(), "binary.dat", b"visible\0secret").await;
    write(root.path(), "large.txt", &vec![b'a'; 1024 * 1024 + 17]).await;
    let service = WorkspaceService::default();

    let binary = service
        .read_file(root.path(), "binary.dat")
        .await
        .expect_err("binary");
    assert!(matches!(binary, WorkspaceError::BinaryFile { .. }));

    let large = service
        .read_file(root.path(), "large.txt")
        .await
        .expect("large");
    assert_eq!(large.contents.len(), 1024 * 1024);
    assert_eq!(large.byte_length, 1024 * 1024 + 17);
    assert!(large.truncated);
}

#[tokio::test]
async fn search_honors_ignores_pagination_and_memory_limits() {
    let root = TempDir::new().expect("root");
    write(
        root.path(),
        ".gitignore",
        "ignored.txt\n.convex/\n".as_bytes(),
    )
    .await;
    write(root.path(), "src/components/Composer.tsx", b"").await;
    write(root.path(), "src/index.ts", b"").await;
    write(root.path(), "ignored.txt", b"").await;
    write(root.path(), ".convex/local/data.json", b"").await;
    write(root.path(), "node_modules/pkg/index.js", b"").await;
    let index = WorkspaceSearchIndex::new(
        root.path().to_path_buf(),
        SearchLimits {
            max_entries: 4,
            max_memory_bytes: 1024,
            ..SearchLimits::default()
        },
    );
    index
        .refresh(CancellationToken::new())
        .await
        .expect("refresh");

    let listed = index.list().await;
    assert!(listed.truncated);
    assert!(listed.entries.iter().all(|entry| {
        !entry.path.starts_with("node_modules") && !entry.path.starts_with(".convex")
    }));
    assert!(
        !listed
            .entries
            .iter()
            .any(|entry| entry.path == "ignored.txt")
    );

    let searched = index.search("cmp", 1).await;
    assert_eq!(searched.entries[0].path, "src/components/Composer.tsx");
    assert!(searched.truncated);
    assert!(index.memory_bytes().await <= 1024);
}

#[tokio::test]
async fn cancelled_index_refresh_does_not_replace_the_previous_snapshot() {
    let root = TempDir::new().expect("root");
    write(root.path(), "before.txt", b"").await;
    let index = WorkspaceSearchIndex::new(root.path().to_path_buf(), SearchLimits::default());
    index
        .refresh(CancellationToken::new())
        .await
        .expect("first refresh");
    write(root.path(), "after.txt", b"").await;
    let cancelled = CancellationToken::new();
    cancelled.cancel();

    assert!(matches!(
        index.refresh(cancelled).await,
        Err(WorkspaceError::Cancelled)
    ));
    let listed = index.list().await;
    assert!(
        listed
            .entries
            .iter()
            .any(|entry| entry.path == "before.txt")
    );
    assert!(!listed.entries.iter().any(|entry| entry.path == "after.txt"));
}

#[tokio::test]
async fn watcher_coalesces_bursts_and_stops_when_subscription_is_cancelled() {
    let root = TempDir::new().expect("root");
    let watcher = WorkspaceWatcher::new(Duration::from_millis(20), Duration::from_millis(50), 2);
    let mut subscription = watcher.watch(root.path().to_path_buf());

    for sequence in 0..8 {
        write(root.path(), "burst.txt", sequence.to_string().as_bytes()).await;
    }
    let event = tokio::time::timeout(Duration::from_secs(2), subscription.recv())
        .await
        .expect("watch timeout")
        .expect("watch event");
    assert!(
        event
            .changed_paths
            .iter()
            .any(|path| path.ends_with("burst.txt"))
    );
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert!(
        subscription.try_recv().is_err(),
        "burst should be coalesced"
    );

    subscription.cancel();
    tokio::time::timeout(Duration::from_secs(1), subscription.stopped())
        .await
        .expect("watcher cancellation");
    assert_eq!(watcher.active_watchers(), 0);
}

#[tokio::test]
async fn browse_shows_hidden_directories_for_directory_and_hidden_prefix_modes() {
    let root = TempDir::new().expect("root");
    write(root.path(), ".config/settings.json", b"{}").await;
    write(root.path(), "config/settings.json", b"{}").await;
    let service = WorkspaceService::default();
    let cwd_with_separator = format!(
        "{}{}",
        root.path().to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );

    let directory_result = service
        .browse(&cwd_with_separator, None)
        .await
        .expect("directory browse");
    assert_eq!(
        directory_result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec![".config", "config"]
    );

    let hidden_prefix_result = service
        .browse(&format!("{cwd_with_separator}.c"), None)
        .await
        .expect("hidden browse");
    assert_eq!(
        hidden_prefix_result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec![".config"]
    );
}

#[tokio::test]
async fn mutations_create_move_duplicate_and_delete_entries() {
    let root = TempDir::new().expect("root");
    let service = WorkspaceService::default();
    service
        .create_entry(root.path(), "src/a.txt", EntryKind::File)
        .await
        .expect("create");
    service
        .write_file(root.path(), "src/a.txt", "hello")
        .await
        .expect("write");
    let duplicate = service
        .duplicate_entry(root.path(), "src/a.txt")
        .await
        .expect("duplicate");
    assert_eq!(duplicate, "src/a copy.txt");
    service
        .rename_entry(root.path(), "src/a copy.txt", "moved/b.txt")
        .await
        .expect("rename");
    service
        .delete_entry(root.path(), "moved")
        .await
        .expect("delete");
    assert!(!root.path().join("moved").exists());
}

#[tokio::test]
async fn workspace_rpc_invalidates_cached_indexes_after_mutations() {
    let root = TempDir::new().expect("root");
    write(root.path(), "src/existing.ts", b"export {};\n").await;
    let rpc = WorkspaceRpc::new(WorkspaceService::default());
    let cwd = path_string(root.path());

    let initial = rpc
        .handle("projects.listEntries", json!({ "cwd": cwd }))
        .await
        .expect("initial list");
    assert!(
        !initial["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "plans/added.md")
    );

    rpc.handle(
        "projects.writeFile",
        json!({ "cwd": cwd, "relativePath": "plans/added.md", "contents": "# Plan\n" }),
    )
    .await
    .expect("write");
    let after_write = rpc
        .handle("projects.listEntries", json!({ "cwd": cwd }))
        .await
        .expect("list after write");
    assert!(
        after_write["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "plans/added.md")
    );

    rpc.handle(
        "projects.duplicateEntry",
        json!({ "cwd": cwd, "relativePath": "src/existing.ts" }),
    )
    .await
    .expect("duplicate");
    let after_duplicate = rpc
        .handle("projects.listEntries", json!({ "cwd": cwd }))
        .await
        .expect("list after duplicate");
    assert!(
        after_duplicate["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "src/existing copy.ts")
    );

    rpc.handle(
        "projects.renameEntry",
        json!({
            "cwd": cwd,
            "fromRelativePath": "plans/added.md",
            "toRelativePath": "docs/renamed.md"
        }),
    )
    .await
    .expect("rename");
    let after_rename = rpc
        .handle("projects.listEntries", json!({ "cwd": cwd }))
        .await
        .expect("list after rename");
    assert!(
        after_rename["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "docs/renamed.md")
    );
    assert!(
        !after_rename["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "plans/added.md")
    );

    rpc.handle(
        "projects.deleteEntry",
        json!({ "cwd": cwd, "relativePath": "docs/renamed.md" }),
    )
    .await
    .expect("delete");
    let after_delete = rpc
        .handle("projects.listEntries", json!({ "cwd": cwd }))
        .await
        .expect("list after delete");
    assert!(
        !after_delete["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "docs/renamed.md")
    );
}

#[tokio::test]
async fn browse_filters_files_sorts_directories_and_requires_cwd_for_relative_paths() {
    let root = TempDir::new().expect("root");
    write(root.path(), "alpha/file.txt", b"").await;
    write(root.path(), "alpine/file.txt", b"").await;
    write(root.path(), "alphabet.txt", b"").await;
    let service = WorkspaceService::default();
    let partial = format!(
        "{}{}alp",
        root.path().to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    let result = service.browse(&partial, None).await.expect("browse");
    assert_eq!(
        result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "alpine"]
    );
    assert!(matches!(
        service.browse("./src", None).await,
        Err(WorkspaceError::CurrentProjectRequired { .. })
    ));
}

#[tokio::test]
async fn workspace_rpc_routes_asset_urls_through_workspace_context_resolution() {
    let root = TempDir::new().expect("root");
    write(root.path(), "preview/report.html", b"<html></html>").await;
    write(root.path(), "preview/report.css", b"body{}").await;
    let access = AssetAccess::new(vec![4; 32], root.path().join("attachments"));
    let rpc = WorkspaceRpc::with_dependencies(
        WorkspaceService::default(),
        WorkspaceRpcDependencies {
            asset_access: Some(access.clone()),
            asset_context_resolver: Some(Arc::new(StaticAssetContextResolver {
                roots: std::collections::HashMap::from([(
                    "thread-1".to_owned(),
                    root.path().to_path_buf(),
                )]),
                failing_thread_id: Some("thread-error".to_owned()),
            })),
            review_service: None,
        },
    );

    let issued = rpc
        .handle(
            "assets.createUrl",
            json!({
                "resource": {
                    "_tag": "workspace-file",
                    "threadId": "thread-1",
                    "path": "preview/report.html"
                }
            }),
        )
        .await
        .expect("asset URL");
    let relative_url = issued["relativeUrl"].as_str().expect("relativeUrl");
    let token = relative_url.split('/').nth(3).expect("token");
    assert!(matches!(
        access.resolve(token, "report.css").await,
        Some(ResolvedAsset::File(_))
    ));

    let missing = rpc
        .handle(
            "assets.createUrl",
            json!({
                "resource": {
                    "_tag": "workspace-file",
                    "threadId": "thread-missing",
                    "path": "preview/report.html"
                }
            }),
        )
        .await
        .expect_err("missing workspace context");
    assert_eq!(missing["_tag"], "AssetWorkspaceContextNotFoundError");

    let failed = rpc
        .handle(
            "assets.createUrl",
            json!({
                "resource": {
                    "_tag": "workspace-file",
                    "threadId": "thread-error",
                    "path": "preview/report.html"
                }
            }),
        )
        .await
        .expect_err("failed workspace context");
    assert_eq!(failed["_tag"], "AssetWorkspaceContextResolutionError");
}

#[tokio::test]
async fn signed_assets_are_exact_or_confined_to_safe_preview_siblings() {
    let root = TempDir::new().expect("root");
    write(root.path(), "preview/report.html", b"<html></html>").await;
    write(root.path(), "preview/report.css", b"body{}").await;
    write(root.path(), "preview/.env", b"secret").await;
    write(root.path(), "image.png", b"png").await;
    let access = AssetAccess::new(vec![9; 32], root.path().join("attachments"));

    let html = access
        .issue(AssetIssueRequest {
            resource: AssetResource::WorkspaceFile {
                thread_id: "thread-1".to_owned(),
                path: "preview/report.html".to_owned(),
            },
            workspace_root: Some(root.path().to_path_buf()),
        })
        .await
        .expect("asset URL");
    let token = html.relative_url.split('/').nth(3).expect("token");
    assert!(matches!(
        access.resolve(token, "report.css").await,
        Some(ResolvedAsset::File(_))
    ));
    assert_eq!(access.resolve(token, "../secret.txt").await, None);
    assert_eq!(access.resolve(token, ".env").await, None);

    let image = access
        .issue(AssetIssueRequest {
            resource: AssetResource::WorkspaceFile {
                thread_id: "thread-1".to_owned(),
                path: "image.png".to_owned(),
            },
            workspace_root: Some(root.path().to_path_buf()),
        })
        .await
        .expect("image URL");
    let token = image.relative_url.split('/').nth(3).expect("token");
    assert!(access.resolve(token, "image.png").await.is_some());
    assert_eq!(access.resolve(token, "report.css").await, None);
}

#[tokio::test]
async fn signed_asset_capabilities_expire_and_never_follow_workspace_symlinks() {
    let root = TempDir::new().expect("root");
    let outside = TempDir::new().expect("outside");
    write(root.path(), "preview/report.html", b"<html></html>").await;
    write(outside.path(), "secret.css", b"secret").await;

    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.path().join("preview/escape"))
        .expect("symlink");

    let access = AssetAccess::with_ttl(
        vec![3; 32],
        root.path().join("attachments"),
        Duration::from_millis(1),
    );
    let issued = access
        .issue(AssetIssueRequest {
            resource: AssetResource::WorkspaceFile {
                thread_id: "thread-1".to_owned(),
                path: "preview/report.html".to_owned(),
            },
            workspace_root: Some(root.path().to_path_buf()),
        })
        .await
        .expect("asset URL");
    let token = issued.relative_url.split('/').nth(3).expect("token");

    #[cfg(unix)]
    assert_eq!(access.resolve(token, "escape/secret.css").await, None);
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(access.resolve(token, "report.css").await, None);
}

#[tokio::test]
async fn workspace_rpc_routes_review_requests_through_the_injected_service() {
    let service = ReviewService::new(Arc::new(EmptyReviewBackend));
    let rpc = WorkspaceRpc::with_dependencies(
        WorkspaceService::default(),
        WorkspaceRpcDependencies {
            asset_access: None,
            asset_context_resolver: None,
            review_service: Some(service),
        },
    );
    let cwd = path_string(TempDir::new().expect("cwd").path());

    let result = rpc
        .handle(
            "review.getDiffPreview",
            json!({ "cwd": cwd, "baseRef": null, "ignoreWhitespace": true }),
        )
        .await
        .expect("review result");

    assert_eq!(result["cwd"], cwd);
    assert_eq!(result["sources"], json!([]));
}

#[tokio::test]
async fn favicon_resolution_stays_within_the_project_and_reads_icon_metadata() {
    let root = TempDir::new().expect("root");
    write(
        root.path(),
        "index.html",
        br#"<link rel="icon" href="/brand/logo.svg">"#,
    )
    .await;
    write(root.path(), "public/brand/logo.svg", b"<svg/>").await;
    write(root.path(), "public/favicon.png", b"png").await;

    let resolver = ProjectFaviconResolver;
    let resolved = resolver.resolve_path(root.path()).await.expect("favicon");
    assert!(
        resolved
            .expect("preferred favicon")
            .ends_with("public/favicon.png")
    );

    tokio::fs::remove_file(root.path().join("public/favicon.png"))
        .await
        .expect("remove preferred icon");
    let resolved = resolver
        .resolve_path(root.path())
        .await
        .expect("metadata icon");
    assert!(
        resolved
            .expect("metadata favicon")
            .ends_with("public/brand/logo.svg")
    );
}

struct EmptyReviewBackend;

impl ReviewBackend for EmptyReviewBackend {
    fn get_diff_preview<'a>(
        &'a self,
        _input: &'a ReviewDiffPreviewInput,
    ) -> review::ReviewFuture<'a> {
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn review_accepts_projects_outside_server_root_and_returns_empty_sources() {
    let outside = TempDir::new().expect("outside");
    let service = ReviewService::new(Arc::new(EmptyReviewBackend));
    let result = service
        .get_diff_preview(ReviewDiffPreviewInput {
            cwd: path_string(outside.path()),
            base_ref: None,
            ignore_whitespace: None,
        })
        .await
        .expect("review");

    assert_eq!(result.cwd, path_string(outside.path()));
    assert!(result.sources.is_empty());
}

#[test]
fn owned_rpc_inventory_matches_task_six_contract_methods() {
    assert_eq!(
        workspace::TASK_SIX_RPC_METHODS,
        [
            "projects.searchEntries",
            "projects.listEntries",
            "projects.readFile",
            "projects.writeFile",
            "projects.createEntry",
            "projects.renameEntry",
            "projects.deleteEntry",
            "projects.duplicateEntry",
            "filesystem.browse",
            "assets.createUrl",
            "review.getDiffPreview",
        ]
    );
}

#[test]
fn fixture_paths_are_language_neutral() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/workspace/task6-cases.json");
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture).expect("fixture")).expect("json");
    assert_eq!(value["readLimitBytes"], 1024 * 1024);
    assert_eq!(value["maxSearchLimit"], 200);
}
