use std::path::{Path, PathBuf};

use crate::workspace::{WorkspaceError, paths};

const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
];

const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

#[derive(Clone, Default)]
pub struct ProjectFaviconResolver;

impl ProjectFaviconResolver {
    pub async fn resolve_path(&self, root: &Path) -> Result<Option<PathBuf>, WorkspaceError> {
        let root = paths::normalize_root(root, false).await?;
        for candidate in FAVICON_CANDIDATES {
            if let Some(path) = existing_file(&root, candidate).await? {
                return Ok(Some(path));
            }
        }
        for source in ICON_SOURCE_FILES {
            let (source_path, _) = paths::resolve_relative(&root, source)?;
            let Ok(contents) = tokio::fs::read_to_string(source_path).await else {
                continue;
            };
            let Some(href) = extract_icon_href(&contents) else {
                continue;
            };
            for candidate in icon_candidates(&href) {
                if let Some(path) = existing_file(&root, &candidate).await? {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }
}

async fn existing_file(root: &Path, relative: &str) -> Result<Option<PathBuf>, WorkspaceError> {
    let (candidate, _) = match paths::resolve_relative(root, relative) {
        Ok(candidate) => candidate,
        Err(WorkspaceError::PathOutsideRoot { .. }) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !tokio::fs::try_exists(&candidate)
        .await
        .map_err(|error| WorkspaceError::operation("exists", &candidate, error))?
    {
        return Ok(None);
    }
    let (_, canonical) = paths::canonical_existing_within(root, &candidate).await?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| WorkspaceError::operation("stat", &canonical, error))?;
    Ok(metadata.is_file().then_some(canonical))
}

fn icon_candidates(href: &str) -> Vec<String> {
    let clean = href
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('/');
    if clean.is_empty() {
        return Vec::new();
    }
    vec![format!("public/{clean}"), clean.to_owned()]
}

fn extract_icon_href(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    for tag in lower.match_indices("<link") {
        let original = &source[tag.0..];
        let end = original.find('>')?;
        let element = &original[..end];
        let normalized = element.to_ascii_lowercase();
        if !(normalized.contains("rel=\"icon\"")
            || normalized.contains("rel='icon'")
            || normalized.contains("rel=\"shortcut icon\"")
            || normalized.contains("rel='shortcut icon'"))
        {
            continue;
        }
        if let Some(href) = attribute(element, "href") {
            return Some(href.to_owned());
        }
    }
    None
}

fn attribute<'a>(element: &'a str, name: &str) -> Option<&'a str> {
    let lower = element.to_ascii_lowercase();
    let offset = lower.find(&format!("{name}="))? + name.len() + 1;
    let quoted = element.get(offset..)?.chars().next()?;
    if !matches!(quoted, '\'' | '\"') {
        return None;
    }
    let value = element.get(offset + quoted.len_utf8()..)?;
    let end = value.find(quoted)?;
    value.get(..end)
}
