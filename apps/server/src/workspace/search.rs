use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::WorkspaceError;
use super::paths::to_posix;

const ENTRY_OVERHEAD_BYTES: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchLimits {
    pub max_entries: usize,
    pub max_memory_bytes: usize,
    pub max_path_bytes: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            max_entries: 25_000,
            max_memory_bytes: 16 * 1024 * 1024,
            max_path_bytes: 4096,
        }
    }
}

#[derive(Default)]
struct SearchSnapshot {
    entries: Vec<WorkspaceEntry>,
    memory_bytes: usize,
    truncated: bool,
}

#[derive(Clone)]
pub struct WorkspaceSearchIndex {
    root: PathBuf,
    limits: SearchLimits,
    snapshot: Arc<RwLock<SearchSnapshot>>,
}

impl WorkspaceSearchIndex {
    pub fn new(root: PathBuf, limits: SearchLimits) -> Self {
        Self {
            root,
            limits,
            snapshot: Arc::new(RwLock::new(SearchSnapshot::default())),
        }
    }

    pub async fn refresh(&self, cancellation: CancellationToken) -> Result<(), WorkspaceError> {
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        let root = self.root.clone();
        let limits = self.limits;
        let scan_cancel = cancellation.clone();
        let scanned = tokio::task::spawn_blocking(move || scan(&root, limits, &scan_cancel))
            .await
            .map_err(|error| {
                WorkspaceError::operation("scan", &self.root, std::io::Error::other(error))
            })??;
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        *self.snapshot.write().await = scanned;
        Ok(())
    }

    pub async fn list(&self) -> SearchResult {
        let snapshot = self.snapshot.read().await;
        SearchResult {
            entries: snapshot.entries.clone(),
            truncated: snapshot.truncated,
        }
    }

    pub async fn search(&self, query: &str, limit: usize) -> SearchResult {
        let normalized = query
            .trim()
            .trim_start_matches(['@', '.', '/'])
            .to_lowercase();
        let snapshot = self.snapshot.read().await;
        let mut matches = snapshot
            .entries
            .iter()
            .filter_map(|entry| fuzzy_score(&entry.path, &normalized).map(|score| (score, entry)))
            .collect::<Vec<_>>();
        matches.sort_by(|(left_score, left), (right_score, right)| {
            left_score
                .cmp(right_score)
                .then_with(|| entry_kind_rank(left.kind).cmp(&entry_kind_rank(right.kind)))
                .then_with(|| left.path.cmp(&right.path))
        });
        let effective_limit = limit.max(1);
        SearchResult {
            truncated: snapshot.truncated || matches.len() > effective_limit,
            entries: matches
                .into_iter()
                .take(effective_limit)
                .map(|(_, entry)| entry.clone())
                .collect(),
        }
    }

    pub async fn memory_bytes(&self) -> usize {
        self.snapshot.read().await.memory_bytes
    }
}

fn entry_kind_rank(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::File => 0,
        EntryKind::Directory => 1,
    }
}

fn scan(
    root: &Path,
    limits: SearchLimits,
    cancellation: &CancellationToken,
) -> Result<SearchSnapshot, WorkspaceError> {
    if !root.is_dir() {
        return Err(WorkspaceError::RootNotDirectory {
            path: root.to_path_buf(),
        });
    }
    let ignore_rules = read_ignore_rules(root);
    let mut entries: BTreeMap<String, WorkspaceEntry> = BTreeMap::new();
    let mut memory_bytes: usize = 0;
    let mut truncated = false;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        let mut children = std::fs::read_dir(&directory)
            .map_err(|error| WorkspaceError::operation("read-directory", &directory, error))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children.into_iter().rev() {
            if cancellation.is_cancelled() {
                return Err(WorkspaceError::Cancelled);
            }
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|error| WorkspaceError::InvalidRequest(error.to_string()))?;
            let relative = to_posix(relative);
            let file_type = child
                .file_type()
                .map_err(|error| WorkspaceError::operation("stat", &path, error))?;
            if should_ignore(&relative, file_type.is_dir(), &ignore_rules) || file_type.is_symlink()
            {
                continue;
            }
            let kind = if file_type.is_dir() {
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let entry_bytes = relative.len().saturating_add(ENTRY_OVERHEAD_BYTES);
            if relative.len() > limits.max_path_bytes
                || memory_bytes.saturating_add(entry_bytes) > limits.max_memory_bytes
            {
                truncated = true;
                continue;
            }
            if entries.len() >= limits.max_entries {
                truncated = true;
                if kind != EntryKind::File {
                    continue;
                }
                let Some(directory_path) = entries.iter().find_map(|(path, entry)| {
                    (entry.kind == EntryKind::Directory).then_some(path.clone())
                }) else {
                    continue;
                };
                if let Some(removed) = entries.remove(&directory_path) {
                    memory_bytes = memory_bytes
                        .saturating_sub(removed.path.len().saturating_add(ENTRY_OVERHEAD_BYTES));
                }
            }
            memory_bytes += entry_bytes;
            entries.insert(
                relative.clone(),
                WorkspaceEntry {
                    path: relative,
                    kind,
                },
            );
            if file_type.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(SearchSnapshot {
        entries: entries.into_values().collect(),
        memory_bytes,
        truncated,
    })
}

fn read_ignore_rules(root: &Path) -> HashSet<String> {
    std::fs::read_to_string(root.join(".gitignore"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('!'))
        .map(|line| {
            line.trim_start_matches('/')
                .trim_end_matches('/')
                .to_owned()
        })
        .collect()
}

fn should_ignore(relative: &str, is_directory: bool, rules: &HashSet<String>) -> bool {
    let first = relative.split('/').next().unwrap_or(relative);
    if matches!(first, ".git" | "node_modules" | ".convex") {
        return true;
    }
    rules.iter().any(|rule| {
        let directory_rule = relative == rule || relative.starts_with(&format!("{rule}/"));
        let basename_rule =
            !rule.contains('/') && relative.rsplit('/').next().is_some_and(|name| name == rule);
        directory_rule || basename_rule || (is_directory && relative == rule)
    })
}

fn fuzzy_score(path: &str, query: &str) -> Option<(u8, usize)> {
    if query.is_empty() {
        return Some((3, 0));
    }
    let lower = path.to_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    if basename == query {
        return Some((0, 0));
    }
    if let Some(index) = basename.find(query) {
        return Some((1, index));
    }
    if let Some(index) = lower.find(query) {
        return Some((2, index));
    }
    if let Some(offset) = subsequence_offset(basename, query) {
        return Some((3, offset));
    }
    subsequence_offset(&lower, query).map(|offset| (4, offset))
}

fn subsequence_offset(candidate: &str, query: &str) -> Option<usize> {
    let mut offset = 0;
    for character in query.chars() {
        let found = candidate[offset..].find(character)?;
        offset += found + character.len_utf8();
    }
    Some(offset)
}
