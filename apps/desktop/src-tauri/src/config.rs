use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const APP_BASE_NAME: &str = "T4Code";

fn config_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

pub fn is_development_build() -> bool {
    cfg!(debug_assertions)
}

pub fn app_version<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

fn is_nightly_version(version: &str) -> bool {
    let Some((_, suffix)) = version.rsplit_once("-nightly.") else {
        return false;
    };
    let mut parts = suffix.split('.');
    let Some(date) = parts.next() else {
        return false;
    };
    let Some(sequence) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && date.len() == 8
        && date.chars().all(|character| character.is_ascii_digit())
        && !sequence.is_empty()
        && sequence.chars().all(|character| character.is_ascii_digit())
}

fn resolve_app_stage_label(is_development: bool, app_version: &str) -> &'static str {
    if is_development {
        "Dev"
    } else if is_nightly_version(app_version) {
        "Nightly"
    } else {
        "Alpha"
    }
}

pub fn app_branding<R: Runtime>(app: &AppHandle<R>) -> Value {
    let stage_label = resolve_app_stage_label(is_development_build(), &app_version(app));
    json!({
        "baseName": APP_BASE_NAME,
        "stageLabel": stage_label,
        "displayName": format!("{APP_BASE_NAME} ({stage_label})"),
    })
}

pub fn runtime_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    }
}

pub fn runtime_info() -> Value {
    let arch = runtime_arch();
    json!({
        "hostArch": arch,
        "appArch": arch,
        "runningUnderArm64Translation": false,
    })
}

fn resolve_default_path_from_home(
    home_directory: &Path,
    raw_options: Option<&Value>,
) -> Option<PathBuf> {
    let initial_path = raw_options?.get("initialPath")?.as_str()?.trim();
    if initial_path.is_empty() {
        return None;
    }
    if initial_path == "~" {
        return Some(home_directory.to_path_buf());
    }
    if let Some(path) = initial_path
        .strip_prefix("~/")
        .or_else(|| initial_path.strip_prefix("~\\"))
    {
        return Some(home_directory.join(path));
    }
    let path = PathBuf::from(initial_path);
    if path.is_absolute() {
        Some(path)
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

pub fn resolve_pick_folder_default_path<R: Runtime>(
    app: &AppHandle<R>,
    raw_options: Option<&Value>,
) -> Option<PathBuf> {
    let home_directory = app.path().home_dir().ok()?;
    resolve_default_path_from_home(&home_directory, raw_options)
}

pub fn state_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base_dir = match std::env::var_os("T4CODE_HOME") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => app
            .path()
            .home_dir()
            .map_err(|error| config_error("Could not resolve the home directory", error))?
            .join(".t4code"),
    };
    Ok(base_dir.join(if cfg!(debug_assertions) {
        "dev"
    } else {
        "userdata"
    }))
}

pub fn read_json_file(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(config_error(
                &format!("Could not read {}", path.display()),
                error,
            ));
        }
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| config_error(&format!("Could not decode {}", path.display()), error))
}

pub fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let directory = path.parent().ok_or_else(|| {
        format!(
            "Could not resolve the parent directory for {}",
            path.display()
        )
    })?;
    fs::create_dir_all(directory).map_err(|error| {
        config_error(&format!("Could not create {}", directory.display()), error)
    })?;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temp_path = path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    let encoded = serde_json::to_string_pretty(value)
        .map_err(|error| config_error("Could not encode JSON document", error))?;

    fs::write(&temp_path, format!("{encoded}\n")).map_err(|error| {
        config_error(&format!("Could not write {}", temp_path.display()), error)
    })?;

    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(first_error) if path.exists() => {
            fs::remove_file(path).map_err(|remove_error| {
                let _ = fs::remove_file(&temp_path);
                config_error(
                    &format!(
                        "Could not replace {} after rename failed with {first_error}",
                        path.display()
                    ),
                    remove_error,
                )
            })?;
            fs::rename(&temp_path, path).map_err(|rename_error| {
                let _ = fs::remove_file(&temp_path);
                config_error(
                    &format!("Could not replace {}", path.display()),
                    rename_error,
                )
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(config_error(
                &format!("Could not move {} into place", temp_path.display()),
                error,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_nightly_versions() {
        assert!(is_nightly_version("0.2.0-nightly.20260708.1"));
        assert!(!is_nightly_version("0.2.0-nightly.20260708"));
        assert!(!is_nightly_version("0.2.0-nightly.2026-07-08.1"));
        assert!(!is_nightly_version("0.2.0"));
    }

    #[test]
    fn resolves_app_stage_labels() {
        assert_eq!(resolve_app_stage_label(true, "0.2.0"), "Dev");
        assert_eq!(
            resolve_app_stage_label(false, "0.2.0-nightly.20260708.1"),
            "Nightly"
        );
        assert_eq!(resolve_app_stage_label(false, "0.2.0"), "Alpha");
    }

    #[test]
    fn reports_runtime_info_shape() {
        let runtime = runtime_info();

        assert!(matches!(
            runtime["hostArch"].as_str(),
            Some("arm64" | "x64" | "other")
        ));
        assert_eq!(runtime["hostArch"], runtime["appArch"]);
        assert_eq!(runtime["runningUnderArm64Translation"], false);
    }

    #[test]
    fn resolves_pick_folder_default_paths() {
        let home = PathBuf::from("C:/Users/example");

        assert_eq!(
            resolve_default_path_from_home(&home, Some(&json!({ "initialPath": "~" }))),
            Some(home.clone())
        );
        assert_eq!(
            resolve_default_path_from_home(&home, Some(&json!({ "initialPath": "~/code" }))),
            Some(PathBuf::from("C:/Users/example/code"))
        );
        assert_eq!(
            resolve_default_path_from_home(&home, Some(&json!({ "initialPath": "   " }))),
            None
        );
    }
}
