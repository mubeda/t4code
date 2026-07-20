#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = t4code_server::process::run_windows_batch_trampoline() {
        std::process::exit(exit_code);
    }
    t4code_desktop_lib::run();
}
