use std::{collections::HashSet, path::Path};

use serde_json::{Value, json};

#[derive(Debug, Default)]
pub(crate) struct LoadedKeybindings {
    pub(crate) rules: Vec<Value>,
    pub(crate) issues: Vec<Value>,
}

pub(crate) async fn load(path: &Path) -> LoadedKeybindings {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LoadedKeybindings::default();
        }
        Err(error) => return malformed(error.to_string()),
    };
    let entries = match serde_json::from_slice::<Vec<Value>>(&bytes) {
        Ok(entries) => entries,
        Err(error) => return malformed(error.to_string()),
    };

    let mut loaded = LoadedKeybindings::default();
    for (index, rule) in entries.into_iter().enumerate() {
        match validate(&rule, false) {
            Ok(()) => loaded.rules.push(rule),
            Err(message) => loaded.issues.push(json!({
                "kind": "keybindings.invalid-entry",
                "message": message,
                "index": index,
            })),
        }
    }
    loaded
}

fn malformed(message: String) -> LoadedKeybindings {
    LoadedKeybindings {
        rules: Vec::new(),
        issues: vec![json!({
            "kind": "keybindings.malformed-config",
            "message": message,
        })],
    }
}

pub(crate) fn validate(input: &Value, allow_replace: bool) -> Result<(), String> {
    let object = input
        .as_object()
        .ok_or_else(|| "keybinding must be an object".to_owned())?;
    let key = object
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if key.is_empty() || key.len() > 64 || parse_shortcut(key).is_none() {
        return Err("invalid keybinding shortcut".into());
    }
    if command.is_empty() || command.len() > 64 {
        return Err("invalid keybinding command".into());
    }
    if object
        .get("when")
        .and_then(Value::as_str)
        .is_some_and(|when| when.is_empty() || when.len() > 256 || parse_when(when).is_none())
    {
        return Err("invalid keybinding condition".into());
    }
    if allow_replace && let Some(replace) = object.get("replace") {
        validate(replace, false)?;
    }
    Ok(())
}

pub(crate) fn same_rule(left: &Value, right: &Value) -> bool {
    left.get("key") == right.get("key")
        && left.get("command") == right.get("command")
        && left.get("when") == right.get("when")
}

pub(crate) fn resolve(rules: &[Value]) -> Vec<Value> {
    rules
        .iter()
        .filter_map(|rule| {
            let key = rule.get("key")?.as_str()?;
            let command = rule.get("command")?.as_str()?;
            let shortcut = parse_shortcut(key)?;
            let mut resolved = json!({ "command": command, "shortcut": shortcut });
            if let Some(when) = rule.get("when").and_then(Value::as_str)
                && let Some(ast) = parse_when(when)
            {
                resolved["whenAst"] = ast;
            }
            Some(resolved)
        })
        .collect()
}

fn parse_shortcut(input: &str) -> Option<Value> {
    let plus_key = input == "+" || input.ends_with("++");
    let modifier_input = if plus_key {
        input.strip_suffix('+').unwrap_or_default()
    } else {
        input
    };
    let mut parts = modifier_input
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let normalized_key = if plus_key {
        "+".to_owned()
    } else {
        parts.pop()?.to_ascii_lowercase()
    };
    if is_modifier(&normalized_key) {
        return None;
    }
    let mut modifiers = HashSet::new();
    for modifier in parts {
        let normalized = modifier.to_ascii_lowercase();
        if !is_modifier(&normalized) || !modifiers.insert(normalized) {
            return None;
        }
    }
    let key = match normalized_key.as_str() {
        "space" => " ".to_owned(),
        _ => normalized_key,
    };
    let meta = modifiers.contains("meta") || modifiers.contains("cmd");
    let ctrl = modifiers.contains("ctrl") || modifiers.contains("control");
    let alt = modifiers.contains("alt") || modifiers.contains("option");
    Some(json!({
        "key": key,
        "metaKey": meta,
        "ctrlKey": ctrl,
        "shiftKey": modifiers.contains("shift"),
        "altKey": alt,
        "modKey": modifiers.contains("mod") || meta || ctrl,
    }))
}

fn is_modifier(input: &str) -> bool {
    matches!(
        input,
        "mod" | "meta" | "cmd" | "ctrl" | "control" | "alt" | "option" | "shift"
    )
}

fn parse_when(input: &str) -> Option<Value> {
    let input = input.trim();
    if input.is_empty() || !balanced_parentheses(input) {
        return None;
    }
    if let Some((left, right)) = split_condition(input, "||") {
        return Some(
            json!({ "type": "or", "left": parse_when(left)?, "right": parse_when(right)? }),
        );
    }
    if let Some((left, right)) = split_condition(input, "&&") {
        return Some(
            json!({ "type": "and", "left": parse_when(left)?, "right": parse_when(right)? }),
        );
    }
    if let Some(rest) = input.strip_prefix('!') {
        return Some(json!({ "type": "not", "node": parse_when(rest.trim_matches(['(', ')']))? }));
    }
    let identifier = input.trim_matches(['(', ')']).trim();
    (!identifier.is_empty()).then(|| json!({ "type": "identifier", "name": identifier }))
}

fn balanced_parentheses(input: &str) -> bool {
    let mut depth = 0_i32;
    for character in input.chars() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn split_condition<'a>(input: &'a str, operator: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0_i32;
    for (index, character) in input.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth == 0 && input[index..].starts_with(operator) => {
                return Some((&input[..index], &input[index + operator.len()..]));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_parser_respects_nested_precedence_negation_and_balance() {
        assert_eq!(
            parse_when("editorFocus && !terminalFocus || modalOpen"),
            Some(json!({
                "type":"or",
                "left":{
                    "type":"and",
                    "left":{"type":"identifier","name":"editorFocus"},
                    "right":{"type":"not","node":{"type":"identifier","name":"terminalFocus"}}
                },
                "right":{"type":"identifier","name":"modalOpen"}
            }))
        );
        assert_eq!(parse_when("(editorFocus"), None);
        assert_eq!(parse_when("editorFocus)"), None);
        assert_eq!(parse_when(""), None);
        assert_eq!(split_condition("(left || right) && tail", "||"), None);
    }
}
