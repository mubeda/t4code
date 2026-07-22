use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct TabEntry {
    pub label: String,
    pub bounds: Option<PendingBounds>,
    pub visible: bool,
    pub zoom: f64,
    pub last_url: String,
    pub created: bool,
}

#[allow(dead_code)]
pub fn webview_label_for_tab(tab_id: &str) -> String {
    let sanitized: String = tab_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("preview-{sanitized}")
}

#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct PreviewRegistry {
    tabs: HashMap<String, TabEntry>,
}

#[allow(dead_code)]
impl PreviewRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_pending(&mut self, tab_id: &str) -> &mut TabEntry {
        self.tabs
            .entry(tab_id.to_string())
            .or_insert_with(|| TabEntry {
                label: webview_label_for_tab(tab_id),
                bounds: None,
                visible: false,
                zoom: 1.0,
                last_url: String::new(),
                created: false,
            })
    }

    pub fn get(&self, tab_id: &str) -> Option<&TabEntry> {
        self.tabs.get(tab_id)
    }

    pub fn get_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry> {
        self.tabs.get_mut(tab_id)
    }

    pub fn remove(&mut self, tab_id: &str) -> Option<TabEntry> {
        self.tabs.remove(tab_id)
    }

    pub fn tab_id_for_label(&self, label: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|(_, entry)| entry.label == label)
            .map(|(tab_id, _)| tab_id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_deterministic_and_sanitized() {
        assert_eq!(webview_label_for_tab("tab-1"), "preview-tab-1");
        // tauri labels must be alphanumeric plus `-`/`_`/`:`; everything else maps to `_`
        assert_eq!(webview_label_for_tab("a b/c"), "preview-a_b_c");
    }

    #[test]
    fn upsert_then_get_roundtrip() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1").bounds = Some(PendingBounds {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        });
        assert!(!reg.get("t1").unwrap().created);
        assert_eq!(reg.get("t1").unwrap().bounds.as_ref().unwrap().width, 3.0);
    }

    #[test]
    fn reverse_label_lookup() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1");
        let label = reg.get("t1").unwrap().label.clone();
        assert_eq!(reg.tab_id_for_label(&label).as_deref(), Some("t1"));
    }

    #[test]
    fn remove_clears_entry() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1");
        assert!(reg.remove("t1").is_some());
        assert!(reg.get("t1").is_none());
    }
}
