//! `archestra`: the command line of the Archestra program for a user's
//! computer. The actions of the MCP bridge (`archestra bridge start`, `stop`,
//! `enable-auto-start`, `disable-auto-start`), `archestra update` and
//! `archestra uninstall`.

mod cli;

use std::process::ExitCode;

use archestra_cli::{bridge, uninstall, update};
use cli::{Command, Invocation};
use tracing::error;

fn main() -> ExitCode {
    let command = match cli::parse(std::env::args().skip(1)) {
        Ok(Invocation::Run(command)) => command,
        Ok(Invocation::Help(help)) => {
            println!("{}", help.text());
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("{error}\n\n{}", error.help().text());
            return ExitCode::from(2);
        }
    };

    // The MCP bridge in the background writes to its log file. launchd sends
    // the output there on macOS; on Windows and Linux the program does it.
    #[cfg(any(target_os = "linux", windows))]
    let log_file = match &command {
        Command::BridgeStart(args) if args.background => {
            bridge::start::write_output_to_log_file().err()
        }
        _ => None,
    };
    // In a terminal the user reads plain sentences: only warnings and errors
    // show there, without a time or a module. The log file of the MCP bridge
    // in the background keeps everything from info up. RUST_LOG overrides.
    let background = matches!(&command, Command::BridgeStart(args) if args.background);
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new(if background { "info" } else { "warn" })
    });
    if background {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .without_time()
            .with_target(false)
            .init();
    }
    #[cfg(any(target_os = "linux", windows))]
    if let Some(error) = log_file {
        tracing::warn!(%error, "cannot write to the log file");
    }

    match command {
        Command::BridgeStart(args) => bridge::start::run(args).unwrap_or_else(|error| {
            error!(%error, "the MCP bridge cannot start");
            ExitCode::FAILURE
        }),
        Command::BridgeStop => or_report(bridge::stop::run()),
        Command::BridgeStatus => or_report(bridge::status::run()),
        Command::BridgeEnableAutoStart => or_report(bridge::at_login::enable()),
        Command::BridgeDisableAutoStart => or_report(bridge::at_login::disable()),
        Command::Update => or_report(update::run()),
        Command::Uninstall => or_report(uninstall::run()),
    }
}

/// The exit code of a command that writes for the user, not to a log.
fn or_report<E: std::fmt::Display>(result: Result<ExitCode, E>) -> ExitCode {
    result.unwrap_or_else(|error| {
        eprintln!("archestra: {error}");
        ExitCode::FAILURE
    })
}
