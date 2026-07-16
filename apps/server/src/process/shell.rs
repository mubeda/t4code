use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Unix,
    Windows,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellCandidate {
    pub command: String,
    pub args: Vec<String>,
}

impl ShellCandidate {
    fn new(command: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

pub fn resolve_shell_candidates(
    platform: Platform,
    preferred: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Vec<ShellCandidate> {
    let requested = parse_shell(preferred, platform)
        .and_then(|command| shell_candidate_from_command(&command, platform));

    let candidates = if platform == Platform::Unix {
        vec![
            requested,
            parse_shell(env.get("SHELL").map(String::as_str), platform)
                .and_then(|command| shell_candidate_from_command(&command, platform)),
            shell_candidate_from_command("/bin/zsh", platform),
            shell_candidate_from_command("/bin/bash", platform),
            shell_candidate_from_command("/bin/sh", platform),
            shell_candidate_from_command("zsh", platform),
            shell_candidate_from_command("bash", platform),
            shell_candidate_from_command("sh", platform),
        ]
    } else {
        vec![
            requested,
            shell_candidate_from_command("pwsh.exe", platform),
            shell_candidate_from_command(&windows_powershell_path(env), platform),
            shell_candidate_from_command("powershell.exe", platform),
            env.get("ComSpec")
                .map(String::as_str)
                .and_then(|command| shell_candidate_from_command(command, platform)),
            shell_candidate_from_command(&windows_cmd_path(env), platform),
            shell_candidate_from_command("cmd.exe", platform),
        ]
    };

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .flatten()
        .filter(|candidate| seen.insert(format_candidate(candidate)))
        .collect()
}

fn parse_shell(value: Option<&str>, platform: Platform) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if platform == Platform::Windows {
        return Some(value.to_string());
    }

    let command = value
        .split_ascii_whitespace()
        .next()?
        .trim_matches(['\'', '"']);
    (!command.is_empty()).then(|| command.to_string())
}

fn shell_candidate_from_command(command: &str, platform: Platform) -> Option<ShellCandidate> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }

    let shell_name = basename_for_platform(command, platform).to_ascii_lowercase();
    if platform == Platform::Windows && (shell_name == "pwsh.exe" || shell_name == "powershell.exe")
    {
        return Some(ShellCandidate::new(command, ["-NoLogo"]));
    }
    if platform == Platform::Unix && shell_name == "zsh" {
        return Some(ShellCandidate::new(command, ["-o", "nopromptsp"]));
    }
    Some(ShellCandidate::new(command, std::iter::empty::<&str>()))
}

fn basename_for_platform(command: &str, platform: Platform) -> String {
    let normalized = if platform == Platform::Windows {
        command.replace('/', "\\")
    } else {
        command.replace('\\', "/")
    };
    normalized
        .split(if platform == Platform::Windows {
            '\\'
        } else {
            '/'
        })
        .rfind(|part| !part.is_empty())
        .unwrap_or(&normalized)
        .to_string()
}

fn format_candidate(candidate: &ShellCandidate) -> String {
    if candidate.args.is_empty() {
        candidate.command.clone()
    } else {
        format!("{} {}", candidate.command, candidate.args.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_constructor_and_platform_paths_cover_runtime_inputs() {
        assert_eq!(
            ShellCandidate::new("shell", ["--login"]),
            ShellCandidate {
                command: "shell".to_owned(),
                args: vec!["--login".to_owned()],
            }
        );
        let env = BTreeMap::from([
            ("SystemRoot".to_owned(), "C:\\Windows".to_owned()),
            ("ComSpec".to_owned(), "C:\\Windows\\cmd.exe".to_owned()),
        ]);
        assert!(windows_powershell_path(&env).contains("powershell.exe"));
        assert_eq!(windows_cmd_path(&env), "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(windows_system_root(&env), "C:\\Windows");
        assert_eq!(
            join_windows_path("C:\\Windows", &["System32"]),
            "C:\\Windows\\System32"
        );
    }
}

fn windows_system_root(env: &BTreeMap<String, String>) -> String {
    env.get("SystemRoot")
        .or_else(|| env.get("windir"))
        .map(String::as_str)
        .unwrap_or("C:\\Windows")
        .trim()
        .to_string()
}

fn windows_powershell_path(env: &BTreeMap<String, String>) -> String {
    join_windows_path(
        &windows_system_root(env),
        &["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    )
}

fn windows_cmd_path(env: &BTreeMap<String, String>) -> String {
    join_windows_path(&windows_system_root(env), &["System32", "cmd.exe"])
}

fn join_windows_path(root: &str, segments: &[&str]) -> String {
    let mut joined = root.trim_end_matches(['\\', '/']).to_string();
    for segment in segments {
        if !joined.is_empty() {
            joined.push('\\');
        }
        joined.push_str(segment.trim_matches(['\\', '/']));
    }
    joined
}
