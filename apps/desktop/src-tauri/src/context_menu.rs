use serde::Deserialize;
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{
    AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow,
    menu::{MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder},
};
use tokio::sync::oneshot;
use uuid::Uuid;

const CONTEXT_MENU_ID_PREFIX: &str = "t4code:context-menu:";
const CONTEXT_MENU_SELECTION_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextMenuPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeContextMenuItem {
    native_id: String,
    original_id: String,
    label: String,
    destructive: bool,
    disabled: bool,
    children: Vec<NativeContextMenuItem>,
}

#[derive(Debug)]
pub(crate) struct NativeContextMenuRequest {
    request_id: String,
    items: Vec<NativeContextMenuItem>,
    native_to_original: HashMap<String, String>,
}

struct PendingContextMenu {
    request_id: String,
    native_to_original: HashMap<String, String>,
    sender: Option<oneshot::Sender<String>>,
}

pub(crate) struct PendingContextMenuTicket {
    pub(crate) request_id: String,
    receiver: oneshot::Receiver<String>,
}

#[derive(Default)]
pub(crate) struct NativeContextMenuManager {
    pending: Mutex<Option<PendingContextMenu>>,
}

impl NativeContextMenuManager {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn begin(
        &self,
        request: &NativeContextMenuRequest,
    ) -> Result<PendingContextMenuTicket, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Could not acquire the native context menu state.".to_string())?;
        if pending.is_some() {
            return Err("A native context menu is already open.".to_string());
        }

        let (sender, receiver) = oneshot::channel();
        *pending = Some(PendingContextMenu {
            request_id: request.request_id.clone(),
            native_to_original: request.native_to_original.clone(),
            sender: Some(sender),
        });

        Ok(PendingContextMenuTicket {
            request_id: request.request_id.clone(),
            receiver,
        })
    }

    pub(crate) fn complete_if_context_menu_event(&self, native_id: &str) -> bool {
        if !native_id.starts_with(CONTEXT_MENU_ID_PREFIX) {
            return false;
        }

        let selected = self.pending.lock().ok().and_then(|mut pending| {
            let pending = pending.as_mut()?;
            let original_id = pending.native_to_original.get(native_id)?.clone();
            pending.sender.take().map(|sender| (sender, original_id))
        });

        if let Some((sender, original_id)) = selected {
            let _ = sender.send(original_id);
        }
        true
    }

    pub(crate) async fn finish_after_popup(
        &self,
        ticket: PendingContextMenuTicket,
    ) -> Option<String> {
        let selected = match tokio::time::timeout(
            CONTEXT_MENU_SELECTION_SETTLE_TIMEOUT,
            ticket.receiver,
        )
        .await
        {
            Ok(Ok(selected)) => Some(selected),
            _ => None,
        };
        self.cancel(&ticket.request_id);
        selected
    }

    pub(crate) fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock()
            && pending
                .as_ref()
                .is_some_and(|pending| pending.request_id == request_id)
        {
            *pending = None;
        }
    }
}

pub(crate) fn context_menu_request_from_values(items: Vec<Value>) -> NativeContextMenuRequest {
    let request_id = Uuid::new_v4().to_string();
    let mut next_item_index = 0usize;
    let mut native_to_original = HashMap::new();
    let items = normalize_context_menu_items(
        &items,
        &request_id,
        &mut next_item_index,
        &mut native_to_original,
    );

    NativeContextMenuRequest {
        request_id,
        items,
        native_to_original,
    }
}

pub(crate) fn show_native_context_menu(
    window: &WebviewWindow,
    request: &NativeContextMenuRequest,
    position: Option<ContextMenuPosition>,
) -> Result<(), String> {
    if request.items.is_empty() {
        return Ok(());
    }

    let menu = build_native_context_menu(window.app_handle(), request)?;
    if let Some(position) = normalize_context_menu_position(position) {
        window
            .popup_menu_at(&menu, position)
            .map_err(|error| format!("Could not show the native context menu: {error}"))
    } else {
        window
            .popup_menu(&menu)
            .map_err(|error| format!("Could not show the native context menu: {error}"))
    }
}

pub(crate) fn context_menu_request_has_selectable_items(
    request: &NativeContextMenuRequest,
) -> bool {
    !request.native_to_original.is_empty()
}

fn build_native_context_menu<R: Runtime>(
    app: &AppHandle<R>,
    request: &NativeContextMenuRequest,
) -> Result<Submenu<R>, String> {
    let root = SubmenuBuilder::with_id(
        app,
        format!("{CONTEXT_MENU_ID_PREFIX}{}:root", request.request_id),
        "Context Menu",
    )
    .build()
    .map_err(|error| format!("Could not build the native context menu: {error}"))?;
    append_context_menu_items(app, &root, &request.items)
        .map_err(|error| format!("Could not populate the native context menu: {error}"))?;
    Ok(root)
}

fn append_context_menu_items<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Submenu<R>,
    items: &[NativeContextMenuItem],
) -> tauri::Result<()> {
    let mut inserted_any = false;
    let mut inserted_destructive_separator = false;

    for item in items {
        if item.destructive && !inserted_destructive_separator && inserted_any {
            let separator = PredefinedMenuItem::separator(app)?;
            menu.append(&separator)?;
            inserted_destructive_separator = true;
        }

        if item.children.is_empty() {
            let native_item = MenuItemBuilder::with_id(item.native_id.clone(), &item.label)
                .enabled(!item.disabled)
                .build(app)?;
            menu.append(&native_item)?;
        } else {
            let submenu = SubmenuBuilder::with_id(app, item.native_id.clone(), &item.label)
                .enabled(!item.disabled)
                .build()?;
            append_context_menu_items(app, &submenu, &item.children)?;
            menu.append(&submenu)?;
        }
        inserted_any = true;
    }

    Ok(())
}

fn normalize_context_menu_items(
    values: &[Value],
    request_id: &str,
    next_item_index: &mut usize,
    native_to_original: &mut HashMap<String, String>,
) -> Vec<NativeContextMenuItem> {
    values
        .iter()
        .filter_map(|value| {
            normalize_context_menu_item(value, request_id, next_item_index, native_to_original)
        })
        .collect()
}

fn normalize_context_menu_item(
    value: &Value,
    request_id: &str,
    next_item_index: &mut usize,
    native_to_original: &mut HashMap<String, String>,
) -> Option<NativeContextMenuItem> {
    let object = value.as_object()?;
    if bool_property(object, "header") {
        return None;
    }

    let original_id = string_property(object, "id")?.to_string();
    let label = string_property(object, "label")?.to_string();
    let children = object
        .get("children")
        .and_then(Value::as_array)
        .map(|children| {
            normalize_context_menu_items(children, request_id, next_item_index, native_to_original)
        })
        .unwrap_or_default();

    if object.contains_key("children") && children.is_empty() {
        return None;
    }

    let native_id = format!("{CONTEXT_MENU_ID_PREFIX}{request_id}:{}", *next_item_index);
    *next_item_index += 1;

    if children.is_empty() {
        native_to_original.insert(native_id.clone(), original_id.clone());
    }

    Some(NativeContextMenuItem {
        native_id,
        original_id,
        label,
        destructive: bool_property(object, "destructive"),
        disabled: bool_property(object, "disabled"),
        children,
    })
}

fn normalize_context_menu_position(
    position: Option<ContextMenuPosition>,
) -> Option<LogicalPosition<f64>> {
    position
        .filter(|position| {
            position.x.is_finite()
                && position.y.is_finite()
                && position.x >= 0.0
                && position.y >= 0.0
        })
        .map(|position| LogicalPosition::new(position.x.floor(), position.y.floor()))
}

fn string_property<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn bool_property(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_context_menu_items_for_native_menus() {
        let request = context_menu_request_from_values(vec![
            json!({ "id": "header", "label": "Group", "header": true }),
            json!({ "label": "Missing id" }),
            json!({ "id": "open", "label": "Open" }),
            json!({
                "id": "share",
                "label": "Share",
                "children": [
                    { "id": "copy-link", "label": "Copy link", "disabled": true },
                    { "id": "empty", "label": "Empty", "children": [] }
                ]
            }),
            json!({ "id": "delete", "label": "Delete", "destructive": true }),
        ]);

        assert_eq!(request.items.len(), 3);
        assert_eq!(request.items[0].original_id, "open");
        assert_eq!(request.items[1].original_id, "share");
        assert_eq!(request.items[1].children.len(), 1);
        assert_eq!(request.items[1].children[0].original_id, "copy-link");
        assert!(request.items[1].children[0].disabled);
        assert!(request.items[2].destructive);
        assert_eq!(request.native_to_original.len(), 3);
        assert!(request.native_to_original.values().any(|id| id == "open"));
        assert!(
            request
                .native_to_original
                .values()
                .any(|id| id == "copy-link")
        );
        assert!(request.native_to_original.values().any(|id| id == "delete"));
    }

    #[test]
    fn normalizes_context_menu_position_to_non_negative_logical_pixels() {
        assert_eq!(
            normalize_context_menu_position(Some(ContextMenuPosition { x: 12.9, y: 3.2 })),
            Some(LogicalPosition::new(12.0, 3.0))
        );
        assert_eq!(
            normalize_context_menu_position(Some(ContextMenuPosition { x: -1.0, y: 3.0 })),
            None
        );
        assert_eq!(
            normalize_context_menu_position(Some(ContextMenuPosition {
                x: f64::NAN,
                y: 3.0
            })),
            None
        );
    }

    #[tokio::test]
    async fn manager_resolves_matching_context_menu_events() {
        let manager = NativeContextMenuManager::new();
        let request = context_menu_request_from_values(vec![json!({
            "id": "open",
            "label": "Open"
        })]);
        let native_id = request
            .native_to_original
            .iter()
            .find_map(|(native_id, original_id)| {
                (original_id == "open").then_some(native_id.clone())
            })
            .expect("native id for open item");
        let ticket = manager.begin(&request).expect("begin context menu");

        assert!(manager.complete_if_context_menu_event(&native_id));
        assert_eq!(
            manager.finish_after_popup(ticket).await,
            Some("open".to_string())
        );
    }

    #[tokio::test]
    async fn manager_times_out_without_selection() {
        let manager = NativeContextMenuManager::new();
        let request = context_menu_request_from_values(vec![json!({
            "id": "open",
            "label": "Open"
        })]);
        let ticket = manager.begin(&request).expect("begin context menu");

        assert_eq!(manager.finish_after_popup(ticket).await, None);
    }
}
