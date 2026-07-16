pub mod acp;
mod capabilities;
pub mod model;
pub mod runtime;

#[cfg_attr(test, allow(unused_imports))]
pub use acp::{AcpConnectionConfig, AcpJsonRpcConnection, IncomingEvent};
pub use capabilities::{CursorWorkspaceCapabilities, discover_workspace_capabilities};
#[cfg_attr(test, allow(unused_imports))]
pub use model::{
    CursorAboutResult, CursorProviderModel, CursorProviderSnapshot,
    build_capabilities_from_config_options, discover_models_from_list_available_models,
    parse_about_output, parse_cli_config_channel, parse_version_date, resolve_acp_base_model_id,
    resolve_acp_config_updates,
};
#[cfg_attr(test, allow(unused_imports))]
pub use runtime::{
    CursorRuntimeEvent, CursorRuntimeEventStableView, CursorSessionOptions, CursorSessionRuntime,
};
