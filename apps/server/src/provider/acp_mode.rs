use serde_json::Value;

const PLAN_ALIASES: &[&str] = &["plan", "architect"];
const IMPLEMENT_ALIASES: &[&str] = &["code", "agent", "default", "chat", "implement"];
const APPROVAL_ALIASES: &[&str] = &["ask"];

pub(crate) fn resolve_requested_mode_id(
    mode_state: Option<&Value>,
    runtime_mode: &str,
    interaction_mode: &str,
) -> Option<String> {
    let mode_state = mode_state?;
    let current = mode_state.get("currentModeId").and_then(Value::as_str)?;
    let modes = mode_state.get("availableModes")?.as_array()?;
    if interaction_mode == "plan" {
        return find_mode(modes, PLAN_ALIASES);
    }
    let first = if runtime_mode == "approval-required" {
        APPROVAL_ALIASES
    } else {
        IMPLEMENT_ALIASES
    };
    let second = if runtime_mode == "approval-required" {
        IMPLEMENT_ALIASES
    } else {
        APPROVAL_ALIASES
    };
    find_mode(modes, first)
        .or_else(|| find_mode(modes, second))
        .or_else(|| {
            modes.iter().find_map(|mode| {
                (!matches_mode(mode, PLAN_ALIASES))
                    .then(|| mode.get("id").and_then(Value::as_str).map(str::to_owned))
                    .flatten()
            })
        })
        .or_else(|| Some(current.to_owned()))
}

pub(crate) fn auto_approved_option_id(options: &[Value]) -> Option<String> {
    find_permission_option(options, "allow_always")
        .or_else(|| find_permission_option(options, "allow_once"))
}

fn find_mode(modes: &[Value], aliases: &[&str]) -> Option<String> {
    aliases
        .iter()
        .find_map(|alias| {
            modes.iter().find_map(|mode| {
                let id = mode.get("id").and_then(Value::as_str)?;
                let name = mode.get("name").and_then(Value::as_str).unwrap_or_default();
                (id.eq_ignore_ascii_case(alias) || name.eq_ignore_ascii_case(alias))
                    .then(|| id.to_owned())
            })
        })
        .or_else(|| {
            aliases.iter().find_map(|alias| {
                modes.iter().find_map(|mode| {
                    let id = mode.get("id").and_then(Value::as_str)?;
                    normalize_mode(mode)
                        .contains(&alias.to_ascii_lowercase())
                        .then(|| id.to_owned())
                })
            })
        })
}

fn matches_mode(mode: &Value, aliases: &[&str]) -> bool {
    find_mode(std::slice::from_ref(mode), aliases).is_some()
}

fn normalize_mode(mode: &Value) -> String {
    ["id", "name", "description"]
        .into_iter()
        .filter_map(|field| mode.get(field).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
}

fn find_permission_option(options: &[Value], kind: &str) -> Option<String> {
    options.iter().find_map(|option| {
        (option.get("kind").and_then(Value::as_str) == Some(kind))
            .then(|| {
                option
                    .get("optionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
            })
            .flatten()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn resolves_plan_approval_and_implementation_modes() {
        let modes = json!({
            "currentModeId": "code",
            "availableModes": [
                { "id": "architect", "name": "Plan" },
                { "id": "ask", "name": "Ask before edits" },
                { "id": "code", "name": "Agent" }
            ]
        });
        assert_eq!(
            super::resolve_requested_mode_id(Some(&modes), "full-access", "plan").as_deref(),
            Some("architect")
        );
        assert_eq!(
            super::resolve_requested_mode_id(Some(&modes), "approval-required", "default")
                .as_deref(),
            Some("ask")
        );
        assert_eq!(
            super::resolve_requested_mode_id(Some(&modes), "full-access", "default").as_deref(),
            Some("code")
        );
    }

    #[test]
    fn auto_approval_prefers_the_persistent_option() {
        let options = vec![
            json!({ "kind": "allow_once", "optionId": "once" }),
            json!({ "kind": "allow_always", "optionId": "always" }),
        ];
        assert_eq!(
            super::auto_approved_option_id(&options).as_deref(),
            Some("always")
        );
    }
}
