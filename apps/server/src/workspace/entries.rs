use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::WorkspaceError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub full_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub parent_path: String,
    pub entries: Vec<BrowseEntry>,
}

pub async fn browse(
    partial_path: &str,
    cwd: Option<&Path>,
) -> Result<BrowseResult, WorkspaceError> {
    let trimmed = partial_path.trim();
    #[cfg(not(windows))]
    if looks_like_windows_absolute(trimmed) {
        return Err(WorkspaceError::WindowsPathUnsupported {
            partial_path: partial_path.to_owned(),
        });
    }
    let explicit_relative = trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with("./")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("../")
        || trimmed.starts_with("..\\");
    let resolved = if explicit_relative {
        cwd.ok_or_else(|| WorkspaceError::CurrentProjectRequired {
            partial_path: partial_path.to_owned(),
        })?
        .join(trimmed)
    } else {
        expand_home(trimmed)
    };
    let ends_with_separator = trimmed.ends_with(['/', '\\']) || trimmed == "~";
    let (parent, prefix) = if ends_with_separator {
        (resolved, String::new())
    } else {
        (
            resolved.parent().unwrap_or(Path::new(".")).to_path_buf(),
            resolved
                .file_name()
                .map_or_else(String::new, |value| value.to_string_lossy().into_owned()),
        )
    };
    let mut directory = match tokio::fs::read_dir(&parent).await {
        Ok(directory) => directory,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
            ) =>
        {
            return Ok(BrowseResult {
                parent_path: parent.to_string_lossy().into_owned(),
                entries: Vec::new(),
            });
        }
        Err(error) => return Err(WorkspaceError::operation("read-directory", &parent, error)),
    };
    let show_hidden = ends_with_separator || prefix.starts_with('.');
    let prefix = prefix.to_lowercase();
    let mut entries = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| WorkspaceError::operation("read-directory", &parent, error))?
    {
        let file_type = entry
            .file_type()
            .await
            .map_err(|error| WorkspaceError::operation("stat", entry.path(), error))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir()
            && name.to_lowercase().starts_with(&prefix)
            && (show_hidden || !name.starts_with('.'))
        {
            entries.push(BrowseEntry {
                name,
                full_path: entry.path().to_string_lossy().into_owned(),
            });
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(BrowseResult {
        parent_path: parent.to_string_lossy().into_owned(),
        entries,
    })
}

fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(input)
}

#[cfg(not(windows))]
fn looks_like_windows_absolute(input: &str) -> bool {
    let bytes = input.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[tokio::test]
    async fn browse_covers_relative_hidden_sorted_and_missing_directories() {
        let root = tempfile::tempdir().unwrap();
        for directory in ["Beta", "alpha", ".hidden"] {
            std::fs::create_dir(root.path().join(directory)).unwrap();
        }
        std::fs::write(root.path().join("alpha.txt"), "file").unwrap();

        let visible = browse("./", Some(root.path())).await.unwrap();
        assert_eq!(
            visible
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden", "Beta", "alpha"]
        );
        let prefixed = browse("./a", Some(root.path())).await.unwrap();
        assert_eq!(prefixed.entries.len(), 1);
        assert_eq!(prefixed.entries[0].name, "alpha");
        let hidden = browse("./.h", Some(root.path())).await.unwrap();
        assert_eq!(hidden.entries[0].name, ".hidden");
        assert!(
            browse("./missing/", Some(root.path()))
                .await
                .unwrap()
                .entries
                .is_empty()
        );
        assert!(matches!(
            browse("./relative", None).await,
            Err(WorkspaceError::CurrentProjectRequired { .. })
        ));

        assert_eq!(expand_home("literal/path"), PathBuf::from("literal/path"));
        assert!(!looks_like_windows_absolute("relative/path"));
        assert!(looks_like_windows_absolute("C:\\Users"));
        assert!(matches!(
            browse("C:\\Users", Some(root.path())).await,
            Err(WorkspaceError::WindowsPathUnsupported { .. })
        ));
    }
}
