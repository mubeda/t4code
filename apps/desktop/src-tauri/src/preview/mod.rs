#![allow(dead_code, unused_imports)]

use std::sync::Mutex;

pub mod registry;

pub use registry::{webview_label_for_tab, PendingBounds, PreviewRegistry, TabEntry};

pub struct PreviewHostState(pub Mutex<PreviewRegistry>);

impl PreviewHostState {
    pub fn new() -> Self {
        Self(Mutex::new(PreviewRegistry::new()))
    }
}
