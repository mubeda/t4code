pub use crate::provider::cursor::acp;

pub mod model;
pub mod runtime;

#[cfg_attr(test, allow(unused_imports))]
pub use acp::{AcpConnectionConfig, AcpJsonRpcConnection, IncomingEvent};
#[cfg_attr(test, allow(unused_imports))]
pub use model::{GrokProviderModel, GrokProviderSnapshot, build_snapshot_from_probe};
#[cfg_attr(test, allow(unused_imports))]
pub use runtime::{
    GrokRuntimeEvent, GrokRuntimeEventStableView, GrokSessionOptions, GrokSessionRuntime,
};
