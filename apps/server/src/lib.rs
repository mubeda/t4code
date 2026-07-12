//! Reusable T4Code server runtime.

pub mod assets;
mod auth;
pub mod checkpointing;
pub mod cloud;
mod config;
pub mod diagnostics;
pub mod git;
mod http;
mod lifecycle;
pub mod logging;
pub mod mcp;
pub mod observability;
pub mod orchestration;
pub mod persistence;
pub mod preview;
pub mod process;
pub mod production;
pub mod project;
pub mod provider;
pub mod provider_usage;
pub mod review;
mod rpc;
pub mod server_settings;
pub mod source_control;
pub mod telemetry;
pub mod terminal;
pub mod text_generation;
pub mod vcs;
pub mod workspace;

use clap::Parser;
use serde_json::json;
use thiserror::Error;

pub use config::{Cli, ConfigError, ServerConfig, ServerMode};
pub use http::{
    DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ROUTE_INVENTORY, RouteMethod, RouteSpec,
};
pub use lifecycle::{ServerError, ServerHandle, ServerRuntime, StartupAccess};
pub use rpc::{
    ACTIVE_RPC_METHODS, CauseItem, ClientMessage, InvalidRequestId, MethodMode, RequestId, RpcExit,
    RpcMethodSpec, RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk, ServerMessage, WireMessage,
};

#[derive(Debug, Error)]
pub enum RunError {
    #[error(transparent)]
    Cli(#[from] clap::Error),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("failed to install the shutdown signal handler")]
    ShutdownSignal(#[source] std::io::Error),
    #[error("failed to open the T4Code browser client")]
    OpenBrowser(#[source] std::io::Error),
}

pub async fn run_cli() -> Result<(), RunError> {
    let config = Cli::try_parse()?.into_server_config()?;
    let open_browser = !config.no_browser;
    let handle = ServerRuntime::start(config).await?;
    let http_base_url = format!("http://{}", handle.local_addr());
    let browser_target = handle
        .startup_access()
        .map(|access| access.pairing_url.as_str())
        .unwrap_or(http_base_url.as_str());
    let mut startup_output = json!({
        "address": handle.local_addr().to_string(),
        "httpBaseUrl": http_base_url.as_str(),
    });
    if let Some(access) = handle.startup_access()
        && let Some(output) = startup_output.as_object_mut()
    {
        output.insert("token".to_owned(), json!(access.credential));
        output.insert("pairingUrl".to_owned(), json!(access.pairing_url));
    }
    println!("{}", startup_output);
    if open_browser {
        open::that_detached(browser_target).map_err(RunError::OpenBrowser)?;
    }

    tokio::select! {
        signal = termination_signal() => {
            signal.map_err(RunError::ShutdownSignal)?;
            handle.shutdown();
        }
        () = handle.wait_for_shutdown() => {}
    }
    handle.join().await?;
    Ok(())
}

#[cfg(unix)]
async fn termination_signal() -> Result<(), std::io::Error> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn termination_signal() -> Result<(), std::io::Error> {
    tokio::signal::ctrl_c().await
}
