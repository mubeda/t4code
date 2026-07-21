use tauri::Manager;

#[cfg(test)]
macro_rules! desktop_bridge_commands {
    ($with_commands:ident) => {
        $with_commands![
            desktop_bridge_get_bridge_metadata,
            desktop_bridge_get_app_branding,
            desktop_bridge_get_local_environment_bootstraps,
            desktop_bridge_get_client_settings,
            desktop_bridge_set_client_settings,
            desktop_bridge_get_connection_catalog,
            desktop_bridge_set_connection_catalog,
            desktop_bridge_clear_connection_catalog,
            desktop_bridge_discover_ssh_hosts,
            desktop_bridge_ensure_ssh_environment,
            desktop_bridge_disconnect_ssh_environment,
            desktop_bridge_fetch_environment_descriptor,
            desktop_bridge_bootstrap_ssh_bearer_session,
            desktop_bridge_fetch_ssh_session_state,
            desktop_bridge_issue_ssh_web_socket_ticket,
            desktop_bridge_resolve_ssh_password_prompt,
            desktop_bridge_get_server_exposure_state,
            desktop_bridge_set_server_exposure_mode,
            desktop_bridge_set_tailscale_serve_enabled,
            desktop_bridge_get_advertised_endpoints,
            desktop_bridge_get_wsl_state,
            desktop_bridge_set_wsl_backend_enabled,
            desktop_bridge_set_wsl_distro,
            desktop_bridge_set_wsl_only,
            desktop_bridge_set_theme,
            desktop_bridge_show_context_menu,
            desktop_bridge_get_update_state,
            desktop_bridge_set_update_channel,
            desktop_bridge_check_for_update,
            desktop_bridge_download_update,
            desktop_bridge_install_update,
            desktop_bridge_pick_folder,
            desktop_bridge_save_diagnostic_logs,
            desktop_bridge_confirm,
            desktop_bridge_open_external,
        ]
    };
}

#[cfg(test)]
macro_rules! desktop_preview_commands {
    ($with_commands:ident) => {
        $with_commands![
            desktop_preview_create_tab,
            desktop_preview_close_tab,
            desktop_preview_set_bounds,
            desktop_preview_navigate,
            desktop_preview_go_back,
            desktop_preview_go_forward,
            desktop_preview_refresh,
            desktop_preview_hard_reload,
            desktop_preview_set_zoom,
            desktop_preview_open_devtools,
            desktop_preview_clear_data,
            desktop_preview_capture_screenshot,
            desktop_preview_reveal_artifact,
        ]
    };
}

#[cfg(test)]
macro_rules! bridge_command_names {
    ($($command:ident),+ $(,)?) => {
        &[$(stringify!($command)),+]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shell_path_hydration = shell_environment::hydrate_process_path();
    let builder = tauri::Builder::<bridge::DesktopRuntime>::new()
        .manage(backend::BackendSupervisor::new())
        .manage(context_menu::NativeContextMenuManager::new())
        .manage(ssh::SshEnvironmentManager::new())
        .manage(ssh::SshPasswordPromptManager::new())
        .manage(updates::DesktopUpdateManager::new())
        .manage(preview::PreviewHostState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(desktop_e2e_logging_plugin())
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let builder = builder.setup(move |app| {
        shell_path_hydration.record();
        window::configure_application_menu(app.handle())?;
        window::restore_main_window_state(app.handle())?;

        let app_handle = app.handle().clone();
        let backend = app.state::<backend::BackendSupervisor>().inner().clone();
        #[cfg(unix)]
        backend::install_termination_signal_handler(app_handle.clone(), backend.clone());
        tauri::async_runtime::spawn(async move {
            match backend.start_default(app_handle).await {
                Ok(_config) => {}
                Err(error) => {
                    tracing::error!("failed to start Tauri desktop backend: {error}");
                    backend.record_error(error);
                }
            }
        });
        Ok(())
    });
    #[cfg(not(test))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        bridge::desktop_bridge_get_bridge_metadata,
        bridge::desktop_bridge_get_app_branding,
        bridge::desktop_bridge_get_local_environment_bootstraps,
        bridge::desktop_bridge_get_client_settings,
        bridge::desktop_bridge_set_client_settings,
        bridge::desktop_bridge_get_connection_catalog,
        bridge::desktop_bridge_set_connection_catalog,
        bridge::desktop_bridge_clear_connection_catalog,
        bridge::desktop_bridge_discover_ssh_hosts,
        bridge::desktop_bridge_ensure_ssh_environment,
        bridge::desktop_bridge_disconnect_ssh_environment,
        bridge::desktop_bridge_fetch_environment_descriptor,
        bridge::desktop_bridge_bootstrap_ssh_bearer_session,
        bridge::desktop_bridge_fetch_ssh_session_state,
        bridge::desktop_bridge_issue_ssh_web_socket_ticket,
        bridge::desktop_bridge_resolve_ssh_password_prompt,
        bridge::desktop_bridge_get_server_exposure_state,
        bridge::desktop_bridge_set_server_exposure_mode,
        bridge::desktop_bridge_set_tailscale_serve_enabled,
        bridge::desktop_bridge_get_advertised_endpoints,
        bridge::desktop_bridge_get_wsl_state,
        bridge::desktop_bridge_set_wsl_backend_enabled,
        bridge::desktop_bridge_set_wsl_distro,
        bridge::desktop_bridge_set_wsl_only,
        bridge::desktop_bridge_set_theme,
        bridge::desktop_bridge_show_context_menu,
        bridge::desktop_bridge_get_update_state,
        bridge::desktop_bridge_set_update_channel,
        bridge::desktop_bridge_check_for_update,
        bridge::desktop_bridge_download_update,
        bridge::desktop_bridge_install_update,
        bridge::desktop_bridge_pick_folder,
        bridge::desktop_bridge_save_diagnostic_logs,
        bridge::desktop_bridge_confirm,
        bridge::desktop_bridge_open_external,
        preview::commands::desktop_preview_create_tab,
        preview::commands::desktop_preview_close_tab,
        preview::commands::desktop_preview_set_bounds,
        preview::commands::desktop_preview_navigate,
        preview::commands::desktop_preview_go_back,
        preview::commands::desktop_preview_go_forward,
        preview::commands::desktop_preview_refresh,
        preview::commands::desktop_preview_hard_reload,
        preview::commands::desktop_preview_set_zoom,
        preview::commands::desktop_preview_open_devtools,
        preview::commands::desktop_preview_clear_data,
        preview::commands::desktop_preview_capture_screenshot,
        preview::commands::desktop_preview_reveal_artifact,
    ]);
    builder
        .build(desktop_context())
        .expect("error while building T4Code Tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                use tauri::Manager as _;

                if let Err(error) = window::persist_main_window_state(app_handle) {
                    tracing::warn!(
                        "failed to persist Tauri main window state during exit: {error}"
                    );
                }
                let backend = app_handle
                    .state::<backend::BackendSupervisor>()
                    .inner()
                    .clone();
                if let Err(error) = tauri::async_runtime::block_on(
                    backend.stop_for_exit(backend::BackendShutdownConfig::default()),
                ) {
                    tracing::warn!("failed to stop Tauri desktop backend during exit: {error}");
                }
            }
        });
}

fn desktop_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg(feature = "desktop-e2e")]
fn desktop_e2e_logging_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("desktop-e2e-logging")
        .setup(|app, _api| {
            let server_log = config::state_dir(app)
                .map_err(std::io::Error::other)?
                .join("logs")
                .join("server.log");
            t4code_server::logging::initialize(&server_log)?;
            Ok(())
        })
        .build()
}

mod backend;
mod bridge;
mod config;
mod context_menu;
mod preview;
mod security;
mod shell_environment;
pub mod ssh;
mod tailscale;
mod updates;
mod window;

pub use bridge::{
    desktop_bridge_bootstrap_ssh_bearer_session, desktop_bridge_fetch_environment_descriptor,
    desktop_bridge_fetch_ssh_session_state, desktop_bridge_get_bridge_metadata,
    desktop_bridge_issue_ssh_web_socket_ticket,
};

#[cfg(test)]
const DESKTOP_BRIDGE_COMMAND_NAMES: &[&str] = desktop_bridge_commands!(bridge_command_names);

#[cfg(test)]
const DESKTOP_PREVIEW_COMMAND_NAMES: &[&str] = desktop_preview_commands!(bridge_command_names);

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{DESKTOP_BRIDGE_COMMAND_NAMES, DESKTOP_PREVIEW_COMMAND_NAMES};

    #[derive(Debug, Deserialize)]
    struct PermissionsFile {
        permission: Vec<PermissionEntry>,
    }

    #[derive(Debug, Deserialize)]
    struct PermissionEntry {
        identifier: String,
        commands: PermissionCommands,
    }

    #[derive(Debug, Deserialize)]
    struct PermissionCommands {
        allow: Vec<String>,
    }

    #[test]
    fn desktop_bridge_permission_allows_registered_commands() {
        let permissions: PermissionsFile =
            toml::from_str(include_str!("../permissions/desktop-bridge.toml"))
                .expect("desktop bridge permission TOML should parse");

        let bridge_permission = permissions
            .permission
            .iter()
            .find(|permission| permission.identifier == "allow-desktop-bridge")
            .expect("desktop bridge permission should exist");

        let mut allowed = bridge_permission.commands.allow.clone();
        allowed.sort();

        let mut registered = DESKTOP_BRIDGE_COMMAND_NAMES
            .iter()
            .map(|command| (*command).to_string())
            .collect::<Vec<_>>();
        registered.sort();

        assert_eq!(allowed, registered);
    }

    #[test]
    fn desktop_preview_permission_allows_registered_commands() {
        let permissions: PermissionsFile =
            toml::from_str(include_str!("../permissions/preview.toml"))
                .expect("desktop preview permission TOML should parse");

        let preview_permission = permissions
            .permission
            .iter()
            .find(|permission| permission.identifier == "allow-desktop-preview")
            .expect("desktop preview permission should exist");

        let mut allowed = preview_permission.commands.allow.clone();
        allowed.sort();

        let mut registered = DESKTOP_PREVIEW_COMMAND_NAMES
            .iter()
            .map(|command| (*command).to_string())
            .collect::<Vec<_>>();
        registered.sort();

        assert_eq!(allowed, registered);
    }

    #[test]
    fn generated_handler_registers_the_audited_command_lists() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .and_then(|(_, remainder)| remainder.split_once("]);"))
            .map(|(handler, _)| handler)
            .expect("explicit generate_handler invocation should exist");

        let registered_with_prefix = |prefix: &str| {
            let mut commands = handler
                .lines()
                .filter_map(|line| {
                    line.trim()
                        .strip_prefix(prefix)
                        .and_then(|line| line.strip_suffix(','))
                        .map(str::to_string)
                })
                .collect::<Vec<_>>();
            commands.sort();
            commands
        };
        let audited = |commands: &[&str]| {
            let mut commands = commands
                .iter()
                .map(|command| (*command).to_string())
                .collect::<Vec<_>>();
            commands.sort();
            commands
        };

        assert_eq!(
            registered_with_prefix("bridge::"),
            audited(DESKTOP_BRIDGE_COMMAND_NAMES)
        );
        assert_eq!(
            registered_with_prefix("preview::commands::"),
            audited(DESKTOP_PREVIEW_COMMAND_NAMES)
        );
    }

    #[test]
    fn desktop_bridge_permission_toml_round_trips_without_schema_drift() {
        let source = include_str!("../permissions/desktop-bridge.toml");
        let parsed: toml::Value = toml::from_str(source).expect("permission TOML should parse");
        let encoded = toml::to_string(&parsed).expect("permission TOML should encode");
        let reparsed: toml::Value =
            toml::from_str(&encoded).expect("encoded permission TOML should parse");

        assert_eq!(reparsed, parsed);
    }
}
