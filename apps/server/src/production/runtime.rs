use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use axum::http::StatusCode;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::process::Command;

use crate::{
    ServerConfig,
    assets::{AssetAccess, ResolvedAsset},
    auth::AuthService,
    diagnostics::{DiagnosticsMonitor, NativeProcessSampler, TraceDiagnosticsStore},
    mcp::preview_automation::PreviewAutomationBroker,
    observability::BrowserTraceCollector,
    orchestration::{EngineOptions, OrchestrationCommand, OrchestrationEngine, load_snapshot},
    persistence::{Database, Repositories},
    preview::PreviewManager,
    production::{
        control::NativeServerControl,
        git_vcs::{GitVcsRpcServices, register_git_vcs_rpc},
        http_routes::{
            AssetHttpResponse, HttpRouteError, JsonOperation, JsonRouteResponse, RouteContext,
        },
        orchestration_effects::{
            BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
        },
        orchestration_rpc::register_orchestration_rpc_with_provider,
        provider_runtime::{
            NativeProviderDriverFactory, ProviderRuntimeSupervisor, SupervisorOptions,
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
    orchestration_effects: OrchestrationEffects,
    trace_collector: BrowserTraceCollector,
    trace_diagnostics: TraceDiagnosticsStore,
}

impl ProductionRuntime {
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
        let provider_runtime = Arc::new(ProviderRuntimeSupervisor::start(
            orchestration.clone(),
            Arc::new(NativeProviderDriverFactory),
            SupervisorOptions::default(),
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
            TerminalManager::default(),
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
                return Ok(Some(PathBuf::from(path)));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| PathBuf::from(project.workspace_root)))
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
                return Ok(Some(PathBuf::from(worktree)));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| PathBuf::from(project.workspace_root)))
        })
    }
}

struct GitReviewBackend;

impl ReviewBackend for GitReviewBackend {
    fn get_diff_preview<'a>(
        &'a self,
        input: &'a ReviewDiffPreviewInput,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<ReviewDiffPreviewResult>, ReviewError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let mut command = Command::new("git");
            command
                .arg("-C")
                .arg(&input.cwd)
                .args(["diff", "--no-ext-diff"]);
            if input.ignore_whitespace.unwrap_or(false) {
                command.arg("--ignore-all-space");
            }
            if let Some(base_ref) = &input.base_ref {
                command.arg(base_ref);
            }
            command.arg("--");
            let output = command
                .output()
                .await
                .map_err(|error| ReviewError::Backend(error.to_string()))?;
            if !output.status.success() {
                return Err(ReviewError::Backend(
                    String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                ));
            }
            let diff = String::from_utf8_lossy(&output.stdout).into_owned();
            let sources = split_git_diff(&diff);
            Ok(Some(ReviewDiffPreviewResult {
                cwd: input.cwd.clone(),
                generated_at: now_millis(),
                sources,
            }))
        })
    }
}

fn split_git_diff(diff: &str) -> Vec<ReviewSource> {
    diff.split("diff --git ")
        .filter(|section| !section.trim().is_empty())
        .map(|section| {
            let path = section
                .lines()
                .find_map(|line| line.strip_prefix("+++ b/"))
                .unwrap_or("unknown")
                .to_owned();
            ReviewSource {
                path,
                diff: format!("diff --git {section}"),
            }
        })
        .collect()
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
