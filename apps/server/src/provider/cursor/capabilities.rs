use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio::fs;

#[derive(Debug, Default)]
pub struct CursorWorkspaceCapabilities {
    pub slash_commands: Vec<Value>,
    pub skills: Vec<Value>,
    pub agents: Vec<Value>,
}

pub async fn discover_workspace_capabilities(workspace: &Path) -> CursorWorkspaceCapabilities {
    discover_workspace_capabilities_with_home(workspace, dirs::home_dir().as_deref()).await
}

pub async fn discover_workspace_capabilities_with_environment(
    workspace: &Path,
    environment: &[(OsString, OsString)],
) -> CursorWorkspaceCapabilities {
    let home = configured_home(environment).or_else(dirs::home_dir);
    discover_workspace_capabilities_with_home(workspace, home.as_deref()).await
}

async fn discover_workspace_capabilities_with_home(
    workspace: &Path,
    home: Option<&Path>,
) -> CursorWorkspaceCapabilities {
    let mut capabilities = CursorWorkspaceCapabilities::default();

    let command_roots = scoped_roots(workspace, home, ".cursor/commands");
    let mut command_names = HashSet::new();
    for (root, _scope) in command_roots {
        for (name, _path) in markdown_files(&root).await {
            if command_names.insert(name.to_ascii_lowercase()) {
                capabilities.slash_commands.push(json!({ "name": name }));
            }
        }
    }

    let mut skill_names = HashSet::new();
    for (root, scope) in skill_roots(workspace, home) {
        for (name, path) in skill_files(&root).await {
            if skill_names.insert(name.to_ascii_lowercase()) {
                capabilities.skills.push(json!({
                    "name": name,
                    "path": path,
                    "scope": scope,
                    "enabled": true,
                    "invocation": "slash",
                }));
            }
        }
    }

    let mut agent_names = HashSet::new();
    for (root, _scope) in agent_roots(workspace, home) {
        for (name, _path) in markdown_files(&root).await {
            if agent_names.insert(name.to_ascii_lowercase()) {
                capabilities.agents.push(json!({ "name": name }));
            }
        }
    }

    capabilities
}

fn configured_home(environment: &[(OsString, OsString)]) -> Option<PathBuf> {
    let variable_names: &[&str] = if cfg!(windows) {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME"]
    };
    variable_names.iter().find_map(|expected_name| {
        environment
            .iter()
            .rev()
            .find(|(name, value)| {
                environment_name_matches(name, expected_name) && !value.is_empty()
            })
            .map(|(_, value)| PathBuf::from(value))
    })
}

fn environment_name_matches(name: &OsStr, expected: &str) -> bool {
    if cfg!(windows) {
        name.to_string_lossy().eq_ignore_ascii_case(expected)
    } else {
        name == OsStr::new(expected)
    }
}

fn scoped_roots(
    workspace: &Path,
    home: Option<&Path>,
    relative: &str,
) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(workspace.join(relative), "project")];
    if let Some(home) = home {
        roots.push((home.join(relative), "user"));
    }
    roots
}

fn skill_roots(workspace: &Path, home: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![
        (workspace.join(".cursor/skills"), "project"),
        (workspace.join(".agents/skills"), "project"),
    ];
    if let Some(home) = home {
        roots.extend([
            (home.join(".cursor/skills"), "user"),
            (home.join(".agents/skills"), "user"),
        ]);
    }
    roots
}

fn agent_roots(workspace: &Path, home: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![
        (workspace.join(".cursor/agents"), "project"),
        (workspace.join(".claude/agents"), "project"),
        (workspace.join(".codex/agents"), "project"),
    ];
    if let Some(home) = home {
        roots.extend([
            (home.join(".cursor/agents"), "user"),
            (home.join(".claude/agents"), "user"),
            (home.join(".codex/agents"), "user"),
        ]);
    }
    roots
}

async fn markdown_files(directory: &Path) -> Vec<(String, String)> {
    let Ok(mut entries) = fs::read_dir(directory).await else {
        return Vec::new();
    };
    let mut files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let is_markdown = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        let is_file = entry
            .file_type()
            .await
            .is_ok_and(|file_type| file_type.is_file());
        if !is_file || !is_markdown {
            continue;
        }
        let Some(name) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        files.push((name.to_owned(), path.to_string_lossy().into_owned()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

async fn skill_files(directory: &Path) -> Vec<(String, String)> {
    let Ok(mut entries) = fs::read_dir(directory).await else {
        return Vec::new();
    };
    let mut files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_directory = entry
            .file_type()
            .await
            .is_ok_and(|file_type| file_type.is_dir());
        if !is_directory {
            continue;
        }
        let path = entry.path().join("SKILL.md");
        if !fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().trim().to_owned();
        if name.is_empty() {
            continue;
        }
        files.push((name, path.to_string_lossy().into_owned()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}
