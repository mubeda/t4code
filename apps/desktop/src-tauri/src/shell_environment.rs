#![cfg(test)]

use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::ffi::OsStringExt as _;

const PATH_CAPTURE_START: &[u8] = b"__T4CODE_PATH_START__";
const PATH_CAPTURE_END: &[u8] = b"__T4CODE_PATH_END__";
const SUPPORTED_SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathHydrationFailure {
    ShellUnavailable,
    SpawnFailed,
    WaitFailed,
    TimedOut,
    NonZeroExit,
    OutputReadFailed,
    OutputTooLarge,
    MalformedOutput,
    EmptyPath,
    InvalidPath,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopPlatform {
    MacOs,
    Linux,
    Windows,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlatformAction {
    Hydrate(PosixPlatform),
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PosixPlatform {
    MacOs,
    Linux,
}

#[derive(Debug, Eq, PartialEq)]
struct PreparedPath {
    value: OsString,
    added_segments: usize,
}

fn platform_action(platform: DesktopPlatform) -> PlatformAction {
    match platform {
        DesktopPlatform::MacOs => PlatformAction::Hydrate(PosixPlatform::MacOs),
        DesktopPlatform::Linux => PlatformAction::Hydrate(PosixPlatform::Linux),
        DesktopPlatform::Windows | DesktopPlatform::Other => PlatformAction::Skip,
    }
}

fn select_shell(
    configured: Option<&OsStr>,
    platform: PosixPlatform,
    is_available: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let configured = configured.map(Path::new).filter(|path| {
        path.is_absolute()
            && path
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| SUPPORTED_SHELLS.contains(&name))
            && is_available(path)
    });
    if let Some(configured) = configured {
        return Some(configured.to_path_buf());
    }

    let fallback = match platform {
        PosixPlatform::MacOs => Path::new("/bin/zsh"),
        PosixPlatform::Linux => Path::new("/bin/bash"),
    };
    is_available(fallback).then(|| fallback.to_path_buf())
}

#[cfg(unix)]
fn parse_captured_path(
    output: &[u8],
    exceeded_limit: bool,
) -> Result<OsString, PathHydrationFailure> {
    if exceeded_limit {
        return Err(PathHydrationFailure::OutputTooLarge);
    }

    let start = find_subslice(output, PATH_CAPTURE_START)
        .map(|index| index + PATH_CAPTURE_START.len())
        .ok_or(PathHydrationFailure::MalformedOutput)?;
    let end = find_subslice(&output[start..], PATH_CAPTURE_END)
        .map(|index| start + index)
        .ok_or(PathHydrationFailure::MalformedOutput)?;
    let captured = trim_ascii_whitespace(&output[start..end]);
    if captured.is_empty() {
        return Err(PathHydrationFailure::EmptyPath);
    }

    Ok(OsString::from_vec(captured.to_vec()))
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |index| index + 1);
    &bytes[start..end]
}

fn merge_path_values(
    shell_path: &OsStr,
    inherited_path: Option<&OsStr>,
) -> Result<PreparedPath, PathHydrationFailure> {
    let inherited = inherited_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let inherited_set = inherited.iter().cloned().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut added_segments = 0;

    for path in std::env::split_paths(shell_path).filter(|path| !path.as_os_str().is_empty()) {
        if seen.insert(path.clone()) {
            added_segments += usize::from(!inherited_set.contains(&path));
            merged.push(path);
        }
    }
    for path in inherited {
        if seen.insert(path.clone()) {
            merged.push(path);
        }
    }

    if merged.is_empty() {
        return Err(PathHydrationFailure::EmptyPath);
    }
    let value = std::env::join_paths(merged).map_err(|_| PathHydrationFailure::InvalidPath)?;
    Ok(PreparedPath {
        value,
        added_segments,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        path::{Path, PathBuf},
    };

    use super::{
        DesktopPlatform, PathHydrationFailure, PlatformAction, PosixPlatform, merge_path_values,
        parse_captured_path, platform_action, select_shell,
    };

    #[test]
    fn parses_path_between_delimiters_and_ignores_shell_output() {
        let output = b"welcome\n__T4CODE_PATH_START__/opt/homebrew/bin:/usr/bin\
__T4CODE_PATH_END__\nlogout";
        assert_eq!(
            parse_captured_path(output, false).unwrap(),
            OsString::from("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn rejects_missing_reversed_empty_and_oversized_captures() {
        assert_eq!(
            parse_captured_path(b"/usr/bin", false),
            Err(PathHydrationFailure::MalformedOutput)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_END__/usr/bin__T4CODE_PATH_START__", false),
            Err(PathHydrationFailure::MalformedOutput)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_START__  __T4CODE_PATH_END__", false),
            Err(PathHydrationFailure::EmptyPath)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_START__/usr/bin__T4CODE_PATH_END__", true),
            Err(PathHydrationFailure::OutputTooLarge)
        );
    }

    #[test]
    fn merges_shell_path_first_preserving_spaces_and_unique_inherited_entries() {
        let shell = std::env::join_paths([
            Path::new("/Users/test/My Tools"),
            Path::new("/opt/homebrew/bin"),
            Path::new("/usr/bin"),
            Path::new("/opt/homebrew/bin"),
        ])
        .unwrap();
        let inherited = std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap();

        let prepared = merge_path_values(&shell, Some(&inherited)).unwrap();
        assert_eq!(
            std::env::split_paths(&prepared.value).collect::<Vec<_>>(),
            [
                PathBuf::from("/Users/test/My Tools"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
        assert_eq!(prepared.added_segments, 2);
    }

    #[test]
    fn selects_trusted_configured_shell_then_platform_default() {
        let exists = |path: &Path| {
            matches!(
                path.to_str(),
                Some("/opt/homebrew/bin/fish" | "/bin/zsh" | "/bin/bash")
            )
        };
        assert_eq!(
            select_shell(
                Some(OsStr::new("/opt/homebrew/bin/fish")),
                PosixPlatform::MacOs,
                exists
            ),
            Some(PathBuf::from("/opt/homebrew/bin/fish"))
        );
        assert_eq!(
            select_shell(
                Some(OsStr::new("relative/zsh")),
                PosixPlatform::MacOs,
                exists
            ),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(
            select_shell(
                Some(OsStr::new("/bin/nushell")),
                PosixPlatform::Linux,
                exists
            ),
            Some(PathBuf::from("/bin/bash"))
        );
    }

    #[test]
    fn windows_platform_skips_hydration() {
        assert_eq!(
            platform_action(DesktopPlatform::Windows),
            PlatformAction::Skip
        );
    }

    #[test]
    fn platform_actions_cover_supported_posix_and_unsupported_hosts() {
        assert_eq!(
            platform_action(DesktopPlatform::MacOs),
            PlatformAction::Hydrate(PosixPlatform::MacOs)
        );
        assert_eq!(
            platform_action(DesktopPlatform::Linux),
            PlatformAction::Hydrate(PosixPlatform::Linux)
        );
        assert_eq!(
            platform_action(DesktopPlatform::Other),
            PlatformAction::Skip
        );
    }

    #[test]
    fn hydration_failure_categories_remain_distinct() {
        let failures = [
            PathHydrationFailure::ShellUnavailable,
            PathHydrationFailure::SpawnFailed,
            PathHydrationFailure::WaitFailed,
            PathHydrationFailure::TimedOut,
            PathHydrationFailure::NonZeroExit,
            PathHydrationFailure::OutputReadFailed,
            PathHydrationFailure::OutputTooLarge,
            PathHydrationFailure::MalformedOutput,
            PathHydrationFailure::EmptyPath,
            PathHydrationFailure::InvalidPath,
        ];

        assert_eq!(failures.len(), 10);
        for (index, failure) in failures.iter().enumerate() {
            assert!(
                !failures[..index].contains(failure),
                "failure category was duplicated: {failure:?}"
            );
        }
    }
}
