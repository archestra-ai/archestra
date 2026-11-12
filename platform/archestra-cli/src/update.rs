//! `archestra update`: brings the program on this computer to the one that
//! its Archestra serves.
//!
//! 1. It asks Archestra which program it serves for this computer.
//! 2. When the installed program has another SHA-256, it downloads the new
//!    one and checks its SHA-256. Nothing is touched before that is right.
//! 3. The new program installs itself: it copies itself to
//!    `~/.archestra/bin/` and starts the MCP bridge again.
//!
//! The MCP bridge does the same by itself on Windows
//! ([`crate::bridge::update`]); on macOS and Linux this command is the
//! update.

use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

use crate::bridge::config::{Config, ConfigError};
use crate::bridge::update::{self, UpdateError};
use crate::bridge::{self, Update};
use crate::{layout, program};

#[derive(Debug, thiserror::Error)]
pub enum UpdateCommandError {
    #[error("cannot find the home folder")]
    NoHome,
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(
        "this device is not linked to Archestra (no config file {path}); run the command of the Device tab of Personal Settings in Archestra"
    )]
    NotSetUp { path: PathBuf },
    #[error("cannot start the runtime: {0}")]
    Runtime(#[source] io::Error),
    #[error("cannot ask Archestra for its program: {0}")]
    Ask(#[source] bridge::ServedProgramError),
    #[error(transparent)]
    Update(#[from] UpdateError),
    #[error("cannot start the downloaded program {path}: {source}")]
    Start { path: PathBuf, source: io::Error },
    #[error(
        "the downloaded program did not install itself ({0}); the program on this device did not change"
    )]
    Install(std::process::ExitStatus),
}

/// Runs `archestra update`. A program that is up to date is a success.
pub fn run() -> Result<ExitCode, UpdateCommandError> {
    let home = std::env::home_dir().ok_or(UpdateCommandError::NoHome)?;
    let config_path = layout::bridge_config_path(&home);
    let config = Config::load(&config_path)?.ok_or_else(|| UpdateCommandError::NotSetUp {
        path: config_path.clone(),
    })?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(UpdateCommandError::Runtime)?;

    let served = runtime
        .block_on(bridge::served_program(&config.control_plane))
        .map_err(UpdateCommandError::Ask)?;
    // The program in `~/.archestra/bin/` is the one that the MCP bridge
    // runs, also when this command runs from another copy.
    let installed = program::file_sha256(&layout::program_path(&home)).ok();
    let Some(update) = update::update_of(served, installed.as_deref()) else {
        println!("{}", up_to_date_message(installed.is_some()));
        return Ok(ExitCode::SUCCESS);
    };

    println!("{}", downloading_message(&update));
    let downloaded = runtime.block_on(async {
        let http = bridge::http_client().map_err(UpdateError::Download)?;
        update::download_verified(&http, &config.control_plane.base_url, &update.sha256, &home)
            .await
    })?;
    let status = Command::new(&downloaded)
        .args(update::install_arguments(&config_path))
        .status()
        .map_err(|source| UpdateCommandError::Start {
            path: downloaded.clone(),
            source,
        })?;
    update::remove_downloaded_program(&home);
    if !status.success() {
        return Err(UpdateCommandError::Install(status));
    }
    println!("{}", updated_message(&update));
    Ok(ExitCode::SUCCESS)
}

fn up_to_date_message(installed: bool) -> &'static str {
    if installed {
        "The program on this device is the one that Archestra serves: nothing to update."
    } else {
        "Archestra serves no program for this device, or the program is not in ~/.archestra/bin: nothing to update."
    }
}

fn downloading_message(update: &Update) -> String {
    match &update.version {
        Some(version) => format!("Downloading version {version} from Archestra..."),
        None => "Downloading the program from Archestra...".to_owned(),
    }
}

fn updated_message(update: &Update) -> String {
    match &update.version {
        Some(version) => format!("Updated the program to version {version}."),
        None => "Updated the program.".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_name_the_version_when_archestra_knows_it() {
        let update = |version: Option<&str>| Update {
            version: version.map(str::to_owned),
            sha256: "aa".to_owned(),
            auto: true,
        };
        assert_eq!(
            downloading_message(&update(Some("0.2.0"))),
            "Downloading version 0.2.0 from Archestra..."
        );
        assert_eq!(
            updated_message(&update(Some("0.2.0"))),
            "Updated the program to version 0.2.0."
        );
        assert_eq!(updated_message(&update(None)), "Updated the program.");
        assert!(up_to_date_message(true).contains("nothing to update"));
    }
}
