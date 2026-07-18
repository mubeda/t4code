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

/// Post-profile bootstrap that disables PowerShell predictive history (ghost text)
/// without disabling Up/Down history navigation or Tab completion. It is passed via
/// `-EncodedCommand` (not typed as terminal input). Setup runs in a child scope and a one-shot
/// prompt closure removes only the
/// startup invocation after PowerShell registers it, then restores the profile's original prompt.
/// Cleanup is installed in `finally`, so a terminating option error is still reported while the
/// next interactive prompt remains clean. The `Get-Command` probe makes this a no-op on
/// PSReadLine versions that predate the `PredictionSource` parameter.
pub const POWERSHELL_PREDICTION_BOOTSTRAP: &str = "& { $originalPrompt = $function:prompt; $cleanupPrompt = { $startupEntry = Get-History | Select-Object -Last 1; Set-Item function:global:prompt -Value $originalPrompt; if ($startupEntry) { Clear-History -Id $startupEntry.Id }; & $originalPrompt }.GetNewClosure(); try { $c = Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue; if ($c -and $c.Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource None -ErrorAction Stop } } finally { Set-Item function:global:prompt -Value $cleanupPrompt } }";

/// Encodes a PowerShell script for `-EncodedCommand`: base64 of the script's UTF-16LE bytes.
/// Using `-EncodedCommand` instead of `-Command` sidesteps ALL shell-quoting hazards for a
/// script containing single quotes, `$`, `;`, `{}`, and `()` when the script is passed as a
/// single argv token through portable-pty's Windows command-line builder into PowerShell's
/// parser. The user profile still loads before the encoded command runs (no `-NoProfile`),
/// preserving the "a profile cannot re-enable prediction before the managed setting applies"
/// ordering the design requires.
fn encode_powershell_command(script: &str) -> String {
    use base64::Engine as _;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
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
        return Some(ShellCandidate::new(
            command,
            [
                "-NoLogo".to_owned(),
                "-NoExit".to_owned(),
                "-EncodedCommand".to_owned(),
                encode_powershell_command(POWERSHELL_PREDICTION_BOOTSTRAP),
            ],
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_powershell_encoded_command(encoded: &str) -> String {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).expect("valid UTF-16LE")
    }

    #[test]
    fn windows_powershell_receives_the_prediction_bootstrap() {
        let candidate =
            shell_candidate_from_command("pwsh.exe", Platform::Windows).expect("pwsh candidate");
        assert_eq!(candidate.args.len(), 4);
        assert_eq!(candidate.args[0], "-NoLogo");
        assert_eq!(candidate.args[1], "-NoExit");
        assert_eq!(candidate.args[2], "-EncodedCommand");
        // -EncodedCommand carries base64(UTF-16LE(script)); it must round-trip to the bootstrap.
        let decoded = decode_powershell_encoded_command(&candidate.args[3]);
        assert_eq!(decoded, POWERSHELL_PREDICTION_BOOTSTRAP);
        // The bootstrap probes for the parameter before calling, so an old PSReadLine
        // with no PredictionSource is a no-op rather than an error.
        assert!(decoded.contains("PredictionSource"));
        assert!(decoded.contains("SilentlyContinue"));
        assert!(decoded.contains("finally"));
        assert!(decoded.contains("Clear-History -Id $startupEntry.Id"));
        assert!(!decoded.contains("Remove-History"));
        assert!(decoded.contains("GetNewClosure"));
        assert!(!decoded.contains("$global:"));

        let ps = shell_candidate_from_command("powershell.exe", Platform::Windows)
            .expect("powershell candidate");
        assert_eq!(ps.args.first().map(String::as_str), Some("-NoLogo"));
        assert!(ps.args.iter().any(|arg| arg == "-EncodedCommand"));
    }

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

    #[test]
    fn resolves_windows_candidates_with_powershell_flags_fallbacks_and_deduplication() {
        let env = BTreeMap::from([
            ("SystemRoot".to_owned(), "D:\\Windows\\".to_owned()),
            (
                "ComSpec".to_owned(),
                "D:\\Windows\\System32\\cmd.exe".to_owned(),
            ),
        ]);
        let candidates = resolve_shell_candidates(
            Platform::Windows,
            Some(" C:/Program Files/PowerShell/pwsh.exe "),
            &env,
        );

        let expected_args = vec![
            "-NoLogo".to_owned(),
            "-NoExit".to_owned(),
            "-EncodedCommand".to_owned(),
            encode_powershell_command(POWERSHELL_PREDICTION_BOOTSTRAP),
        ];
        assert_eq!(
            candidates.first(),
            Some(&ShellCandidate {
                command: "C:/Program Files/PowerShell/pwsh.exe".to_owned(),
                args: expected_args.clone(),
            })
        );
        assert!(candidates.iter().any(|candidate| {
            candidate.command == "pwsh.exe" && candidate.args == expected_args
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.command == "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                && candidate.args == expected_args
        }));
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate.command == "D:\\Windows\\System32\\cmd.exe")
                .count(),
            1
        );
        assert_eq!(
            format_candidate(candidates.first().expect("preferred candidate")),
            format!(
                "C:/Program Files/PowerShell/pwsh.exe {}",
                expected_args.join(" ")
            )
        );
    }

    #[test]
    fn shell_parsing_rejects_empty_values_and_normalizes_platform_basenames() {
        assert_eq!(parse_shell(Some("  "), Platform::Unix), None);
        assert_eq!(
            parse_shell(Some("'zsh' --login"), Platform::Unix),
            Some("zsh".to_owned())
        );
        assert_eq!(
            parse_shell(Some(" powershell.exe "), Platform::Windows),
            Some("powershell.exe".to_owned())
        );
        assert_eq!(shell_candidate_from_command(" ", Platform::Unix), None);
        assert_eq!(
            basename_for_platform("C:/Windows/System32/cmd.exe", Platform::Windows),
            "cmd.exe"
        );
        assert_eq!(
            basename_for_platform("C:\\Windows\\System32\\cmd.exe", Platform::Unix),
            "cmd.exe"
        );
        assert_eq!(
            format_candidate(&ShellCandidate::new("sh", std::iter::empty::<&str>())),
            "sh"
        );
        #[cfg(windows)]
        assert_eq!(Platform::current(), Platform::Windows);
        #[cfg(not(windows))]
        assert_eq!(Platform::current(), Platform::Unix);
    }
}
