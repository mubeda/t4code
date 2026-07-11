use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

use crate::project::ProjectFaviconResolver;
use crate::workspace::{WorkspaceError, paths};

pub const ASSET_ROUTE_PREFIX: &str = "/api/assets";

const PREVIEW_ENTRY_EXTENSIONS: &[&str] = &["htm", "html", "pdf"];
const IMAGE_EXTENSIONS: &[&str] = &["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"];
const PREVIEW_SIBLING_EXTENSIONS: &[&str] = &[
    "htm", "html", "pdf", "avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp", "css", "js",
    "mjs", "otf", "ttf", "woff", "woff2",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "kebab-case")]
pub enum AssetResource {
    WorkspaceFile {
        #[serde(rename = "threadId")]
        thread_id: String,
        path: String,
    },
    Attachment {
        #[serde(rename = "attachmentId")]
        attachment_id: String,
    },
    ProjectFavicon {
        cwd: String,
    },
}

#[derive(Debug, Clone)]
pub struct AssetIssueRequest {
    pub resource: AssetResource,
    pub workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedAssetUrl {
    pub relative_url: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAsset {
    File(PathBuf),
    ProjectFaviconFallback,
}

#[derive(Debug, Error)]
pub enum AssetError {
    #[error("a workspace root is required for workspace asset access")]
    WorkspaceContextRequired,
    #[error("workspace asset is not an allowed preview type: {0}")]
    UnsupportedPreviewType(String),
    #[error("asset was not found: {0}")]
    NotFound(String),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error("asset token encoding failed: {0}")]
    Encoding(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct AssetAccess {
    secret: Vec<u8>,
    attachments_dir: PathBuf,
    ttl: Duration,
    favicon_resolver: ProjectFaviconResolver,
}

impl AssetAccess {
    pub fn new(secret: Vec<u8>, attachments_dir: PathBuf) -> Self {
        Self::with_ttl(secret, attachments_dir, Duration::from_secs(60 * 60))
    }

    pub fn with_ttl(secret: Vec<u8>, attachments_dir: PathBuf, ttl: Duration) -> Self {
        Self {
            secret,
            attachments_dir,
            ttl,
            favicon_resolver: ProjectFaviconResolver,
        }
    }

    pub async fn issue(&self, request: AssetIssueRequest) -> Result<IssuedAssetUrl, AssetError> {
        let expires_at = now_millis().saturating_add(duration_millis(self.ttl));
        let (claims, filename) = match request.resource {
            AssetResource::WorkspaceFile { path, .. } => {
                let root = request
                    .workspace_root
                    .ok_or(AssetError::WorkspaceContextRequired)?;
                let root = paths::normalize_root(&root, false).await?;
                let (file, relative) = canonical_workspace_file(&root, &path).await?;
                let metadata = tokio::fs::metadata(&file)
                    .await
                    .map_err(|error| WorkspaceError::operation("stat", &file, error))?;
                if !metadata.is_file() {
                    return Err(AssetError::NotFound(path));
                }
                let extension = extension(&relative);
                let claims = if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
                    Claims::WorkspaceExact {
                        root,
                        relative,
                        expires_at,
                    }
                } else if PREVIEW_ENTRY_EXTENSIONS.contains(&extension.as_str()) {
                    let base = Path::new(&relative)
                        .parent()
                        .map_or_else(|| ".".to_owned(), paths::to_posix);
                    Claims::WorkspaceSiblings {
                        root,
                        base,
                        expires_at,
                    }
                } else {
                    return Err(AssetError::UnsupportedPreviewType(path));
                };
                (claims, file_name(&file))
            }
            AssetResource::Attachment { attachment_id } => {
                let file = self.attachments_dir.join(&attachment_id);
                let metadata = tokio::fs::metadata(&file).await.ok();
                if !metadata.is_some_and(|metadata| metadata.is_file()) {
                    return Err(AssetError::NotFound(attachment_id));
                }
                (
                    Claims::Attachment {
                        path: file.clone(),
                        expires_at,
                    },
                    file_name(&file),
                )
            }
            AssetResource::ProjectFavicon { cwd } => {
                let root = paths::normalize_root(Path::new(&cwd), false).await?;
                let path = self.favicon_resolver.resolve_path(&root).await?;
                let relative = path
                    .as_ref()
                    .and_then(|path| path.strip_prefix(&root).ok())
                    .map(paths::to_posix);
                let filename = path
                    .as_ref()
                    .map_or_else(|| "favicon.svg".to_owned(), |path| file_name(path));
                (
                    Claims::ProjectFavicon {
                        root,
                        relative,
                        expires_at,
                    },
                    filename,
                )
            }
        };
        let token = self.sign(&claims)?;
        Ok(IssuedAssetUrl {
            relative_url: format!("{ASSET_ROUTE_PREFIX}/{token}/{}", percent_encode(&filename)),
            expires_at,
        })
    }

    pub async fn resolve(&self, token: &str, requested_path: &str) -> Option<ResolvedAsset> {
        let claims = self.verify(token)?;
        if claims.expires_at() <= now_millis() {
            return None;
        }
        match claims {
            Claims::WorkspaceExact { root, relative, .. } => {
                if requested_path != Path::new(&relative).file_name()?.to_str()? {
                    return None;
                }
                canonical_workspace_file(&root, &relative)
                    .await
                    .ok()
                    .map(|(path, _)| ResolvedAsset::File(path))
            }
            Claims::WorkspaceSiblings { root, base, .. } => {
                let requested = safe_preview_relative(requested_path)?;
                let joined = if base == "." {
                    requested
                } else {
                    format!("{base}/{requested}")
                };
                canonical_workspace_file(&root, &joined)
                    .await
                    .ok()
                    .map(|(path, _)| ResolvedAsset::File(path))
            }
            Claims::Attachment { path, .. } => {
                let metadata = tokio::fs::metadata(&path).await.ok()?;
                metadata.is_file().then_some(ResolvedAsset::File(path))
            }
            Claims::ProjectFavicon { root, relative, .. } => match relative {
                Some(relative) => canonical_workspace_file(&root, &relative)
                    .await
                    .ok()
                    .map(|(path, _)| ResolvedAsset::File(path)),
                None => Some(ResolvedAsset::ProjectFaviconFallback),
            },
        }
    }

    fn sign(&self, claims: &Claims) -> Result<String, AssetError> {
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .expect("HMAC accepts arbitrary key lengths");
        mac.update(payload.as_bytes());
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(format!("{payload}.{signature}"))
    }

    fn verify(&self, token: &str) -> Option<Claims> {
        let (payload, signature) = token.split_once('.')?;
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature)
            .ok()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).ok()?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature).ok()?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Claims {
    WorkspaceSiblings {
        root: PathBuf,
        base: String,
        expires_at: u64,
    },
    WorkspaceExact {
        root: PathBuf,
        relative: String,
        expires_at: u64,
    },
    Attachment {
        path: PathBuf,
        expires_at: u64,
    },
    ProjectFavicon {
        root: PathBuf,
        relative: Option<String>,
        expires_at: u64,
    },
}

impl Claims {
    fn expires_at(&self) -> u64 {
        match self {
            Self::WorkspaceSiblings { expires_at, .. }
            | Self::WorkspaceExact { expires_at, .. }
            | Self::Attachment { expires_at, .. }
            | Self::ProjectFavicon { expires_at, .. } => *expires_at,
        }
    }
}

async fn canonical_workspace_file(
    root: &Path,
    input: &str,
) -> Result<(PathBuf, String), AssetError> {
    let root = paths::normalize_root(root, false).await?;
    let target = Path::new(input);
    let (target, relative) = if target.is_absolute() {
        let (_, canonical) = paths::canonical_existing_within(&root, target).await?;
        let relative =
            canonical
                .strip_prefix(&root)
                .map_err(|_| WorkspaceError::ResolvedPathOutsideRoot {
                    root: root.clone(),
                    resolved_path: canonical.clone(),
                })?;
        let relative = paths::to_posix(relative);
        (canonical, relative)
    } else {
        let (target, relative) = paths::resolve_relative(&root, input)?;
        let (_, canonical) = paths::canonical_existing_within(&root, &target).await?;
        (canonical, relative)
    };
    Ok((target, relative))
}

fn safe_preview_relative(requested: &str) -> Option<String> {
    let path = Path::new(requested);
    if requested.is_empty() || requested.contains('\0') || path.is_absolute() {
        return None;
    }
    let mut segments = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(segment) = component else {
            return None;
        };
        let segment = segment.to_str()?;
        if segment.starts_with('.') {
            return None;
        }
        segments.push(segment);
    }
    let normalized = segments.join("/");
    PREVIEW_SIBLING_EXTENSIONS
        .contains(&extension(&normalized).as_str())
        .then_some(normalized)
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("asset")
        .to_owned()
}

fn percent_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}
