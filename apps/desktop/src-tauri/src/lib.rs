use tauri::Manager;

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
            desktop_bridge_confirm,
            desktop_bridge_open_external,
        ]
    };
}

macro_rules! bridge_invoke_handler {
    ($($command:ident),+ $(,)?) => {
        tauri::generate_handler![$(bridge::$command),+]
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
    tauri::Builder::default()
        .manage(backend::BackendSupervisor::new())
        .manage(context_menu::NativeContextMenuManager::new())
        .manage(ssh::SshEnvironmentManager::new())
        .manage(ssh::SshPasswordPromptManager::new())
        .manage(updates::DesktopUpdateManager::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            window::configure_application_menu(app.handle())?;
            window::restore_main_window_state(app.handle())?;

            if !cfg!(debug_assertions) {
                let app_handle = app.handle().clone();
                let backend = app.state::<backend::BackendSupervisor>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    match backend.start_default(app_handle).await {
                        Ok(_config) => {}
                        Err(error) => {
                            tracing::error!("failed to start Tauri desktop backend: {error}");
                            backend.record_error(error);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(desktop_bridge_commands!(bridge_invoke_handler))
        .build(tauri::generate_context!())
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
                    backend.stop(backend::BackendShutdownConfig::default()),
                ) {
                    tracing::warn!("failed to stop Tauri desktop backend during exit: {error}");
                }
            }
        });
}

mod backend;
mod bridge;
mod config;
mod context_menu;
mod security;
pub mod ssh;
mod tailscale;
mod updates;
mod window;

#[cfg(test)]
const DESKTOP_BRIDGE_COMMAND_NAMES: &[&str] = desktop_bridge_commands!(bridge_command_names);

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::DESKTOP_BRIDGE_COMMAND_NAMES;

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
}
