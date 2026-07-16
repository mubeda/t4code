#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextGenerationError {
    pub operation: String,
    pub detail: String,
}

#[must_use]
pub fn sanitize_commit_subject(raw: &str) -> String {
    let single_line = raw.trim().lines().next().unwrap_or("").trim();
    let without_period = single_line.trim_end_matches('.').trim();
    if without_period.is_empty() {
        return "Update project files".to_owned();
    }
    if without_period.len() <= 72 {
        return without_period.to_owned();
    }
    without_period[..72].trim_end().to_owned()
}

#[must_use]
pub fn sanitize_thread_title(raw: &str) -> String {
    let normalized = raw
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return "New thread".to_owned();
    }
    if normalized.len() <= 50 {
        return normalized;
    }
    format!("{}...", normalized[..47].trim_end())
}

#[must_use]
pub fn normalize_cli_error(
    cli_name: &str,
    operation: &str,
    error: &std::io::Error,
    fallback: &str,
) -> TextGenerationError {
    let lower = error.to_string().to_ascii_lowercase();
    let detail = if lower.contains(&format!("spawn {cli_name}")) || lower.contains("enoent") {
        format!(
            "{} CLI (`{}`) is required but not available on PATH.",
            capitalize(cli_name),
            cli_name
        )
    } else {
        fallback.to_owned()
    };
    TextGenerationError {
        operation: operation.to_owned(),
        detail,
    }
}

fn capitalize(input: &str) -> String {
    let mut chars = input.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}
