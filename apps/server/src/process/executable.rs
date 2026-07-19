use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(crate) fn locate_executable<E>(
    command: &str,
    cwd: Option<&Path>,
    search_path: Option<&OsStr>,
    extensions: &[E],
) -> Option<PathBuf>
where
    E: AsRef<str>,
{
    let command_path = Path::new(command);
    if command_path.is_absolute() {
        return command_path.is_file().then(|| command_path.to_path_buf());
    }
    if command_path.components().count() > 1 {
        let resolved = cwd?.join(command_path);
        return resolved.is_file().then_some(resolved);
    }

    search_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .find_map(|directory| {
            let directory = if directory.is_absolute() {
                directory
            } else {
                cwd?.join(directory)
            };
            extensions.iter().find_map(|extension| {
                let extension = extension.as_ref().trim();
                let candidate = if extension.is_empty() {
                    directory.join(command)
                } else if extension.starts_with('.') {
                    directory.join(format!("{command}{extension}"))
                } else {
                    directory.join(format!("{command}.{extension}"))
                };
                candidate.is_file().then_some(candidate)
            })
        })
}
