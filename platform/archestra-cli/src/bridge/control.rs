//! The requests of Archestra to the tunnel client itself. They come on the
//! reserved channel, through the poll, as the MCP requests do:
//!
//! - `bridge/sync`: sync the config file now.
//! - `bridge/server/restart`: stop one MCP server and start it again.
//! - `bridge/server/log`: the last stderr lines of one MCP server.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::bridge::channels::{ChannelHandle, ChannelMap, RestartError, RestartRequest};
use crate::bridge::jsonrpc::{self, MessageKind};
use crate::bridge::sync::{SyncError, SyncRequest};

const SYNC: &str = "bridge/sync";
const RESTART: &str = "bridge/server/restart";
const LOG: &str = "bridge/server/log";

#[derive(Debug, thiserror::Error)]
enum ControlError {
    #[error("the params of {method} are not valid: {message}")]
    InvalidParams {
        method: &'static str,
        message: String,
    },
    #[error(transparent)]
    Sync(#[from] SyncError),
    #[error(transparent)]
    Restart(#[from] RestartError),
    #[error("the tunnel client stops")]
    Stopping,
}

impl ControlError {
    fn code(&self) -> i64 {
        match self {
            Self::InvalidParams { .. } => jsonrpc::INVALID_PARAMS,
            Self::Sync(_) | Self::Restart(_) | Self::Stopping => jsonrpc::INTERNAL_ERROR,
        }
    }
}

/// One request to the tunnel client, with its params.
#[derive(Debug, PartialEq, Eq)]
enum ControlRequest {
    Sync,
    Restart { channel: String },
    Log { channel: String },
}

#[derive(Deserialize)]
struct ChannelParams {
    channel: String,
}

impl ControlRequest {
    /// `Ok(None)`: the tunnel client has no such method.
    fn parse(method: &str, params: &Value) -> Result<Option<Self>, ControlError> {
        Ok(Some(match method {
            SYNC => Self::Sync,
            RESTART => {
                let ChannelParams { channel } = parse_params(RESTART, params)?;
                Self::Restart { channel }
            }
            LOG => {
                let ChannelParams { channel } = parse_params(LOG, params)?;
                Self::Log { channel }
            }
            _ => return Ok(None),
        }))
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(
    method: &'static str,
    params: &Value,
) -> Result<T, ControlError> {
    T::deserialize(params).map_err(|error| ControlError::InvalidParams {
        method,
        message: error.to_string(),
    })
}

/// The ways from a control request to the parts of the tunnel client that do
/// the work. A clone is cheap.
#[derive(Debug, Clone)]
pub(crate) struct Control {
    pub sync_requests: mpsc::Sender<SyncRequest>,
    pub restarts: mpsc::Sender<RestartRequest>,
    pub channels: watch::Receiver<Arc<ChannelMap>>,
}

impl Control {
    /// Handles one polled message of the reserved channel. A request gets
    /// its JSON-RPC response. `None`: the message needs an acknowledgement
    /// only.
    pub(crate) async fn answer(&self, message: &Value) -> Option<Value> {
        match jsonrpc::classify(message) {
            MessageKind::Request { id, method } => {
                let done = match ControlRequest::parse(&method, &message["params"]) {
                    Ok(Some(request)) => self.perform(request).await,
                    Ok(None) => return Some(jsonrpc::method_not_found(id, &method)),
                    Err(error) => Err(error),
                };
                Some(match done {
                    Ok(result) => jsonrpc::result_response(id, result),
                    Err(error) => jsonrpc::error_response(id, error.code(), &error.to_string()),
                })
            }
            MessageKind::Notification { method } => {
                // Archestra sends this when a catalog item, or Start or Stop,
                // changes. It does not wait for the sync. A full queue has a
                // sync that did not start yet: that one gets the change too.
                if method == SYNC {
                    let _ = self.sync_requests.try_send(SyncRequest { reply: None });
                }
                None
            }
            MessageKind::Response { .. } | MessageKind::Invalid => None,
        }
    }

    async fn perform(&self, request: ControlRequest) -> Result<Value, ControlError> {
        match request {
            ControlRequest::Sync => {
                let (reply, synced) = oneshot::channel();
                self.sync_requests
                    .send(SyncRequest { reply: Some(reply) })
                    .await
                    .map_err(|_| ControlError::Stopping)?;
                synced.await.map_err(|_| ControlError::Stopping)??;
                Ok(json!({}))
            }
            ControlRequest::Restart { channel } => {
                let (reply, restarted) = oneshot::channel();
                self.restarts
                    .send(RestartRequest { channel, reply })
                    .await
                    .map_err(|_| ControlError::Stopping)?;
                restarted.await.map_err(|_| ControlError::Stopping)??;
                Ok(json!({}))
            }
            ControlRequest::Log { channel } => {
                // A statement of its own: the borrow of the channels ends
                // here.
                let handle = self.channels.borrow().get(&channel).cloned();
                let lines = handle.as_ref().map(ChannelHandle::log_lines);
                Ok(json!({ "lines": lines.unwrap_or_default() }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::channels::ChannelMap;

    /// A control with nothing behind it: no sync loop and no supervisor take
    /// its requests.
    fn control() -> (
        Control,
        mpsc::Receiver<SyncRequest>,
        mpsc::Receiver<RestartRequest>,
    ) {
        let (sync_requests, sync_rx) = mpsc::channel(4);
        let (restarts, restart_rx) = mpsc::channel(4);
        let (_channels_tx, channels) = watch::channel(Arc::new(ChannelMap::new()));
        let control = Control {
            sync_requests,
            restarts,
            channels,
        };
        (control, sync_rx, restart_rx)
    }

    #[test]
    fn parses_the_requests() {
        let parse =
            |method: &str, params: Value| ControlRequest::parse(method, &params).ok().flatten();
        assert_eq!(
            parse("bridge/sync", Value::Null),
            Some(ControlRequest::Sync)
        );
        assert_eq!(parse("bridge/sync", json!({})), Some(ControlRequest::Sync));
        assert_eq!(
            parse("bridge/server/restart", json!({"channel": "7c1e"})),
            Some(ControlRequest::Restart {
                channel: "7c1e".to_owned()
            })
        );
        assert_eq!(
            parse("bridge/server/log", json!({"channel": "7c1e"})),
            Some(ControlRequest::Log {
                channel: "7c1e".to_owned()
            })
        );
    }

    #[test]
    fn params_that_are_not_valid_have_their_code_and_unknown_methods_are_none() {
        for (method, params) in [
            ("bridge/server/restart", Value::Null),
            ("bridge/server/restart", json!({})),
            ("bridge/server/log", json!({"channel": 7})),
        ] {
            let error = ControlRequest::parse(method, &params).expect_err("not valid");
            assert_eq!(error.code(), -32602, "{method} {params}");
            assert!(error.to_string().contains(method), "{error}");
        }
        for method in ["bridge/unknown", "tools/list", "initialize", ""] {
            let parsed = ControlRequest::parse(method, &Value::Null).ok();
            assert_eq!(parsed, Some(None), "{method}");
        }
    }

    #[tokio::test]
    async fn an_unknown_method_gets_the_method_not_found_error() {
        let (control, _sync_rx, _restart_rx) = control();
        let request = json!({"jsonrpc": "2.0", "id": "c-1", "method": "bridge/unknown"});
        assert_eq!(
            control.answer(&request).await,
            Some(json!({
                "jsonrpc": "2.0",
                "id": "c-1",
                "error": {"code": -32601, "message": "Method not found: bridge/unknown"},
            }))
        );
    }

    #[tokio::test]
    async fn the_log_of_a_channel_with_no_server_is_empty() {
        let (control, _sync_rx, _restart_rx) = control();
        let request = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "bridge/server/log",
            "params": {"channel": "no-such-channel"},
        });
        assert_eq!(
            control.answer(&request).await,
            Some(json!({"jsonrpc": "2.0", "id": 4, "result": {"lines": []}}))
        );
    }

    #[tokio::test]
    async fn a_sync_notification_starts_a_sync_and_does_not_wait() {
        let (control, mut sync_rx, _restart_rx) = control();
        let notification = json!({"jsonrpc": "2.0", "method": "bridge/sync"});
        // No sync loop runs here: `answer` returns with no sync done.
        assert_eq!(control.answer(&notification).await, None);
        let request = sync_rx.try_recv().expect("a sync request");
        assert!(request.reply.is_none());
    }

    #[tokio::test]
    async fn other_notifications_are_acknowledged_and_do_nothing() {
        let (control, mut sync_rx, mut restart_rx) = control();
        for message in [
            json!({"jsonrpc": "2.0", "method": "bridge/server/restart", "params": {"channel": "7c1e"}}),
            json!({"jsonrpc": "2.0", "method": "bridge/server/log", "params": {"channel": "7c1e"}}),
            json!({"jsonrpc": "2.0", "method": "bridge/unknown"}),
            json!({"jsonrpc": "2.0", "id": 1, "result": {}}),
            json!("not a message"),
        ] {
            assert_eq!(control.answer(&message).await, None, "{message}");
        }
        assert!(sync_rx.try_recv().is_err());
        assert!(restart_rx.try_recv().is_err());
    }
}
