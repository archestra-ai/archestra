//! The config file on the device: the sign-in of the device and a copy of
//! the config in Archestra. A sync writes the MCP entries; the user does not
//! edit the file.
//!
//! The keys are those of the OpenAI tunnel-client profile, plus `name`,
//! `arguments`, `enabled` and `synced_at`. A key that the tunnel client does
//! not know is ignored.

use std::fs;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::bridge::command_line;
use crate::bridge::control_plane::CatalogItem;
use crate::bridge::files;
use crate::bridge::template::Variables;
use crate::bridge::timestamp;

/// The file holds the device key: only the user can read it. On Windows the
/// file is in the profile folder of the user, which only that user (and the
/// administrators) can read; no mode is set there.
#[cfg(unix)]
const CONFIG_FILE_MODE: u32 = 0o600;

const HEADER: &str = "\
# Archestra MCP bridge.
# The tunnel client writes this file. Do not edit it: each sync with Archestra
# overwrites your changes.
# - `control_plane` is the sign-in of this device.
# - `synced_at` is the time of the last sync that changed `mcp`.
# - `mcp` is a copy of the config in Archestra: one entry for each desktop MCP
#   server that you installed.
# To change a command or a URL, change the catalog item in Archestra.
# `arguments` are what you added to a command when you connected the MCP
# server. To change them, edit the arguments of the MCP server in Archestra.
";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read the config file {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("the config file {path} is not valid YAML for the tunnel client: {message}")]
    Parse { path: PathBuf, message: String },
    #[error("the config file {path} has no valid control_plane.{field}")]
    InvalidField { path: PathBuf, field: &'static str },
    #[error("cannot write the config file {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("cannot write the config as YAML: {message}")]
    Serialize { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub control_plane: ControlPlaneConfig,
    /// The time of the last sync from Archestra that changed `mcp`, or of
    /// the first sync, as RFC 3339 in UTC. A sync that finds `mcp` up to
    /// date does not write the file, so it does not change this time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<String>,
    #[serde(default)]
    pub mcp: McpConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlPlaneConfig {
    pub base_url: String,
    pub tunnel_id: String,
    /// The device key.
    pub api_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default)]
    pub commands: Vec<CommandEntry>,
    #[serde(default)]
    pub server_urls: Vec<ServerUrlEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEntry {
    pub channel: String,
    #[serde(default)]
    pub name: String,
    /// As Archestra sent it: the variables are not replaced.
    #[serde(default)]
    pub command: String,
    /// What the user added to the command in Archestra, as Archestra sent
    /// them. They go after the arguments of the command, each as one
    /// argument: they are not split. An entry with none has no such key, as
    /// a file from before the arguments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    /// `false`: the MCP server is stopped in Archestra.
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerUrlEntry {
    pub channel: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
    pub enabled: bool,
}

/// One channel of the config file, with what the tunnel client does for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChannelEntry {
    pub channel: String,
    pub name: String,
    pub target: ChannelTarget,
}

/// What the tunnel client does for one channel of the config file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChannelTarget {
    /// Start this program and talk to it over stdio.
    Stdio { argv: Vec<String> },
    /// Connect to this streamable HTTP MCP server.
    Http { url: String },
    /// No command and no URL: nothing is started.
    NotConfigured,
    /// The MCP server is stopped in Archestra: nothing is started.
    Disabled,
    /// The entry has an error: nothing is started.
    Rejected(RejectReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RejectReason {
    #[error("the channel has more than one entry")]
    MoreThanOneEntry,
    #[error("the command has a quote that is not closed")]
    InvalidCommand,
    #[error("the url is not an http:// or https:// URL")]
    InvalidUrl,
}

impl Config {
    pub fn new(control_plane: ControlPlaneConfig) -> Self {
        Self {
            control_plane,
            synced_at: None,
            mcp: McpConfig::default(),
        }
    }

    /// The config of a sync: one entry for each catalog item that Archestra
    /// lists, and no other entry. An item with a URL goes to `server_urls`;
    /// each other item goes to `commands`. Only a command has arguments.
    pub fn from_catalog_items(
        control_plane: ControlPlaneConfig,
        items: &[CatalogItem],
        synced_at: SystemTime,
    ) -> Self {
        let mut mcp = McpConfig::default();
        for item in items {
            let url = item.url.as_deref().filter(|url| !url.trim().is_empty());
            match url {
                Some(url) => mcp.server_urls.push(ServerUrlEntry {
                    channel: item.id.clone(),
                    name: item.name.clone(),
                    url: url.to_owned(),
                    enabled: item.enabled,
                }),
                None => mcp.commands.push(CommandEntry {
                    channel: item.id.clone(),
                    name: item.name.clone(),
                    command: item.command.clone().unwrap_or_default(),
                    arguments: item.arguments.clone(),
                    enabled: item.enabled,
                }),
            }
        }
        Self {
            control_plane,
            synced_at: Some(timestamp::format(synced_at)),
            mcp,
        }
    }

    /// The time in `synced_at`: the last sync that wrote the file. `None`:
    /// no sync yet, or `synced_at` is not a time.
    pub fn last_sync(&self) -> Option<SystemTime> {
        self.synced_at.as_deref().and_then(timestamp::parse)
    }

    /// Reads the file. `Ok(None)` when it does not exist.
    pub fn load(path: &Path) -> Result<Option<Self>, ConfigError> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(ConfigError::Read {
                    path: path.to_owned(),
                    source,
                });
            }
        };
        let mut config: Self =
            serde_saphyr::from_str(&text).map_err(|error| ConfigError::Parse {
                path: path.to_owned(),
                message: error.to_string(),
            })?;
        config.control_plane.validate(path)?;
        config.control_plane.base_url = normalize_base_url(&config.control_plane.base_url);
        Ok(Some(config))
    }

    /// Writes the file with mode `0600`. The file is replaced in one step, so
    /// a reader never sees half of it.
    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        let yaml = serde_saphyr::to_string(self).map_err(|error| ConfigError::Serialize {
            message: error.to_string(),
        })?;
        files::replace_file(path, |temporary| {
            write_private_file(temporary, &format!("{HEADER}{yaml}"))
        })
        .map_err(|source| ConfigError::Write {
            path: path.to_owned(),
            source,
        })
    }
}

impl ControlPlaneConfig {
    fn validate(&self, path: &Path) -> Result<(), ConfigError> {
        let invalid = |field| ConfigError::InvalidField {
            path: path.to_owned(),
            field,
        };
        if !is_http_url(&self.base_url) {
            return Err(invalid("base_url"));
        }
        if !is_valid_tunnel_id(&self.tunnel_id) {
            return Err(invalid("tunnel_id"));
        }
        // The key goes into an HTTP header.
        if self.api_key.is_empty() || !self.api_key.chars().all(|c| c.is_ascii_graphic()) {
            return Err(invalid("api_key"));
        }
        Ok(())
    }
}

impl McpConfig {
    /// One entry for each channel in the file, in the order of the file. A
    /// channel with more than one entry (for example, one in each list) is
    /// rejected: the other channels are not affected.
    pub(crate) fn channel_entries(&self, variables: &Variables) -> Vec<ChannelEntry> {
        let commands = self.commands.iter().map(|entry| ChannelEntry {
            channel: entry.channel.clone(),
            name: entry.name.clone(),
            target: if entry.enabled {
                command_target(&entry.command, &entry.arguments, variables)
            } else {
                ChannelTarget::Disabled
            },
        });
        let server_urls = self.server_urls.iter().map(|entry| ChannelEntry {
            channel: entry.channel.clone(),
            name: entry.name.clone(),
            target: if entry.enabled {
                url_target(&entry.url)
            } else {
                ChannelTarget::Disabled
            },
        });

        let mut entries: Vec<ChannelEntry> = Vec::new();
        for entry in commands.chain(server_urls) {
            if entry.channel.is_empty() {
                continue;
            }
            let existing = entries
                .iter_mut()
                .find(|existing| existing.channel == entry.channel);
            match existing {
                Some(existing) => {
                    existing.target = ChannelTarget::Rejected(RejectReason::MoreThanOneEntry);
                }
                None => entries.push(entry),
            }
        }
        entries
    }
}

/// Splits a command line as a shell does (quotes, backslash), with no shell:
/// no `~`, no pipes. The program is started directly. The variables of
/// [`Variables`] are replaced in each argument after the split, so a value
/// with a space stays in one argument.
///
/// `arguments` are what the user added to the command. They go after the
/// arguments of the command, each as one argument: they are not split, so a
/// space, a quote or a backslash in one is a part of it on every system. The
/// variables are replaced in them too. With no command there is no program
/// to give them to: nothing is started.
pub(crate) fn command_target(
    command: &str,
    arguments: &[String],
    variables: &Variables,
) -> ChannelTarget {
    match command_line::split(command) {
        None => ChannelTarget::Rejected(RejectReason::InvalidCommand),
        Some(argv) if argv.is_empty() => ChannelTarget::NotConfigured,
        Some(argv) => ChannelTarget::Stdio {
            argv: argv
                .iter()
                .chain(arguments)
                .map(|argument| variables.expand(argument))
                .collect(),
        },
    }
}

fn url_target(url: &str) -> ChannelTarget {
    let url = url.trim();
    if url.is_empty() {
        ChannelTarget::NotConfigured
    } else if is_http_url(url) {
        ChannelTarget::Http {
            url: url.to_owned(),
        }
    } else {
        ChannelTarget::Rejected(RejectReason::InvalidUrl)
    }
}

/// The modification time of the file (and its size, for file systems with a
/// coarse clock), to see when a sync wrote it. `None`: no file.
pub(crate) fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

/// `https://host/` and `https://host` are the same Archestra.
pub fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_owned()
}

/// `true` for an absolute `http://` or `https://` URL with a host.
pub fn is_http_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

/// The id goes into a URL path. The form is `tunnel_` + letters and digits.
pub fn is_valid_tunnel_id(tunnel_id: &str) -> bool {
    tunnel_id.strip_prefix("tunnel_").is_some_and(|rest| {
        !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn write_private_file(path: &Path, text: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(CONFIG_FILE_MODE);
    let mut file = options.open(path)?;
    // `mode` has no effect on a file that was there already.
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(CONFIG_FILE_MODE))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    /// A config file with no sync yet. The top level and one entry have a
    /// key that the tunnel client does not know.
    const SAMPLE: &str = r#"
control_plane:
  base_url: https://archestra.example.com/
  tunnel_id: tunnel_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b
  api_key: archestra_dev_abc
not_a_key_of_the_client: 1
mcp:
  commands:
    - channel: 7c1e
      name: MATLAB
      command: "/usr/local/bin/matlab-mcp-server --flag 'two words'"
      enabled: true
      not_a_key_of_the_client: [a, b]
    - channel: 3f02
      name: eda-agent
      command: ""
      enabled: true
  server_urls:
    - channel: 91bd
      name: Notes
      url: http://127.0.0.1:8080/mcp
      enabled: true
"#;

    fn sample() -> Config {
        serde_saphyr::from_str(SAMPLE).expect("the sample parses")
    }

    fn variables() -> Variables {
        Variables {
            user: Some("anna".to_owned()),
            home: Some("/Users/anna maria".to_owned()),
        }
    }

    fn item(id: &str, name: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_owned(),
            name: name.to_owned(),
            command: None,
            arguments: Vec::new(),
            url: None,
            enabled: true,
        }
    }

    fn control_plane() -> ControlPlaneConfig {
        ControlPlaneConfig {
            base_url: "https://archestra.example.com".to_owned(),
            tunnel_id: "tunnel_ab".to_owned(),
            api_key: "archestra_dev_abc".to_owned(),
        }
    }

    fn synced(items: &[CatalogItem]) -> Config {
        let synced_at = UNIX_EPOCH + Duration::from_secs(1_794_312_000);
        Config::from_catalog_items(control_plane(), items, synced_at)
    }

    #[test]
    fn a_file_with_keys_that_the_client_does_not_know_loads() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.yaml");
        fs::write(&path, SAMPLE).expect("write");
        let config = Config::load(&path).expect("load").expect("the file exists");
        assert_eq!(config.control_plane.api_key, "archestra_dev_abc");
        assert_eq!(config.synced_at, None);
        assert_eq!(config.last_sync(), None);
        assert_eq!(
            config.mcp.commands,
            vec![
                CommandEntry {
                    channel: "7c1e".to_owned(),
                    name: "MATLAB".to_owned(),
                    command: "/usr/local/bin/matlab-mcp-server --flag 'two words'".to_owned(),
                    arguments: Vec::new(),
                    enabled: true,
                },
                CommandEntry {
                    channel: "3f02".to_owned(),
                    name: "eda-agent".to_owned(),
                    command: String::new(),
                    arguments: Vec::new(),
                    enabled: true,
                },
            ]
        );
        assert_eq!(
            config.mcp.server_urls,
            vec![ServerUrlEntry {
                channel: "91bd".to_owned(),
                name: "Notes".to_owned(),
                url: "http://127.0.0.1:8080/mcp".to_owned(),
                enabled: true,
            }]
        );
    }

    #[test]
    fn an_entry_with_no_enabled_is_not_valid() {
        let parsed: Result<Config, _> = serde_saphyr::from_str(
            "control_plane:\n  base_url: http://localhost:9000\n  tunnel_id: tunnel_ab\n  api_key: k\nmcp:\n  commands:\n    - channel: main\n      command: server\n",
        );
        assert!(parsed.is_err());
    }

    #[test]
    fn parses_a_file_with_no_mcp_section_and_no_names() {
        let config: Config = serde_saphyr::from_str(
            "control_plane:\n  base_url: http://localhost:9000\n  tunnel_id: tunnel_ab\n  api_key: k\n",
        )
        .expect("parses");
        assert_eq!(config.mcp, McpConfig::default());

        let config: Config = serde_saphyr::from_str(
            "control_plane:\n  base_url: http://localhost:9000\n  tunnel_id: tunnel_ab\n  api_key: k\nmcp:\n  commands:\n    - channel: main\n      command: server\n      enabled: false\n",
        )
        .expect("parses");
        assert_eq!(config.mcp.commands[0].name, "");
    }

    #[test]
    fn a_sync_makes_one_entry_for_each_catalog_item() {
        let config = synced(&[
            CatalogItem {
                command: Some("/Users/$USER/bins/peekaboo mcp serve".to_owned()),
                ..item("7c1e", "peekaboo")
            },
            CatalogItem {
                url: Some("http://127.0.0.1:8080/mcp".to_owned()),
                enabled: false,
                ..item("91bd", "Notes")
            },
            item("3f02", "eda-agent"),
            // An empty URL is no URL.
            CatalogItem {
                url: Some(" ".to_owned()),
                command: Some("server".to_owned()),
                ..item("aa11", "both")
            },
        ]);
        assert_eq!(config.control_plane, control_plane());
        assert_eq!(config.synced_at.as_deref(), Some("2026-11-10T12:00:00Z"));
        assert_eq!(
            config.last_sync(),
            Some(UNIX_EPOCH + Duration::from_secs(1_794_312_000))
        );
        assert_eq!(
            config.mcp.commands,
            vec![
                // The command is stored as Archestra sent it.
                CommandEntry {
                    channel: "7c1e".to_owned(),
                    name: "peekaboo".to_owned(),
                    command: "/Users/$USER/bins/peekaboo mcp serve".to_owned(),
                    arguments: Vec::new(),
                    enabled: true,
                },
                CommandEntry {
                    channel: "3f02".to_owned(),
                    name: "eda-agent".to_owned(),
                    command: String::new(),
                    arguments: Vec::new(),
                    enabled: true,
                },
                CommandEntry {
                    channel: "aa11".to_owned(),
                    name: "both".to_owned(),
                    command: "server".to_owned(),
                    arguments: Vec::new(),
                    enabled: true,
                },
            ]
        );
        assert_eq!(
            config.mcp.server_urls,
            vec![ServerUrlEntry {
                channel: "91bd".to_owned(),
                name: "Notes".to_owned(),
                url: "http://127.0.0.1:8080/mcp".to_owned(),
                enabled: false,
            }]
        );
    }

    #[test]
    fn save_and_load_round_trip_with_mode_0600() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested").join("config.yaml");
        let config = synced(&[
            CatalogItem {
                command: Some("/Users/$USER/bins/peekaboo \"mcp serve\"".to_owned()),
                enabled: false,
                ..item("7c1e", "peekaboo: the 'best'")
            },
            CatalogItem {
                url: Some("http://127.0.0.1:8080/mcp".to_owned()),
                ..item("91bd", "Notes")
            },
        ]);
        config.save(&path).expect("save");

        #[cfg(unix)]
        {
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        let text = fs::read_to_string(&path).expect("read");
        assert!(text.starts_with("# Archestra MCP bridge.\n# The tunnel client writes this file."));
        let loaded = Config::load(&path).expect("load").expect("the file exists");
        assert_eq!(loaded, config);

        let leftovers: Vec<_> = fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(leftovers, vec!["config.yaml"]);
    }

    #[test]
    fn load_removes_the_slash_at_the_end_of_the_url() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.yaml");
        fs::write(&path, SAMPLE).expect("write");
        let loaded = Config::load(&path).expect("load").expect("the file exists");
        assert_eq!(
            loaded.control_plane.base_url,
            "https://archestra.example.com"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_makes_an_open_file_private() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.yaml");
        fs::write(&path, "old").expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");

        sample().save(&path).expect("save");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn load_gives_none_for_no_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(
            Config::load(&dir.path().join("config.yaml"))
                .expect("load")
                .is_none()
        );
    }

    #[test]
    fn load_rejects_a_bad_control_plane() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.yaml");
        for (field, text) in [
            (
                "base_url",
                "control_plane:\n  base_url: archestra\n  tunnel_id: tunnel_ab\n  api_key: k\n",
            ),
            (
                "tunnel_id",
                "control_plane:\n  base_url: http://a.example\n  tunnel_id: ../x\n  api_key: k\n",
            ),
            (
                "api_key",
                "control_plane:\n  base_url: http://a.example\n  tunnel_id: tunnel_ab\n  api_key: \"a b\"\n",
            ),
        ] {
            fs::write(&path, text).expect("write");
            match Config::load(&path) {
                Err(ConfigError::InvalidField { field: found, .. }) => assert_eq!(found, field),
                other => panic!("{field}: {other:?}"),
            }
        }

        fs::write(&path, "control_plane: [").expect("write");
        assert!(matches!(
            Config::load(&path),
            Err(ConfigError::Parse { .. })
        ));
    }

    #[test]
    fn splits_a_command_as_a_shell_does() {
        assert_eq!(
            command_target(
                "/usr/local/bin/matlab-mcp-server --flag 'two words' \"a b\"",
                &[],
                &variables()
            ),
            ChannelTarget::Stdio {
                argv: vec![
                    "/usr/local/bin/matlab-mcp-server".to_owned(),
                    "--flag".to_owned(),
                    "two words".to_owned(),
                    "a b".to_owned(),
                ]
            }
        );
        // A backslash escapes on macOS and Linux; on Windows it is a part of
        // the path.
        let expected = if cfg!(windows) {
            vec![
                r"C:\bin\mcp.exe".to_owned(),
                "c\\".to_owned(),
                "d".to_owned(),
            ]
        } else {
            vec!["C:binmcp.exe".to_owned(), "c d".to_owned()]
        };
        assert_eq!(
            command_target(r"C:\bin\mcp.exe c\ d", &[], &variables()),
            ChannelTarget::Stdio { argv: expected }
        );
        // No shell: these stay as they are.
        assert_eq!(
            command_target("server $PATH ~ | cat", &[], &variables()),
            ChannelTarget::Stdio {
                argv: vec![
                    "server".to_owned(),
                    "$PATH".to_owned(),
                    "~".to_owned(),
                    "|".to_owned(),
                    "cat".to_owned(),
                ]
            }
        );
    }

    #[test]
    fn variables_are_replaced_after_the_split() {
        // The home folder has a space: it stays in one argument.
        assert_eq!(
            command_target(
                "$HOME/bins/peekaboo --user ${USER} --root=$HOME",
                &[],
                &variables()
            ),
            ChannelTarget::Stdio {
                argv: vec![
                    "/Users/anna maria/bins/peekaboo".to_owned(),
                    "--user".to_owned(),
                    "anna".to_owned(),
                    "--root=/Users/anna maria".to_owned(),
                ]
            }
        );
    }

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn the_arguments_of_the_user_go_after_those_of_the_command_and_are_not_split() {
        assert_eq!(
            command_target(
                "/opt/matlab/mcp serve --flag 'two words'",
                &arguments(&[
                    "--root",
                    "/data/My Models",
                    r#"a "quote" and a \ backslash"#,
                    "'kept'",
                    "",
                ]),
                &variables()
            ),
            ChannelTarget::Stdio {
                argv: vec![
                    "/opt/matlab/mcp".to_owned(),
                    "serve".to_owned(),
                    "--flag".to_owned(),
                    "two words".to_owned(),
                    "--root".to_owned(),
                    "/data/My Models".to_owned(),
                    r#"a "quote" and a \ backslash"#.to_owned(),
                    "'kept'".to_owned(),
                    String::new(),
                ]
            }
        );
    }

    #[test]
    fn variables_are_replaced_in_the_arguments_of_the_user() {
        assert_eq!(
            command_target(
                "server",
                &arguments(&["--root=$HOME/models", "${USER}", "%USERNAME%", "$PATH"]),
                &variables()
            ),
            ChannelTarget::Stdio {
                argv: vec![
                    "server".to_owned(),
                    "--root=/Users/anna maria/models".to_owned(),
                    "anna".to_owned(),
                    "anna".to_owned(),
                    "$PATH".to_owned(),
                ]
            }
        );
    }

    #[test]
    fn arguments_with_no_command_start_nothing() {
        // The first argument of the user must not become the program.
        assert_eq!(
            command_target("  ", &arguments(&["/bin/sh", "-c"]), &variables()),
            ChannelTarget::NotConfigured
        );
        assert_eq!(
            command_target("server 'open", &arguments(&["--verbose"]), &variables()),
            ChannelTarget::Rejected(RejectReason::InvalidCommand)
        );
    }

    #[test]
    fn a_sync_stores_the_arguments_of_a_command_and_none_for_a_url() {
        let config = synced(&[
            CatalogItem {
                command: Some("/opt/matlab/mcp serve".to_owned()),
                arguments: arguments(&["--root", "$HOME/My Models"]),
                ..item("7c1e", "MATLAB")
            },
            // Archestra sends none for a URL; if it did, they are dropped.
            CatalogItem {
                url: Some("http://127.0.0.1:8080/mcp".to_owned()),
                arguments: arguments(&["--verbose"]),
                ..item("91bd", "Notes")
            },
        ]);
        assert_eq!(
            config.mcp.commands,
            vec![CommandEntry {
                channel: "7c1e".to_owned(),
                name: "MATLAB".to_owned(),
                command: "/opt/matlab/mcp serve".to_owned(),
                // As Archestra sent them: the variables are not replaced.
                arguments: arguments(&["--root", "$HOME/My Models"]),
                enabled: true,
            }]
        );
        assert_eq!(
            config.mcp.channel_entries(&variables())[0].target,
            ChannelTarget::Stdio {
                argv: vec![
                    "/opt/matlab/mcp".to_owned(),
                    "serve".to_owned(),
                    "--root".to_owned(),
                    "/Users/anna maria/My Models".to_owned(),
                ]
            }
        );
        assert_eq!(
            config.mcp.channel_entries(&variables())[1].target,
            ChannelTarget::Http {
                url: "http://127.0.0.1:8080/mcp".to_owned()
            }
        );
    }

    #[test]
    fn the_arguments_round_trip_through_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.yaml");
        let config = synced(&[CatalogItem {
            command: Some("server".to_owned()),
            arguments: arguments(&[
                "--name",
                "two words",
                r#"a "quote": and a \ backslash"#,
                "- dash",
                "#no comment",
                "'single'",
                "yes",
                "007",
                "a\ttab",
                "  spaces around  ",
                // Archestra refuses only a line break and a NUL.
                "\u{1b}[31m \u{7} \u{85} \u{2028} \u{feff} \u{7f}",
                // As long as Archestra accepts one, with spaces.
                &"two words ".repeat(409),
            ]),
            ..item("7c1e", "MATLAB")
        }]);
        config.save(&path).expect("save");
        let loaded = Config::load(&path).expect("load").expect("the file exists");
        assert_eq!(loaded, config);
    }

    #[test]
    fn a_file_from_before_the_arguments_is_the_config_of_a_sync_with_none() {
        // What the program before the arguments wrote for one command.
        let before: Config = serde_saphyr::from_str(
            "control_plane:\n  base_url: https://archestra.example.com\n  tunnel_id: tunnel_ab\n  api_key: archestra_dev_abc\nsynced_at: 2026-11-10T12:00:00Z\nmcp:\n  commands:\n  - channel: 7c1e\n    name: MATLAB\n    command: server\n    enabled: true\n",
        )
        .expect("parses");
        let fresh = synced(&[CatalogItem {
            command: Some("server".to_owned()),
            ..item("7c1e", "MATLAB")
        }]);
        // Equal: the first sync of the new program does not write the file
        // and does not start the MCP server again.
        assert_eq!(before, fresh);

        // And an entry with no arguments is written with no such key, as
        // that program wrote it.
        let yaml = serde_saphyr::to_string(&fresh).expect("serializes");
        assert!(!yaml.contains("arguments"), "{yaml}");

        // Other arguments are another config: the sync writes the file, and
        // the supervisor starts the MCP server again.
        let changed = synced(&[CatalogItem {
            command: Some("server".to_owned()),
            arguments: arguments(&["--verbose"]),
            ..item("7c1e", "MATLAB")
        }]);
        assert_ne!(changed.mcp, fresh.mcp);
        assert_ne!(
            changed.mcp.channel_entries(&variables())[0].target,
            fresh.mcp.channel_entries(&variables())[0].target
        );
    }

    #[test]
    fn an_empty_command_is_not_configured() {
        assert_eq!(
            command_target("", &[], &variables()),
            ChannelTarget::NotConfigured
        );
        assert_eq!(
            command_target("   ", &[], &variables()),
            ChannelTarget::NotConfigured
        );
    }

    #[test]
    fn a_command_with_an_open_quote_is_rejected() {
        assert_eq!(
            command_target("server 'open", &[], &variables()),
            ChannelTarget::Rejected(RejectReason::InvalidCommand)
        );
    }

    #[test]
    fn channel_entries_are_in_the_order_of_the_file() {
        let entries = sample().mcp.channel_entries(&variables());
        let channels: Vec<&str> = entries.iter().map(|entry| entry.channel.as_str()).collect();
        assert_eq!(channels, ["7c1e", "3f02", "91bd"]);
        assert_eq!(entries[0].name, "MATLAB");
        assert!(matches!(entries[0].target, ChannelTarget::Stdio { .. }));
        assert_eq!(entries[1].target, ChannelTarget::NotConfigured);
        assert_eq!(
            entries[2].target,
            ChannelTarget::Http {
                url: "http://127.0.0.1:8080/mcp".to_owned()
            }
        );
    }

    #[test]
    fn an_entry_that_is_off_is_disabled() {
        let mut config = sample();
        config.mcp.commands[0].enabled = false;
        config.mcp.commands[1].enabled = false;
        config.mcp.server_urls[0].enabled = false;
        let entries = config.mcp.channel_entries(&variables());
        assert_eq!(entries.len(), 3);
        for entry in entries {
            assert_eq!(entry.target, ChannelTarget::Disabled, "{}", entry.channel);
        }
    }

    #[test]
    fn a_channel_in_both_lists_is_rejected_for_that_channel_only() {
        let mut config = sample();
        config.mcp.server_urls.push(ServerUrlEntry {
            channel: "7c1e".to_owned(),
            name: "MATLAB".to_owned(),
            url: "http://127.0.0.1:9/mcp".to_owned(),
            enabled: true,
        });
        let entries = config.mcp.channel_entries(&variables());
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].channel, "7c1e");
        assert_eq!(
            entries[0].target,
            ChannelTarget::Rejected(RejectReason::MoreThanOneEntry)
        );
        assert!(matches!(entries[2].target, ChannelTarget::Http { .. }));
    }

    #[test]
    fn a_url_that_is_not_http_is_rejected() {
        assert_eq!(url_target(""), ChannelTarget::NotConfigured);
        assert_eq!(
            url_target("ftp://127.0.0.1/mcp"),
            ChannelTarget::Rejected(RejectReason::InvalidUrl)
        );
        assert_eq!(
            url_target("127.0.0.1:8080/mcp"),
            ChannelTarget::Rejected(RejectReason::InvalidUrl)
        );
    }

    #[test]
    fn tunnel_id_form() {
        assert!(is_valid_tunnel_id(
            "tunnel_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b"
        ));
        assert!(is_valid_tunnel_id(
            "tunnel_ab12_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b"
        ));
        assert!(!is_valid_tunnel_id("tunnel_"));
        assert!(!is_valid_tunnel_id("6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b"));
        assert!(!is_valid_tunnel_id("tunnel_a/b"));
        assert!(!is_valid_tunnel_id("tunnel_a?b"));
    }

    #[test]
    fn base_url_is_normalized() {
        assert_eq!(
            normalize_base_url(" https://archestra.example.com// "),
            "https://archestra.example.com"
        );
    }
}
