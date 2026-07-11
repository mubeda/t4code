use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use crate::assets::{AssetAccess, AssetError, AssetIssueRequest, AssetResource};
use crate::review::{ReviewDiffPreviewInput, ReviewError, ReviewService};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{EntryKind, SearchLimits, WorkspaceError, WorkspaceSearchIndex, WorkspaceService};

pub const TASK_SIX_RPC_METHODS: [&str; 11] = [
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
];

type AssetContextFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<PathBuf>, String>> + Send + 'a>>;

pub trait AssetContextResolver: Send + Sync {
    fn resolve_workspace_root<'a>(&'a self, thread_id: &'a str) -> AssetContextFuture<'a>;
}

#[derive(Clone, Default)]
pub struct WorkspaceRpcDependencies {
    pub asset_access: Option<AssetAccess>,
    pub asset_context_resolver: Option<Arc<dyn AssetContextResolver>>,
    pub review_service: Option<ReviewService>,
}

#[derive(Clone)]
pub struct WorkspaceRpc {
    service: WorkspaceService,
    indexes: Arc<Mutex<HashMap<PathBuf, WorkspaceSearchIndex>>>,
    dependencies: WorkspaceRpcDependencies,
}

impl WorkspaceRpc {
    pub fn new(service: WorkspaceService) -> Self {
        Self::with_dependencies(service, WorkspaceRpcDependencies::default())
    }

    pub fn with_dependencies(
        service: WorkspaceService,
        dependencies: WorkspaceRpcDependencies,
    ) -> Self {
        Self {
            service,
            indexes: Arc::new(Mutex::new(HashMap::new())),
            dependencies,
        }
    }

    pub async fn handle(&self, method: &str, payload: Value) -> Result<Value, Value> {
        match method {
            "projects.readFile" => {
                let input: PathInput = decode(payload)?;
                self.service
                    .read_file(Path::new(&input.cwd), &input.relative_path)
                    .await
                    .and_then(encode)
                    .map_err(|error| {
                        error.to_project_wire(
                            "ProjectReadFileError",
                            &input.cwd,
                            &input.relative_path,
                        )
                    })
            }
            "projects.writeFile" => {
                let input: WriteInput = decode(payload)?;
                let result = self
                    .service
                    .write_file(Path::new(&input.cwd), &input.relative_path, &input.contents)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectWriteFileError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.createEntry" => {
                let input: CreateInput = decode(payload)?;
                let result = self
                    .service
                    .create_entry(Path::new(&input.cwd), &input.relative_path, input.kind)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectCreateEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.renameEntry" => {
                let input: RenameInput = decode(payload)?;
                let result = self
                    .service
                    .rename_entry(
                        Path::new(&input.cwd),
                        &input.from_relative_path,
                        &input.to_relative_path,
                    )
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectRenameEntryError",
                        &input.cwd,
                        &input.from_relative_path,
                    )),
                }
            }
            "projects.deleteEntry" => {
                let input: PathInput = decode(payload)?;
                let result = self
                    .service
                    .delete_entry(Path::new(&input.cwd), &input.relative_path)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectDeleteEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.duplicateEntry" => {
                let input: PathInput = decode(payload)?;
                let result = self
                    .service
                    .duplicate_entry(Path::new(&input.cwd), &input.relative_path)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectDuplicateEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.listEntries" => {
                let input: CwdInput = decode(payload)?;
                let index = self.index(&input.cwd).await.map_err(|error| {
                    entries_wire_error("ProjectListEntriesError", &input.cwd, &error)
                })?;
                encode(index.list().await).map_err(|error| {
                    entries_wire_error("ProjectListEntriesError", &input.cwd, &error)
                })
            }
            "projects.searchEntries" => {
                let input: SearchInput = decode(payload)?;
                let index = self.index(&input.cwd).await.map_err(|error| {
                    entries_wire_error("ProjectSearchEntriesError", &input.cwd, &error)
                })?;
                encode(index.search(&input.query, input.limit.min(200)).await).map_err(|error| {
                    entries_wire_error("ProjectSearchEntriesError", &input.cwd, &error)
                })
            }
            "filesystem.browse" => {
                let input: BrowseInput = decode(payload)?;
                self.service
                    .browse(&input.partial_path, input.cwd.as_deref().map(Path::new))
                    .await
                    .and_then(encode)
                    .map_err(|error| filesystem_wire_error(&input, &error))
            }
            "assets.createUrl" => {
                let input: AssetCreateUrlInput = decode(payload)?;
                self.handle_asset_create_url(input).await
            }
            "review.getDiffPreview" => {
                let input: ReviewDiffPreviewInput = decode(payload)?;
                self.handle_review_get_diff_preview(input).await
            }
            _ => Err(json!({
                "_tag": "Defect",
                "message": WorkspaceError::UnsupportedMethod(method.to_owned()).to_string(),
            })),
        }
    }

    pub async fn refresh_index(&self, cwd: &Path) {
        self.indexes.lock().await.remove(cwd);
    }

    async fn index(&self, cwd: &str) -> Result<WorkspaceSearchIndex, WorkspaceError> {
        let canonical = tokio::fs::canonicalize(cwd)
            .await
            .map_err(|error| WorkspaceError::operation("realpath-workspace-root", cwd, error))?;
        if let Some(index) = self.indexes.lock().await.get(&canonical).cloned() {
            return Ok(index);
        }
        let index = WorkspaceSearchIndex::new(canonical.clone(), SearchLimits::default());
        index.refresh(CancellationToken::new()).await?;
        self.indexes.lock().await.insert(canonical, index.clone());
        Ok(index)
    }

    async fn invalidate_index(&self, cwd: &str) {
        let Ok(canonical) = tokio::fs::canonicalize(cwd).await else {
            return;
        };
        self.indexes.lock().await.remove(&canonical);
    }

    async fn handle_asset_create_url(&self, input: AssetCreateUrlInput) -> Result<Value, Value> {
        let asset_access = self
            .dependencies
            .asset_access
            .as_ref()
            .ok_or_else(|| defect("assets.createUrl is not configured"))?;
        let workspace_root = match &input.resource {
            AssetResource::WorkspaceFile { thread_id, .. } => {
                let resolver = self
                    .dependencies
                    .asset_context_resolver
                    .as_ref()
                    .ok_or_else(|| {
                        defect("assets.createUrl requires a workspace context resolver")
                    })?;
                match resolver.resolve_workspace_root(thread_id).await {
                    Ok(Some(root)) => Some(root),
                    Ok(None) => {
                        return Err(asset_wire(
                            &input.resource,
                            "AssetWorkspaceContextNotFoundError",
                        ));
                    }
                    Err(message) => {
                        let mut value =
                            asset_wire(&input.resource, "AssetWorkspaceContextResolutionError");
                        value
                            .as_object_mut()
                            .expect("asset error")
                            .insert("detail".to_owned(), json!(message));
                        return Err(value);
                    }
                }
            }
            _ => None,
        };
        let issued = asset_access
            .issue(AssetIssueRequest {
                resource: input.resource.clone(),
                workspace_root,
            })
            .await
            .map_err(|error| asset_wire_from_error(&input.resource, &error))?;
        encode(issued).map_err(|error| defect(&error.to_string()))
    }

    async fn handle_review_get_diff_preview(
        &self,
        input: ReviewDiffPreviewInput,
    ) -> Result<Value, Value> {
        let review_service = self
            .dependencies
            .review_service
            .as_ref()
            .ok_or_else(|| defect("review.getDiffPreview is not configured"))?;
        let result = review_service
            .get_diff_preview(input)
            .await
            .map_err(review_wire_error)?;
        encode(result).map_err(|error| defect(&error.to_string()))
    }
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|error| {
        json!({
            "_tag": "InvalidRequest",
            "message": error.to_string(),
        })
    })
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, WorkspaceError> {
    serde_json::to_value(value).map_err(|error| WorkspaceError::InvalidRequest(error.to_string()))
}

fn entries_wire_error(tag: &str, cwd: &str, error: &WorkspaceError) -> Value {
    json!({
        "_tag": tag,
        "cwd": cwd,
        "failure": match error {
            WorkspaceError::RootNotFound { .. } => "workspace_root_not_found",
            WorkspaceError::RootNotDirectory { .. } => "workspace_root_not_directory",
            WorkspaceError::Cancelled => "search_index_scan_timed_out",
            _ => "search_index_search_failed",
        },
        "message": error.to_string(),
    })
}

fn filesystem_wire_error(input: &BrowseInput, error: &WorkspaceError) -> Value {
    json!({
        "_tag": "FilesystemBrowseError",
        "partialPath": input.partial_path,
        "cwd": input.cwd,
        "failure": match error {
            WorkspaceError::WindowsPathUnsupported { .. } => "windows_path_unsupported",
            WorkspaceError::CurrentProjectRequired { .. } => "current_project_required",
            _ => "read_directory_failed",
        },
        "message": error.to_string(),
    })
}

fn asset_wire(resource: &AssetResource, tag: &str) -> Value {
    json!({
        "_tag": tag,
        "resource": resource,
        "message": asset_message(tag),
    })
}

fn asset_message(tag: &str) -> &'static str {
    match tag {
        "AssetWorkspaceContextNotFoundError" => "Workspace context was not found.",
        "AssetWorkspaceContextResolutionError" => "Failed to resolve workspace context.",
        "AssetWorkspaceRootNormalizationError" => "Failed to normalize the workspace root.",
        "AssetWorkspacePathValidationError" => {
            "Workspace file path must be relative to the project root."
        }
        "AssetPreviewTypeValidationError" => "Only browser documents and images can be previewed.",
        "AssetWorkspaceAssetInspectionError" => "Failed to inspect the workspace asset.",
        "AssetWorkspaceAssetNotFoundError" => "Workspace asset was not found.",
        "AssetWorkspaceResolutionError" => "Failed to resolve workspace.",
        "AssetAttachmentNotFoundError" => "Attachment was not found.",
        "AssetProjectFaviconResolutionError" => "Failed to resolve project favicon.",
        "AssetProjectFaviconInspectionError" => "Failed to inspect the project favicon.",
        "AssetProjectFaviconNotFoundError" => "Project favicon was not found.",
        "AssetSigningKeyLoadError" => "Failed to load the asset signing key.",
        _ => "Asset access failed.",
    }
}

fn asset_wire_from_error(resource: &AssetResource, error: &AssetError) -> Value {
    match error {
        AssetError::WorkspaceContextRequired => {
            asset_wire(resource, "AssetWorkspaceContextNotFoundError")
        }
        AssetError::UnsupportedPreviewType(_) => {
            asset_wire(resource, "AssetPreviewTypeValidationError")
        }
        AssetError::NotFound(_) => match resource {
            AssetResource::WorkspaceFile { .. } => {
                asset_wire(resource, "AssetWorkspaceAssetNotFoundError")
            }
            AssetResource::Attachment { .. } => {
                asset_wire(resource, "AssetAttachmentNotFoundError")
            }
            AssetResource::ProjectFavicon { .. } => {
                asset_wire(resource, "AssetProjectFaviconNotFoundError")
            }
        },
        AssetError::Workspace(workspace_error) => match resource {
            AssetResource::ProjectFavicon { .. } => match workspace_error {
                WorkspaceError::RootNotFound { .. } | WorkspaceError::RootNotDirectory { .. } => {
                    asset_wire(resource, "AssetWorkspaceRootNormalizationError")
                }
                _ => asset_wire(resource, "AssetProjectFaviconInspectionError"),
            },
            _ => match workspace_error {
                WorkspaceError::RootNotFound { .. } | WorkspaceError::RootNotDirectory { .. } => {
                    asset_wire(resource, "AssetWorkspaceRootNormalizationError")
                }
                WorkspaceError::PathOutsideRoot { .. }
                | WorkspaceError::ResolvedPathOutsideRoot { .. } => {
                    asset_wire(resource, "AssetWorkspacePathValidationError")
                }
                _ => asset_wire(resource, "AssetWorkspaceAssetInspectionError"),
            },
        },
        AssetError::Encoding(_) => asset_wire(resource, "AssetSigningKeyLoadError"),
    }
}

fn review_wire_error(error: ReviewError) -> Value {
    json!({
        "_tag": "Defect",
        "message": error.to_string(),
    })
}

fn defect(message: &str) -> Value {
    json!({
        "_tag": "Defect",
        "message": message,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CwdInput {
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInput {
    cwd: String,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteInput {
    cwd: String,
    relative_path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    cwd: String,
    relative_path: String,
    kind: EntryKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameInput {
    cwd: String,
    from_relative_path: String,
    to_relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchInput {
    cwd: String,
    query: String,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseInput {
    partial_path: String,
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetCreateUrlInput {
    resource: AssetResource,
}
