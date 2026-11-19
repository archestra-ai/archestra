//! The state file: the MCP bridge writes the state of each MCP server, and
//! the update that waits, to `state.json`, beside its config file, so that
//! `archestra bridge status` (another process) can show them. The file is of
//! the last MCP bridge that ran: a reader uses it only while the MCP bridge
//! runs.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::warn;

use crate::bridge::files;
use crate::bridge::state::BridgeState;

/// What the state file has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateFile {
    /// `None` until the MCP bridge applied the config file one time: the
    /// states of the MCP servers are not known before that.
    pub servers: Option<Vec<ServerLine>>,
    /// Archestra serves another program than the one that runs. `None` also
    /// for a file with no such entry: the one of an older program.
    pub update: Option<UpdateLine>,
}

/// One MCP server of the config file, in the order of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerLine {
    pub name: String,
    /// The name of the state, as in the report to Archestra: `running`,
    /// `starting`, `failed`, `no_command` or `stopped`.
    pub state: String,
    /// Why the MCP server failed.
    pub error: Option<String>,
}

/// The program that Archestra serves, when it is not the one that runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateLine {
    /// The version of that program, when Archestra knows it.
    pub version: Option<String>,
    /// Archestra lets the MCP bridge update itself.
    pub auto: bool,
}

impl StateFile {
    fn of(state: &BridgeState) -> Self {
        let servers = (state.config_loads > 0).then(|| {
            state
                .servers
                .iter()
                .map(|server| ServerLine {
                    name: server.name.clone(),
                    state: server.state.wire_name().to_owned(),
                    error: server.state.error().map(str::to_owned),
                })
                .collect()
        });
        let update = state.update.as_ref().map(|update| UpdateLine {
            version: update.version.clone(),
            auto: update.auto,
        });
        Self { servers, update }
    }
}

/// The state file of the MCP bridge with this config file.
pub fn path_beside(config_path: &Path) -> PathBuf {
    config_path.with_file_name("state.json")
}

/// Reads the state file. `None`: there is none, or it is not valid.
pub fn read(path: &Path) -> Option<StateFile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write(path: &Path, file: &StateFile) -> io::Result<()> {
    let text = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    files::replace_file(path, |temporary| std::fs::write(temporary, &text))
}

/// Writes the state file at once, and again each time the state of an MCP
/// server or the update changes. It waits `delay` after a change, so that
/// changes that come together make one write. It does not return while the
/// tunnel client runs.
pub(crate) async fn write_loop(
    path: &Path,
    mut state: watch::Receiver<BridgeState>,
    delay: Duration,
) {
    // What the file has. `None` after a failed write: the next change tries
    // again.
    let mut written: Option<StateFile> = None;
    loop {
        let file = StateFile::of(&state.borrow_and_update());
        if written.as_ref() != Some(&file) {
            written = match write(path, &file) {
                Ok(()) => Some(file),
                Err(error) => {
                    warn!(%error, path = %path.display(), "could not write the state file");
                    None
                }
            };
        }
        if state.changed().await.is_err() {
            return;
        }
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::state::{ServerState, ServerStatus, SyncState, Update};

    #[tokio::test]
    async fn the_file_follows_the_states_of_the_mcp_servers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = path_beside(&dir.path().join("config.yaml"));
        let (tx, rx) = watch::channel(BridgeState::new(SyncState::default()));
        let writer = tokio::spawn({
            let path = path.clone();
            async move { write_loop(&path, rx, Duration::ZERO).await }
        });

        // At the start the states are not known.
        wait_for(
            &path,
            &StateFile {
                servers: None,
                update: None,
            },
        )
        .await;

        tx.send_modify(|state| {
            state.config_loads = 1;
            state.servers = vec![
                ServerStatus {
                    channel: "7c1e".to_owned(),
                    name: "local-chrome".to_owned(),
                    state: ServerState::Running,
                },
                ServerStatus {
                    channel: "3f02".to_owned(),
                    name: "matlab".to_owned(),
                    state: ServerState::Failed {
                        error: "cannot start the program: file not found".to_owned(),
                    },
                },
            ];
            // A sync showed that Archestra serves another program.
            state.update = Some(Update {
                version: Some("0.2.0".to_owned()),
                sha256: "aa".to_owned(),
                auto: true,
            });
        });
        wait_for(
            &path,
            &StateFile {
                update: Some(UpdateLine {
                    version: Some("0.2.0".to_owned()),
                    auto: true,
                }),
                servers: Some(vec![
                    ServerLine {
                        name: "local-chrome".to_owned(),
                        state: "running".to_owned(),
                        error: None,
                    },
                    ServerLine {
                        name: "matlab".to_owned(),
                        state: "failed".to_owned(),
                        error: Some("cannot start the program: file not found".to_owned()),
                    },
                ]),
            },
        )
        .await;

        drop(tx);
        writer
            .await
            .expect("the writer ends with the tunnel client");
    }

    #[test]
    fn a_file_of_an_older_program_has_no_update() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        std::fs::write(&path, r#"{"servers": []}"#).expect("write");
        assert_eq!(
            read(&path),
            Some(StateFile {
                servers: Some(Vec::new()),
                update: None,
            })
        );
    }

    async fn wait_for(path: &Path, expected: &StateFile) {
        for _ in 0..200 {
            if read(path).as_ref() == Some(expected) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the state file is {:?}, not {expected:?}", read(path));
    }
}
