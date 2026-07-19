#[path = "../../../../src/diagnostics/mod.rs"]
pub mod diagnostics;
#[path = "../../../../src/process/mod.rs"]
pub mod process;
#[path = "../../../../src/terminal/mod.rs"]
pub mod terminal;

#[must_use]
pub fn redact_sensitive_text(input: &str) -> String {
    diagnostics::redact_sensitive_text(input)
}

#[cfg(test)]
pub fn external_process_test_lock() -> &'static tokio::sync::Mutex<()> {
    &process::EXTERNAL_PROCESS_TEST_LOCK
}
