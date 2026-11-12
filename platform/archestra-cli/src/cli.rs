//! The command line: `archestra <component> <action> [options]`, and
//! `archestra update` and `archestra uninstall` for the program as a whole.
//!
//! A new component is one more word next to `bridge`, with its own actions,
//! and a module in the library. A component has no uninstall of its own:
//! `archestra uninstall` removes the program with all its components.

use std::path::PathBuf;

use archestra_cli::bridge::start::StartArgs;

const MAIN_HELP: &str = "\
Usage: archestra <command> [options]

Connects this device to Archestra.

Commands:
  bridge <action>   The MCP bridge. It connects MCP servers on this device
                    to Archestra. Actions: start, stop, status,
                    enable-auto-start, disable-auto-start.
  update            Get the program that your Archestra serves now.
  uninstall         Remove Archestra from this device.

Options:
  -h, --help        Show this text.

Run `archestra <command> --help` for more.";

const BRIDGE_HELP: &str = "\
Usage: archestra bridge <action> [options]

The MCP bridge connects MCP servers on this device to Archestra.

Actions:
  start                Start the MCP bridge.
  stop                 Stop the MCP bridge.
  status               Show if the MCP bridge runs.
  enable-auto-start    Start the MCP bridge at each login.
  disable-auto-start   Do not start the MCP bridge at each login.

Options:
  -h, --help           Show this text.

Run `archestra bridge <action> --help` for more. To remove the MCP bridge
from this device, run `archestra uninstall`.";

const START_HELP: &str = "\
Usage: archestra bridge start [options]

Starts the MCP bridge. It connects MCP servers on this device to Archestra.

Options:
  --url <url>       The address of Archestra. Necessary for the first run only.
  --config <path>   The config file. Default: ~/.archestra/mcp-bridge/config.yaml
  --no-tray         Do not show the tray icon.
  --foreground      Run in this terminal, not in the background.
  --no-open         Print the approval URL; do not open the browser.
  --setup-code <code>
                    From the setup dialog in Archestra, which shows the
                    approval: no browser page opens.
  --background      Run in this process. The OS sets it.
  -h, --help        Show this text.

The program signs in, copies itself to ~/.archestra/bin/, and continues in
the background; the command in the terminal ends.
  macOS     launchd runs it; an icon in the menu bar.
  Windows   a process of its own; an icon in the notification area.
  Linux     a systemd user unit, or a process of its own with no systemd
            user session; no tray icon.

The first start on a device also puts the `archestra` command on your PATH
(for each new terminal) and turns auto-start on: the MCP bridge then starts
at each login. A later start does not change auto-start:
`archestra bridge enable-auto-start` and `archestra bridge disable-auto-start`
do.";

const STOP_HELP: &str = "\
Usage: archestra bridge stop

Stops the MCP bridge that runs in the background. Nothing else changes:
- With auto-start on, it starts again at the next login.
  `archestra bridge disable-auto-start` turns that off.
- The config file and the device key stay: `archestra bridge start` starts
  it again with no sign-in.

An MCP bridge that runs in a terminal (--foreground) is not in the
background: stop it there with Ctrl-C.

Options:
  -h, --help        Show this text.";

const STATUS_HELP: &str = "\
Usage: archestra bridge status

Shows what the MCP bridge on this device does now. It changes nothing.
- If it runs in the background.
- If auto-start is on.
- Which Archestra this device is linked to.
- The version of this program, and where its log file is.

Options:
  -h, --help        Show this text.";

const ENABLE_AUTO_START_HELP: &str = "\
Usage: archestra bridge enable-auto-start

Turns auto-start on: the MCP bridge starts at each login from now on. It does
not start the MCP bridge now: `archestra bridge start` does.

The device must be linked already (`archestra bridge start --url <url>`),
and the MCP bridge uses the default config file.
  macOS     a LaunchAgent in ~/Library/LaunchAgents.
  Windows   a value in the Run key of the user.
  Linux     the systemd user unit is enabled, or an XDG autostart entry with
            no systemd user session.

Options:
  -h, --help        Show this text.";

const DISABLE_AUTO_START_HELP: &str = "\
Usage: archestra bridge disable-auto-start

Turns auto-start off: the MCP bridge does not start at the next login. It
does not stop the MCP bridge now: `archestra bridge stop` does.
`archestra bridge enable-auto-start` turns auto-start on again.

Options:
  -h, --help        Show this text.";

const UPDATE_HELP: &str = "\
Usage: archestra update

Brings the program on this device to the one that your Archestra serves:
- Asks Archestra for the program for this system and CPU.
- Downloads it and checks its SHA-256. Nothing changes before that is right.
- Replaces the program in ~/.archestra/bin and starts the MCP bridge again.

With the same program on this device already, it does nothing.
On Windows the MCP bridge also does this by itself, when no tool call is
running and Archestra allows it. On macOS and Linux this command is the
update.

Options:
  -h, --help        Show this text.";

const UNINSTALL_HELP: &str = "\
Usage: archestra uninstall

Removes Archestra from this device:
- Stops the MCP bridge and turns its auto-start off.
- Asks Archestra to unlink this device.
- Deletes ~/.archestra/mcp-bridge (the config file with the device key, and
  the log files) and the program in ~/.archestra/bin.
- Takes the `archestra` command off your PATH.

MCP servers and other programs on this device are not touched. To link
this device again, run the command of the Device tab of Personal Settings
in Archestra.

Options:
  -h, --help        Show this text.";

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Invocation {
    Run(Command),
    Help(Help),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    BridgeStart(StartArgs),
    BridgeStop,
    BridgeStatus,
    BridgeEnableAutoStart,
    BridgeDisableAutoStart,
    Update,
    Uninstall,
}

/// The help text of the program, of a component, or of one command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Help {
    Main,
    Bridge,
    BridgeStart,
    BridgeStop,
    BridgeStatus,
    BridgeEnableAutoStart,
    BridgeDisableAutoStart,
    Update,
    Uninstall,
}

impl Help {
    pub fn text(self) -> &'static str {
        match self {
            Self::Main => MAIN_HELP,
            Self::Bridge => BRIDGE_HELP,
            Self::BridgeStart => START_HELP,
            Self::BridgeStop => STOP_HELP,
            Self::BridgeStatus => STATUS_HELP,
            Self::BridgeEnableAutoStart => ENABLE_AUTO_START_HELP,
            Self::BridgeDisableAutoStart => DISABLE_AUTO_START_HELP,
            Self::Update => UPDATE_HELP,
            Self::Uninstall => UNINSTALL_HELP,
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CliError {
    #[error("a command is necessary")]
    NoCommand,
    #[error("unknown command: {0}")]
    UnknownCommand(String),
    #[error("`archestra bridge` needs an action, for example `archestra bridge start`")]
    NoBridgeAction,
    #[error("unknown action of `archestra bridge`: {0}")]
    UnknownBridgeAction(String),
    #[error("{0} needs a value")]
    MissingValue(&'static str),
    #[error("unknown argument of `archestra {command}`: {argument}")]
    UnknownArgument { command: Help, argument: String },
}

impl CliError {
    /// The help text that goes with the error.
    pub fn help(&self) -> Help {
        match self {
            Self::NoCommand | Self::UnknownCommand(_) => Help::Main,
            Self::NoBridgeAction | Self::UnknownBridgeAction(_) => Help::Bridge,
            // Only `bridge start` has options with values.
            Self::MissingValue(_) => Help::BridgeStart,
            Self::UnknownArgument { command, .. } => *command,
        }
    }
}

/// The words of the command, for an error: `bridge start`.
impl std::fmt::Display for Help {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Main => "",
            Self::Bridge => BRIDGE,
            Self::BridgeStart => "bridge start",
            Self::BridgeStop => "bridge stop",
            Self::BridgeStatus => "bridge status",
            Self::BridgeEnableAutoStart => "bridge enable-auto-start",
            Self::BridgeDisableAutoStart => "bridge disable-auto-start",
            Self::Update => UPDATE,
            Self::Uninstall => UNINSTALL,
        })
    }
}

const BRIDGE: &str = "bridge";
const UPDATE: &str = "update";
const UNINSTALL: &str = "uninstall";

pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Invocation, CliError> {
    let mut arguments = arguments.into_iter();
    let command = arguments.next().ok_or(CliError::NoCommand)?;
    match command.as_str() {
        "-h" | "--help" => Ok(Invocation::Help(Help::Main)),
        BRIDGE => parse_bridge(arguments),
        UPDATE => no_more_arguments(Help::Update, Command::Update, arguments),
        UNINSTALL => no_more_arguments(Help::Uninstall, Command::Uninstall, arguments),
        _ => Err(CliError::UnknownCommand(command)),
    }
}

fn parse_bridge(mut arguments: impl Iterator<Item = String>) -> Result<Invocation, CliError> {
    let action = arguments.next().ok_or(CliError::NoBridgeAction)?;
    match action.as_str() {
        "-h" | "--help" => Ok(Invocation::Help(Help::Bridge)),
        "start" => parse_bridge_start(arguments),
        "stop" => no_more_arguments(Help::BridgeStop, Command::BridgeStop, arguments),
        "status" => no_more_arguments(Help::BridgeStatus, Command::BridgeStatus, arguments),
        "enable-auto-start" => no_more_arguments(
            Help::BridgeEnableAutoStart,
            Command::BridgeEnableAutoStart,
            arguments,
        ),
        "disable-auto-start" => no_more_arguments(
            Help::BridgeDisableAutoStart,
            Command::BridgeDisableAutoStart,
            arguments,
        ),
        _ => Err(CliError::UnknownBridgeAction(action)),
    }
}

fn parse_bridge_start(mut arguments: impl Iterator<Item = String>) -> Result<Invocation, CliError> {
    let mut args = StartArgs::default();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--url" => {
                args.url = Some(arguments.next().ok_or(CliError::MissingValue("--url"))?);
            }
            "--config" => {
                let path = arguments.next().ok_or(CliError::MissingValue("--config"))?;
                args.config = Some(PathBuf::from(path));
            }
            "--no-tray" => args.no_tray = true,
            "--foreground" => args.foreground = true,
            "--no-open" => args.no_open = true,
            "--setup-code" => {
                args.setup_code = Some(
                    arguments
                        .next()
                        .ok_or(CliError::MissingValue("--setup-code"))?,
                );
            }
            "--background" => args.background = true,
            "-h" | "--help" => return Ok(Invocation::Help(Help::BridgeStart)),
            _ => {
                return Err(CliError::UnknownArgument {
                    command: Help::BridgeStart,
                    argument,
                });
            }
        }
    }
    Ok(Invocation::Run(Command::BridgeStart(args)))
}

/// A command with no options. These commands stop, replace or remove things: any
/// argument that is not help is an error, never a run of the command. So
/// `archestra uninstall bridge` is an error, and not an uninstall of the
/// program.
fn no_more_arguments(
    help: Help,
    command: Command,
    mut arguments: impl Iterator<Item = String>,
) -> Result<Invocation, CliError> {
    match arguments.next() {
        None => Ok(Invocation::Run(command)),
        Some(argument) if argument == "-h" || argument == "--help" => Ok(Invocation::Help(help)),
        Some(argument) => Err(CliError::UnknownArgument {
            command: help,
            argument,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strs(arguments: &[&str]) -> Result<Invocation, CliError> {
        parse(arguments.iter().map(|argument| (*argument).to_owned()))
    }

    #[test]
    fn bridge_start_with_all_options() {
        assert_eq!(
            parse_strs(&[
                "bridge",
                "start",
                "--url",
                "https://archestra.example.com",
                "--config",
                "/tmp/c.yaml",
                "--no-tray",
                "--foreground",
                "--no-open",
                "--background",
                "--setup-code",
                "AbCdEfGhIjKlMnOpQrStUv",
            ]),
            Ok(Invocation::Run(Command::BridgeStart(StartArgs {
                url: Some("https://archestra.example.com".to_owned()),
                config: Some(PathBuf::from("/tmp/c.yaml")),
                no_tray: true,
                foreground: true,
                no_open: true,
                background: true,
                setup_code: Some("AbCdEfGhIjKlMnOpQrStUv".to_owned()),
            })))
        );
        assert_eq!(
            parse_strs(&["bridge", "start", "--setup-code"]),
            Err(CliError::MissingValue("--setup-code"))
        );
    }

    #[test]
    fn bridge_start_with_no_options_is_a_later_run() {
        assert_eq!(
            parse_strs(&["bridge", "start"]),
            Ok(Invocation::Run(Command::BridgeStart(StartArgs::default())))
        );
    }

    #[test]
    fn the_arguments_of_the_start_by_the_os_are_a_background_start() {
        // The LaunchAgent, the Run value and the systemd unit run
        // `archestra bridge start --config <path> --background`.
        assert_eq!(
            parse_strs(&["bridge", "start", "--config", "/c.yaml", "--background"]),
            Ok(Invocation::Run(Command::BridgeStart(StartArgs {
                config: Some(PathBuf::from("/c.yaml")),
                background: true,
                ..StartArgs::default()
            })))
        );
    }

    #[test]
    fn the_actions_of_the_bridge_with_no_options() {
        assert_eq!(
            parse_strs(&["bridge", "stop"]),
            Ok(Invocation::Run(Command::BridgeStop))
        );
        assert_eq!(
            parse_strs(&["bridge", "status"]),
            Ok(Invocation::Run(Command::BridgeStatus))
        );
        assert_eq!(
            parse_strs(&["bridge", "enable-auto-start"]),
            Ok(Invocation::Run(Command::BridgeEnableAutoStart))
        );
        assert_eq!(
            parse_strs(&["bridge", "disable-auto-start"]),
            Ok(Invocation::Run(Command::BridgeDisableAutoStart))
        );
    }

    #[test]
    fn uninstall_is_for_the_program_and_takes_no_component() {
        assert_eq!(
            parse_strs(&["uninstall"]),
            Ok(Invocation::Run(Command::Uninstall))
        );
        // Not an uninstall of the program, and there is no uninstall of the
        // MCP bridge alone, in either order of the words.
        let error = parse_strs(&["uninstall", "bridge"]).expect_err("no component");
        assert_eq!(
            error,
            CliError::UnknownArgument {
                command: Help::Uninstall,
                argument: "bridge".to_owned()
            }
        );
        assert_eq!(
            error.to_string(),
            "unknown argument of `archestra uninstall`: bridge"
        );
        assert_eq!(error.help(), Help::Uninstall);
        assert_eq!(
            parse_strs(&["bridge", "uninstall"]),
            Err(CliError::UnknownBridgeAction("uninstall".to_owned()))
        );
    }

    #[test]
    fn update_is_for_the_program_and_takes_no_arguments() {
        assert_eq!(
            parse_strs(&["update"]),
            Ok(Invocation::Run(Command::Update))
        );
        assert_eq!(
            parse_strs(&["update", "--help"]),
            Ok(Invocation::Help(Help::Update))
        );
        let error = parse_strs(&["update", "bridge"]).expect_err("no component");
        assert_eq!(
            error.to_string(),
            "unknown argument of `archestra update`: bridge"
        );
        assert_eq!(error.help(), Help::Update);
    }

    #[test]
    fn the_old_order_of_the_words_is_an_error() {
        assert_eq!(
            parse_strs(&["start", "bridge"]),
            Err(CliError::UnknownCommand("start".to_owned()))
        );
        assert_eq!(
            parse_strs(&["bridge", "enable"]),
            Err(CliError::UnknownBridgeAction("enable".to_owned()))
        );
    }

    #[test]
    fn help_forms_never_run_a_command() {
        assert_eq!(parse_strs(&["--help"]), Ok(Invocation::Help(Help::Main)));
        assert_eq!(parse_strs(&["-h"]), Ok(Invocation::Help(Help::Main)));
        assert_eq!(
            parse_strs(&["bridge", "--help"]),
            Ok(Invocation::Help(Help::Bridge))
        );
        assert_eq!(
            parse_strs(&["bridge", "start", "--help"]),
            Ok(Invocation::Help(Help::BridgeStart))
        );
        assert_eq!(
            parse_strs(&["bridge", "start", "--url", "https://a.example.com", "-h"]),
            Ok(Invocation::Help(Help::BridgeStart))
        );
        for (action, help) in [
            ("stop", Help::BridgeStop),
            ("status", Help::BridgeStatus),
            ("enable-auto-start", Help::BridgeEnableAutoStart),
            ("disable-auto-start", Help::BridgeDisableAutoStart),
        ] {
            assert_eq!(
                parse_strs(&["bridge", action, "--help"]),
                Ok(Invocation::Help(help))
            );
            assert_eq!(
                parse_strs(&["bridge", action, "-h"]),
                Ok(Invocation::Help(help))
            );
        }
        assert_eq!(
            parse_strs(&["uninstall", "--help"]),
            Ok(Invocation::Help(Help::Uninstall))
        );
        assert_eq!(
            parse_strs(&["uninstall", "-h"]),
            Ok(Invocation::Help(Help::Uninstall))
        );
    }

    #[test]
    fn no_arguments_is_an_error_with_the_main_help() {
        let error = parse_strs(&[]).expect_err("no command");
        assert_eq!(error, CliError::NoCommand);
        assert_eq!(error.help(), Help::Main);
    }

    #[test]
    fn unknown_command_and_action() {
        let error = parse_strs(&["agents", "start"]).expect_err("unknown command");
        assert_eq!(error, CliError::UnknownCommand("agents".to_owned()));
        assert_eq!(error.help(), Help::Main);
        let error = parse_strs(&["bridge", "restart"]).expect_err("unknown action");
        assert_eq!(error, CliError::UnknownBridgeAction("restart".to_owned()));
        assert_eq!(error.help(), Help::Bridge);
        let error = parse_strs(&["bridge"]).expect_err("no action");
        assert_eq!(error, CliError::NoBridgeAction);
        assert_eq!(error.help(), Help::Bridge);
    }

    #[test]
    fn missing_values_and_unknown_arguments() {
        assert_eq!(
            parse_strs(&["bridge", "start", "--url"]),
            Err(CliError::MissingValue("--url"))
        );
        assert_eq!(
            parse_strs(&["bridge", "start", "--config"]),
            Err(CliError::MissingValue("--config"))
        );
        let error = parse_strs(&["bridge", "start", "--verbose"]).expect_err("unknown");
        assert_eq!(
            error.to_string(),
            "unknown argument of `archestra bridge start`: --verbose"
        );
        assert_eq!(error.help(), Help::BridgeStart);
        // An extra argument to stop is an error, not a stop.
        let error = parse_strs(&["bridge", "stop", "--force"]).expect_err("not a stop");
        assert_eq!(
            error,
            CliError::UnknownArgument {
                command: Help::BridgeStop,
                argument: "--force".to_owned()
            }
        );
        assert_eq!(error.help(), Help::BridgeStop);
        // The same for uninstall: it never runs with an argument it does
        // not know.
        let error = parse_strs(&["uninstall", "--yes"]).expect_err("not an uninstall");
        assert_eq!(error.help(), Help::Uninstall);
    }

    #[test]
    fn help_texts_name_the_commands() {
        for word in [
            "bridge <action>",
            "start",
            "stop",
            "enable-auto-start",
            "disable-auto-start",
            "update",
            "uninstall",
        ] {
            assert!(MAIN_HELP.contains(word), "{word}");
        }
        assert!(UPDATE_HELP.starts_with("Usage: archestra update\n"));
        assert!(BRIDGE_HELP.starts_with("Usage: archestra bridge <action>"));
        assert!(START_HELP.starts_with("Usage: archestra bridge start"));
        assert!(STOP_HELP.starts_with("Usage: archestra bridge stop"));
        assert!(ENABLE_AUTO_START_HELP.starts_with("Usage: archestra bridge enable-auto-start"));
        assert!(DISABLE_AUTO_START_HELP.starts_with("Usage: archestra bridge disable-auto-start"));
        assert!(UNINSTALL_HELP.starts_with("Usage: archestra uninstall\n"));
    }
}
