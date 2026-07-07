//! A governance actor. The AFC engine and MCP client are not `Send` (the engine holds
//! `Box<dyn Trait>` without thread-safety bounds, by design — it is a sync kernel). nitpicker's
//! `Tool::call`, however, must return a `Send` future. So the whole [`GovernanceState`] lives on one
//! dedicated thread running its own current-thread runtime, and the rest of the program talks to it
//! through a channel. Because the actor processes one command at a time, governance is serialized by
//! construction — no lock, no TOCTOU, and no `Send` bound on the engine.

use std::path::PathBuf;

use eyre::{Result, eyre};
use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::governance::GovernanceState;

enum Cmd {
    /// Start a fresh governed session: reset the context, set the prompt length, return the current
    /// trace length (so the caller can later slice this task's trace lines).
    BeginTask {
        prompt_len: usize,
        reply: oneshot::Sender<usize>,
    },
    /// Govern one tool call; the reply is the string the model should receive.
    Govern {
        tool_name: String,
        args: Map<String, Value>,
        reply: oneshot::Sender<Result<String>>,
    },
    /// The trace lines appended since `start`.
    TraceSince {
        start: usize,
        reply: oneshot::Sender<Vec<String>>,
    },
}

/// A cheap, cloneable, `Send` handle to the governance actor.
#[derive(Clone)]
pub struct GovernanceHandle {
    tx: mpsc::Sender<Cmd>,
}

impl GovernanceHandle {
    /// Spawn the actor thread, build the engine from `config`, and connect to the MCP server at
    /// `server`. Returns once the engine is ready (propagating any startup error).
    pub async fn spawn(config: PathBuf, server: PathBuf) -> Result<Self> {
        let (tx, rx) = mpsc::channel(32);
        let (ready_tx, ready_rx) = oneshot::channel();
        std::thread::Builder::new()
            .name("afc-governance".to_string())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(eyre!("build governance runtime: {e}")));
                        return;
                    }
                };
                rt.block_on(async move {
                    match GovernanceState::new(&config, &server).await {
                        Ok(state) => {
                            let _ = ready_tx.send(Ok(()));
                            run_actor(state, rx).await;
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                        }
                    }
                });
            })
            .map_err(|e| eyre!("spawn governance thread: {e}"))?;
        ready_rx
            .await
            .map_err(|_| eyre!("governance actor dropped before signalling ready"))??;
        Ok(Self { tx })
    }

    async fn request<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(make(reply))
            .await
            .map_err(|_| eyre!("governance actor is gone"))?;
        rx.await
            .map_err(|_| eyre!("governance actor dropped the reply"))
    }

    pub async fn begin_task(&self, prompt_len: usize) -> Result<usize> {
        self.request(|reply| Cmd::BeginTask { prompt_len, reply })
            .await
    }

    pub async fn govern(&self, tool_name: String, args: Map<String, Value>) -> Result<String> {
        self.request(|reply| Cmd::Govern {
            tool_name,
            args,
            reply,
        })
        .await?
    }

    pub async fn trace_since(&self, start: usize) -> Result<Vec<String>> {
        self.request(|reply| Cmd::TraceSince { start, reply }).await
    }
}

async fn run_actor(mut state: GovernanceState, mut rx: mpsc::Receiver<Cmd>) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::BeginTask { prompt_len, reply } => {
                state.reset_context();
                state.set_prompt_len(prompt_len);
                let _ = reply.send(state.trace().len());
            }
            Cmd::Govern {
                tool_name,
                args,
                reply,
            } => {
                let res = state
                    .govern(&tool_name, args)
                    .await
                    .map(|g| g.text().to_string());
                let _ = reply.send(res);
            }
            Cmd::TraceSince { start, reply } => {
                let lines = state
                    .trace()
                    .get(start..)
                    .map(<[String]>::to_vec)
                    .unwrap_or_default();
                let _ = reply.send(lines);
            }
        }
    }
}
