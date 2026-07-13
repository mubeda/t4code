use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use axum::http::StatusCode;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    assets::{AssetAccess, ResolvedAsset},
    auth::AuthService,
    diagnostics::{DiagnosticsMonitor, NativeProcessSampler, TraceDiagnosticsStore},
    git::GitRepository,
    mcp::preview_automation::PreviewAutomationBroker,
    observability::BrowserTraceCollector,
    orchestration::{EngineOptions, OrchestrationCommand, OrchestrationEngine, load_snapshot},
    persistence::{Database, Repositories, StatePaths},
    preview::PreviewManager,
    production::{
        connect_mcp::ConnectMcpService,
        control::NativeServerControl,
        git_vcs::{GitVcsRpcServices, register_git_vcs_rpc},
        http_routes::{
            AssetHttpResponse, HttpRouteError, JsonOperation, JsonRouteResponse, RouteContext,
        },
        operational_logs::{OperationalLogOptions, OperationalLogs},
        orchestration_effects::{
            BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
            SetupScriptLaunch, process_compatible_path,
        },
        orchestration_rpc::register_orchestration_rpc_with_provider,
        provider_runtime::{
            NativeProviderDriverFactory, ProviderRuntimeSupervisor, SupervisorOptions,
            reconcile_abandoned_provider_sessions,
        },
        relay::relay_client_service,
        server_terminal::{ServerTerminalServices, register_server_terminal_rpc},
        workspace_preview::{WorkspacePreviewRpcServices, register_workspace_preview_rpc},
    },
    provider_usage::{ProviderUsageService, production_fetchers},
    review::{
        ReviewBackend, ReviewDiffPreviewInput, ReviewDiffPreviewResult, ReviewError, ReviewService,
        ReviewSource,
    },
    rpc::RpcRegistry,
    terminal::TerminalManager,
    workspace::{AssetContextResolver, WorkspaceRpc, WorkspaceRpcDependencies, WorkspaceService},
};

pub struct ProductionRuntime {
    pub registry: RpcRegistry,
    pub orchestration: OrchestrationEngine,
    pub preview_automation: PreviewAutomationBroker,
    asset_access: AssetAccess,
    terminal_services: ServerTerminalServices,
    provider_runtime: Arc<ProviderRuntimeSupervisor>,
    operational_logs: OperationalLogs,
    orchestration_effects: OrchestrationEffects,
    trace_collector: BrowserTraceCollector,
    trace_diagnostics: TraceDiagnosticsStore,
}

impl ProductionRuntime {
    pub async fn attach_connect_mcp(&self, service: Arc<ConnectMcpService>) {
        self.provider_runtime.attach_connect_mcp(service).await;
    }

    pub async fn start(
        config: &ServerConfig,
        database: Database,
        auth: AuthService,
        asset_secret: Vec<u8>,
    ) -> Result<Self, String> {
        let orchestration = OrchestrationEngine::start(
            database,
            EngineOptions {
                queue_capacity: 128,
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        let repositories = orchestration.repositories();
        reconcile_abandoned_provider_sessions(&orchestration)
            .await
            .map_err(|error| error.to_string())?;
        let terminal_manager = TerminalManager::default();
        let state_paths = StatePaths::from_config(config);
        let operational_logs = OperationalLogs::start(
            &state_paths,
            &terminal_manager,
            OperationalLogOptions::default(),
        )
        .await?;
        let provider_runtime = Arc::new(ProviderRuntimeSupervisor::start_with_operational_log(
            orchestration.clone(),
            Arc::new(NativeProviderDriverFactory::new(
                state_paths.attachments_dir.clone(),
            )),
            SupervisorOptions::default(),
            operational_logs.provider(),
        ));
        let asset_access = AssetAccess::new(asset_secret, config.state_dir().join("attachments"));
        let workspace = WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                asset_access: Some(asset_access.clone()),
                asset_context_resolver: Some(Arc::new(ProjectionAssetContext { repositories })),
                review_service: Some(ReviewService::new(Arc::new(GitReviewBackend))),
            },
        );
        let workspace_for_effects = workspace.clone();
        let preview = PreviewManager::new();
        let preview_automation = PreviewAutomationBroker::new();
        let trace_collector = BrowserTraceCollector::default();
        let trace_diagnostics =
            TraceDiagnosticsStore::new(config.state_dir().join("logs/server.trace.ndjson"));
        let workspace_preview =
            WorkspacePreviewRpcServices::new(workspace, preview, preview_automation.clone());

        let process_sampler = Arc::new(NativeProcessSampler::default());
        let process_monitor = Arc::new(DiagnosticsMonitor::new(
            process_sampler.clone(),
            Duration::from_secs(2),
        ));
        let provider_usage =
            ProviderUsageService::new(production_fetchers(), Arc::new(OffsetDateTime::now_utc));
        let relay = relay_client_service(config.state_dir());
        let auth_descriptor =
            serde_json::to_value(auth.descriptor()).map_err(|error| error.to_string())?;
        let control = Arc::new(
            NativeServerControl::with_trace_diagnostics(
                config.clone(),
                auth_descriptor,
                trace_diagnostics.clone(),
            )
            .await,
        );
        let terminal_services = ServerTerminalServices::new(
            terminal_manager,
            process_sampler,
            process_monitor,
            provider_usage,
            relay,
            control,
        );
        let orchestration_effects = OrchestrationEffects::start(
            orchestration.clone(),
            Arc::new(RuntimeEffectCallbacks {
                repositories: orchestration.repositories(),
                provider: provider_runtime.clone(),
                terminals: terminal_services.clone(),
                workspace: workspace_for_effects,
            }),
            EffectsOptions::default(),
        )
        .await
        .map_err(|error| error.to_string())?;

        let mut registry = RpcRegistry::with_trace_diagnostics(trace_diagnostics.clone());
        crate::auth::register_rpc_handlers(&mut registry, auth);
        register_orchestration_rpc_with_provider(
            &mut registry,
            orchestration.clone(),
            provider_runtime.clone(),
            config.state_dir(),
        );
        register_workspace_preview_rpc(&mut registry, workspace_preview);
        register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
        register_server_terminal_rpc(&mut registry, terminal_services.clone());
        registry.validate_complete()?;

        Ok(Self {
            registry,
            orchestration,
            preview_automation,
            asset_access,
            terminal_services,
            provider_runtime,
            operational_logs,
            orchestration_effects,
            trace_collector,
            trace_diagnostics,
        })
    }

    pub async fn json(
        &self,
        operation: JsonOperation,
        payload: Option<Value>,
        _context: RouteContext,
    ) -> Result<JsonRouteResponse, HttpRouteError> {
        match operation {
            JsonOperation::OrchestrationSnapshot => {
                let snapshot = load_snapshot(&self.orchestration.repositories())
                    .await
                    .map_err(internal_error)?;
                Ok(JsonRouteResponse::ok(
                    serde_json::to_value(snapshot).map_err(internal_error)?,
                ))
            }
            JsonOperation::OrchestrationDispatch => {
                let mut command: OrchestrationCommand = serde_json::from_value(
                    payload.ok_or_else(|| bad_request("Request body is required."))?,
                )
                .map_err(bad_request)?;
                crate::production::orchestration_effects::normalize_project_create_command(
                    &mut command,
                )
                .await
                .map_err(bad_request)?;
                let result = self
                    .orchestration
                    .dispatch(command)
                    .await
                    .map_err(internal_error)?;
                Ok(JsonRouteResponse::ok(
                    serde_json::to_value(result).map_err(internal_error)?,
                ))
            }
            JsonOperation::ObservabilityTraces => {
                let payload = payload.ok_or_else(|| bad_request("Trace payload is required."))?;
                self.trace_collector.record_payload(payload.clone());
                self.trace_diagnostics
                    .record_otlp_payload(&payload)
                    .map_err(internal_error)?;
                Ok(JsonRouteResponse {
                    status: StatusCode::ACCEPTED,
                    headers: Default::default(),
                    body: json!({}),
                })
            }
            _ => Err(bad_request("Unsupported core HTTP operation.")),
        }
    }

    #[must_use]
    pub fn trace_records(&self) -> Vec<Value> {
        self.trace_collector.records()
    }

    pub async fn asset(
        &self,
        token: String,
        path: String,
    ) -> Result<AssetHttpResponse, HttpRouteError> {
        let resolved = self
            .asset_access
            .resolve(&token, &path)
            .await
            .ok_or_else(|| {
                HttpRouteError::new(
                    StatusCode::NOT_FOUND,
                    json!({
                        "_tag": "AssetNotFoundError",
                        "message": "Asset was not found or its access token expired."
                    }),
                )
            })?;
        match resolved {
            ResolvedAsset::File(file) => {
                let bytes = tokio::fs::read(&file).await.map_err(internal_error)?;
                let content_type = mime_guess::from_path(&file)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_owned();
                Ok(AssetHttpResponse {
                    content_type,
                    bytes,
                    cache_control: "private, max-age=3600".to_owned(),
                })
            }
            ResolvedAsset::ProjectFaviconFallback => Ok(AssetHttpResponse {
                content_type: "image/svg+xml".to_owned(),
                bytes: FALLBACK_FAVICON.as_bytes().to_vec(),
                cache_control: "private, max-age=3600".to_owned(),
            }),
        }
    }

    pub async fn shutdown(&self) {
        self.orchestration_effects.shutdown().await;
        let _ = self.provider_runtime.shutdown().await;
        self.terminal_services.shutdown().await;
        if let Err(error) = self.operational_logs.shutdown().await {
            tracing::warn!(%error, "failed to shut down operational logs cleanly");
        }
        self.orchestration.shutdown().await;
    }
}

#[derive(Clone)]
struct RuntimeEffectCallbacks {
    repositories: Repositories,
    provider: Arc<ProviderRuntimeSupervisor>,
    terminals: ServerTerminalServices,
    workspace: WorkspaceRpc,
}

impl OrchestrationEffectCallbacks for RuntimeEffectCallbacks {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            let Some(thread) = self
                .repositories
                .get_thread(thread_id.to_owned())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            if let Some(path) = thread.worktree_path {
                return Ok(Some(process_compatible_path(PathBuf::from(path))));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
        })
    }

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.provider
                .handle_orchestration(OrchestrationCommand::ThreadCheckpointRevert {
                    command_id: format!("effects:provider-rollback:{}", uuid::Uuid::new_v4()),
                    thread_id: thread_id.to_owned(),
                    turn_count: turns,
                    created_at: now_iso(),
                })
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            match self
                .provider
                .handle_orchestration(OrchestrationCommand::ThreadSessionStop {
                    command_id: format!("effects:provider-stop:{}", uuid::Uuid::new_v4()),
                    thread_id: thread_id.to_owned(),
                    created_at: now_iso(),
                })
                .await
            {
                Ok(())
                | Err(
                    crate::production::provider_runtime::ProviderRuntimeError::SessionNotFound {
                        ..
                    },
                ) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })
    }

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.terminals.close_thread_terminals(thread_id).await;
            Ok(())
        })
    }

    fn refresh_workspace<'a>(&'a self, cwd: &'a std::path::Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.workspace.refresh_index(cwd).await;
            Ok(())
        })
    }

    fn launch_setup_script<'a>(&'a self, input: SetupScriptLaunch) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move { self.terminals.launch_setup_script(input).await })
    }
}

#[derive(Clone)]
struct ProjectionAssetContext {
    repositories: Repositories,
}

impl AssetContextResolver for ProjectionAssetContext {
    fn resolve_workspace_root<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PathBuf>, String>> + Send + 'a>> {
        Box::pin(async move {
            let Some(thread) = self
                .repositories
                .get_thread(thread_id.to_owned())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            if let Some(worktree) = thread.worktree_path {
                return Ok(Some(process_compatible_path(PathBuf::from(worktree))));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
        })
    }
}

struct GitReviewBackend;

const MAX_UNTRACKED_REVIEW_FILES: usize = 500;
const MAX_UNTRACKED_REVIEW_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_UNTRACKED_REVIEW_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

impl ReviewBackend for GitReviewBackend {
    fn get_diff_preview<'a>(
        &'a self,
        input: &'a ReviewDiffPreviewInput,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<ReviewDiffPreviewResult>, ReviewError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let cancellation = CancellationToken::new();
            let status = GitRepository::default()
                .local_status(Path::new(&input.cwd), &cancellation)
                .await
                .map_err(|error| ReviewError::Backend(error.to_string()))?;
            if !status.is_repo {
                return Ok(Some(ReviewDiffPreviewResult {
                    cwd: input.cwd.clone(),
                    generated_at: now_millis(),
                    sources: Vec::new(),
                }));
            }

            let ignore_whitespace = input.ignore_whitespace.unwrap_or(false);
            let tracked_worktree = run_review_diff(
                &input.cwd,
                review_diff_args(ignore_whitespace, Some("HEAD"), false),
            )
            .await?;
            let untracked = untracked_review_diff(&input.cwd).await?;
            let working_tree_diff = join_review_diffs(&tracked_worktree, &untracked.diff);

            let base_ref = input.base_ref.clone().or(status.default_ref_name);
            let branch_diff = match (&base_ref, &status.ref_name) {
                (Some(base_ref), Some(_)) => {
                    let range = format!("{base_ref}...HEAD");
                    run_review_diff(
                        &input.cwd,
                        review_diff_args(ignore_whitespace, Some(&range), true),
                    )
                    .await?
                }
                _ => String::new(),
            };
            let sources = vec![
                review_source(
                    "working-tree",
                    "working-tree",
                    "Dirty worktree",
                    Some("HEAD".to_owned()),
                    None,
                    working_tree_diff,
                    untracked.truncated,
                ),
                review_source(
                    "branch-range",
                    "branch-range",
                    base_ref.as_ref().map_or_else(
                        || "Against base branch".to_owned(),
                        |base| format!("Against {base}"),
                    ),
                    base_ref,
                    Some(status.ref_name.unwrap_or_else(|| "HEAD".to_owned())),
                    branch_diff,
                    false,
                ),
            ];
            Ok(Some(ReviewDiffPreviewResult {
                cwd: input.cwd.clone(),
                generated_at: now_millis(),
                sources,
            }))
        })
    }
}

struct UntrackedReviewDiff {
    diff: String,
    truncated: bool,
}

fn review_diff_args(ignore_whitespace: bool, target: Option<&str>, three_dot: bool) -> Vec<String> {
    let mut args = vec![
        "diff".to_owned(),
        "--no-ext-diff".to_owned(),
        "--patch".to_owned(),
        "--minimal".to_owned(),
    ];
    if ignore_whitespace {
        args.push("--ignore-all-space".to_owned());
    }
    if let Some(target) = target {
        args.push(target.to_owned());
    }
    if !three_dot {
        args.push("--".to_owned());
    }
    args
}

async fn run_review_diff(cwd: &str, args: Vec<String>) -> Result<String, ReviewError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .await
        .map_err(|error| ReviewError::Backend(error.to_string()))?;
    Ok(if output.status.success() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        String::new()
    })
}

fn join_review_diffs(left: &str, right: &str) -> String {
    [left.trim_end(), right.trim_end()]
        .into_iter()
        .filter(|diff| !diff.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn review_source(
    id: &str,
    kind: &str,
    title: impl Into<String>,
    base_ref: Option<String>,
    head_ref: Option<String>,
    diff: String,
    truncated: bool,
) -> ReviewSource {
    let diff_hash = format!("{:x}", Sha256::digest(diff.as_bytes()));
    ReviewSource {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.into(),
        base_ref,
        head_ref,
        diff,
        diff_hash,
        truncated,
    }
}

async fn untracked_review_diff(cwd: &str) -> Result<UntrackedReviewDiff, ReviewError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args([
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await
        .map_err(|error| ReviewError::Backend(error.to_string()))?;
    if !output.status.success() {
        return Err(ReviewError::Backend(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }

    let root = PathBuf::from(cwd);
    let mut total_bytes = 0_u64;
    let mut diffs = Vec::new();
    let mut truncated = false;
    for path in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .take(MAX_UNTRACKED_REVIEW_FILES)
    {
        let path = String::from_utf8_lossy(path).into_owned();
        let absolute = root.join(&path);
        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        if metadata.len() > MAX_UNTRACKED_REVIEW_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_UNTRACKED_REVIEW_TOTAL_BYTES
        {
            diffs.push(binary_untracked_diff(&path));
            truncated = true;
            continue;
        }
        let contents = tokio::fs::read(&absolute)
            .await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        total_bytes = total_bytes.saturating_add(contents.len() as u64);
        diffs.push(if contents.contains(&0) {
            binary_untracked_diff(&path)
        } else {
            text_untracked_diff(&path, &String::from_utf8_lossy(&contents))
        });
    }
    Ok(UntrackedReviewDiff {
        diff: diffs.join("\n"),
        truncated,
    })
}

fn binary_untracked_diff(path: &str) -> String {
    format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
    )
}

fn text_untracked_diff(path: &str, contents: &str) -> String {
    let line_count = contents.lines().count();
    let mut diff = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in contents.split_inclusive('\n') {
        diff.push('+');
        diff.push_str(line);
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        diff.push('\n');
        diff.push_str("\\ No newline at end of file\n");
    }
    diff
}

fn bad_request(error: impl std::fmt::Display) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::BAD_REQUEST,
        json!({
            "_tag": "EnvironmentHttpBadRequestError",
            "message": error.to_string(),
        }),
    )
}

fn internal_error(error: impl std::fmt::Display) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({
            "_tag": "EnvironmentHttpInternalServerError",
            "message": error.to_string(),
        }),
    )
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

const FALLBACK_FAVICON: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#171717"/><path d="M17 19h30v8H36v22h-8V27H17z" fill="#fafafa"/></svg>"##;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn git_review_backend_includes_untracked_files() {
        let repository = TempDir::new().expect("temporary repository");
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(repository.path())
                .status()
                .expect("git starts")
                .success()
        );
        std::fs::write(repository.path().join("untracked.txt"), "first\nsecond\n")
            .expect("write untracked fixture");

        let input = ReviewDiffPreviewInput {
            cwd: repository.path().to_string_lossy().into_owned(),
            base_ref: None,
            ignore_whitespace: Some(false),
        };
        let preview = GitReviewBackend
            .get_diff_preview(&input)
            .await
            .expect("review succeeds")
            .expect("review preview");

        assert_eq!(preview.sources.len(), 2);
        assert_eq!(preview.sources[0].kind, "working-tree");
        assert!(preview.sources[0].diff.contains("+++ b/untracked.txt"));
        assert!(preview.sources[0].diff.contains("+first"));
        assert!(preview.sources[0].diff.contains("+second"));
        assert_eq!(preview.sources[1].kind, "branch-range");
    }

    #[tokio::test]
    async fn git_review_backend_includes_staged_changes_and_branch_range() {
        let repository = TempDir::new().expect("temporary repository");
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(repository.path())
                .output()
                .expect("git starts");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.email", "test@t4code.local"]);
        git(&["config", "user.name", "T4Code Test"]);
        std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);
        git(&["switch", "--quiet", "-c", "feature"]);
        std::fs::write(repository.path().join("branch.txt"), "feature\n").expect("write branch");
        git(&["add", "branch.txt"]);
        git(&["commit", "--quiet", "-m", "feature"]);
        std::fs::write(repository.path().join("tracked.txt"), "staged\n").expect("write staged");
        git(&["add", "tracked.txt"]);

        let input = ReviewDiffPreviewInput {
            cwd: repository.path().to_string_lossy().into_owned(),
            base_ref: None,
            ignore_whitespace: Some(false),
        };
        let preview = GitReviewBackend
            .get_diff_preview(&input)
            .await
            .expect("review succeeds")
            .expect("review preview");

        assert!(preview.sources[0].diff.contains("+++ b/tracked.txt"));
        assert!(preview.sources[0].diff.contains("+staged"));
        assert_eq!(preview.sources[1].base_ref.as_deref(), Some("main"));
        assert!(preview.sources[1].diff.contains("+++ b/branch.txt"));
        assert!(preview.sources[1].diff.contains("+feature"));
    }
}
