use std::sync::Mutex;

pub mod platform;
pub mod registry;

#[allow(unused_imports)]
pub use registry::{webview_label_for_tab, PendingBounds, PreviewRegistry, TabEntry};

#[allow(dead_code)]
pub struct PreviewHostState(pub Mutex<PreviewRegistry>);

impl PreviewHostState {
    pub fn new() -> Self {
        Self(Mutex::new(PreviewRegistry::new()))
    }
}
