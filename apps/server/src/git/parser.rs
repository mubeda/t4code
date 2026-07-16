use std::collections::HashMap;

use super::VcsWorkingTreeFileStatus;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PorcelainRecord {
    pub path: String,
    pub index_status: VcsWorkingTreeFileStatus,
    pub worktree_status: VcsWorkingTreeFileStatus,
    pub index_changed: bool,
    pub worktree_changed: bool,
    pub untracked: bool,
}

fn status_char(value: char) -> VcsWorkingTreeFileStatus {
    match value {
        'A' => VcsWorkingTreeFileStatus::Added,
        'D' => VcsWorkingTreeFileStatus::Deleted,
        'R' => VcsWorkingTreeFileStatus::Renamed,
        'C' => VcsWorkingTreeFileStatus::Copied,
        _ => VcsWorkingTreeFileStatus::Modified,
    }
}

fn slice_after_fields(line: &str, count: usize) -> &str {
    let bytes = line.as_bytes();
    let mut index = 0;
    for _ in 0..count {
        while index < bytes.len() && bytes[index] == b' ' {
            index += 1;
        }
        while index < bytes.len() && bytes[index] != b' ' {
            index += 1;
        }
    }
    while index < bytes.len() && bytes[index] == b' ' {
        index += 1;
    }
    &line[index..]
}

#[must_use]
pub fn parse_porcelain_v2_line(line: &str) -> Option<PorcelainRecord> {
    if let Some(path) = line.strip_prefix("? ") {
        let path = path.trim();
        return (!path.is_empty()).then(|| PorcelainRecord {
            path: path.to_owned(),
            index_status: VcsWorkingTreeFileStatus::Untracked,
            worktree_status: VcsWorkingTreeFileStatus::Untracked,
            index_changed: false,
            worktree_changed: false,
            untracked: true,
        });
    }
    if line.starts_with("! ") || line.starts_with("# ") {
        return None;
    }
    let kind = line.chars().next()?;
    if !matches!(kind, '1' | '2' | 'u') {
        return None;
    }
    let head = line.split_once('\t').map_or(line, |(head, _)| head);
    let fields: Vec<&str> = head.split_whitespace().collect();
    let xy = fields.get(1).copied().unwrap_or("..");
    let mut chars = xy.chars();
    let index_char = chars.next().unwrap_or('.');
    let worktree_char = chars.next().unwrap_or('.');
    let path_start = match kind {
        '2' => 9,
        'u' => 10,
        _ => 8,
    };
    let path = slice_after_fields(head, path_start);
    if path.is_empty() {
        return None;
    }
    Some(PorcelainRecord {
        path: path.to_owned(),
        index_status: status_char(index_char),
        worktree_status: status_char(worktree_char),
        index_changed: kind == 'u' || index_char != '.',
        worktree_changed: kind == 'u' || worktree_char != '.',
        untracked: false,
    })
}

#[must_use]
pub fn resolve_numstat_new_path(raw_path: &str) -> String {
    if let (Some(open), Some(close)) = (raw_path.find('{'), raw_path.find('}'))
        && open < close
    {
        let inner = &raw_path[open + 1..close];
        if let Some((_, new)) = inner.split_once(" => ") {
            return format!("{}{}{}", &raw_path[..open], new, &raw_path[close + 1..]);
        }
    }
    raw_path
        .split_once(" => ")
        .map_or_else(|| raw_path.to_owned(), |(_, new)| new.trim().to_owned())
}

#[must_use]
pub fn parse_numstat(stdout: &str) -> HashMap<String, (u64, u64)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let insertions = fields.next()?.parse().unwrap_or(0);
            let deletions = fields.next()?.parse().unwrap_or(0);
            let remaining: Vec<&str> = fields.collect();
            let raw_path = remaining.last()?.trim();
            (!raw_path.is_empty())
                .then(|| (resolve_numstat_new_path(raw_path), (insertions, deletions)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_compact_numstat_renames() {
        assert_eq!(
            resolve_numstat_new_path("src/{old.rs => new.rs}"),
            "src/new.rs"
        );
        assert_eq!(resolve_numstat_new_path("old => new"), "new");
    }
}
