use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    if let Some(exit_code) = t4code_server::process::run_windows_batch_trampoline() {
        std::process::exit(exit_code);
    }
    match t4code_server::run_cli().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(t4code_server::RunError::Cli(error)) => {
            let success = error.exit_code() == 0;
            if let Err(print_error) = error.print() {
                eprintln!("t4code: failed to print command-line help: {print_error}");
                return ExitCode::FAILURE;
            }
            if success {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("t4code: {error}");
            ExitCode::FAILURE
        }
    }
}
