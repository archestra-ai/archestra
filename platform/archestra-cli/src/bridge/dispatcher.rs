//! The poll loop: get commands from Archestra, send each to the MCP server of
//! its channel, and post the answer. A command on the reserved channel is
//! for the tunnel client itself.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::Instant;
use tracing::{debug, error, warn};

use crate::bridge::Timings;
use crate::bridge::backoff::Backoff;
use crate::bridge::channels::{ChannelHandle, ChannelMap, ForwardError};
use crate::bridge::control::Control;
use crate::bridge::control_plane::{
    BRIDGE_CHANNEL, Command, ControlPlane, PollOutcome, PostOutcome, ResponseType, TunnelResponse,
    json_content_type, parse_response_timeout,
};
use crate::bridge::jsonrpc::{self, MessageKind};
use crate::bridge::state::{BridgeState, BridgeStatus};

const JSONRPC_COMMAND: &str = "jsonrpc";
/// Tries for one response POST, the first one included.
const MAX_POST_TRIES: u32 = 5;
/// HTTP-style codes of `resp_code`.
const OK: u16 = 200;
const ACCEPTED: u16 = 202;
const BAD_GATEWAY: u16 = 502;

/// Polls until Archestra rejects the device key (`401` or `403`). Then the
/// status is "signed out" and the loop returns: a retry does not help.
pub(crate) async fn poll_loop(
    control_plane: Arc<ControlPlane>,
    channels: watch::Receiver<Arc<ChannelMap>>,
    control: Control,
    timings: Timings,
    state: &watch::Sender<BridgeState>,
    in_flight: &std::sync::atomic::AtomicUsize,
) {
    // The commands in work. They complete in any order; dropping the set
    // (when the loop ends) stops them.
    let mut in_work = JoinSet::new();
    let mut failures = 0;

    loop {
        while in_work.try_join_next().is_some() {}
        // For the update of the program, which waits until no command is in
        // work. The number is as old as the last poll: good enough for that.
        in_flight.store(in_work.len(), std::sync::atomic::Ordering::Relaxed);

        // A statement of its own: the borrow of `channels` must end before
        // the poll waits.
        let ready = ready_channels(&channels.borrow());
        let polled = control_plane
            .poll(&ready, timings.poll_wait, timings.poll_guard)
            .await;
        match polled {
            Ok(outcome) => {
                failures = 0;
                set_status(state, BridgeStatus::Connected);
                let PollOutcome::Commands {
                    received_at,
                    commands,
                } = outcome
                else {
                    continue;
                };
                for command in commands {
                    let deadline = parse_response_timeout(&command.response_timeout)
                        .and_then(|timeout| received_at.checked_add(timeout));
                    let target = if command.channel == BRIDGE_CHANNEL {
                        Target::TunnelClient(control.clone())
                    } else {
                        Target::McpServer(channels.borrow().get(&command.channel).cloned())
                    };
                    in_work.spawn(process(
                        command,
                        deadline,
                        target,
                        Arc::clone(&control_plane),
                        timings.control_plane_backoff,
                    ));
                }
            }
            Err(error) if error.is_auth() => {
                error!(%error, "Archestra rejected the device key; the device is signed out");
                set_status(state, BridgeStatus::SignedOut);
                return;
            }
            Err(error) => {
                failures += 1;
                warn!(%error, "the poll failed; a retry follows");
                set_status(state, BridgeStatus::Disconnected);
                tokio::time::sleep(timings.control_plane_backoff.delay(failures)).await;
            }
        }
    }
}

fn set_status(state: &watch::Sender<BridgeState>, new: BridgeStatus) {
    state.send_if_modified(|state| {
        let changed = state.status != new;
        state.status = new;
        changed
    });
}

/// Who a polled command is for.
enum Target {
    /// The MCP server of the channel of the command. `None`: the config file
    /// has no MCP server for the channel.
    McpServer(Option<ChannelHandle>),
    /// The tunnel client itself: the command came on the reserved channel.
    TunnelClient(Control),
}

/// The channels to report with a poll: those with an MCP server that is
/// initialized and in operation. Sorted, so the header is stable.
fn ready_channels(channels: &ChannelMap) -> Vec<String> {
    let mut ready: Vec<String> = channels
        .iter()
        .filter(|(_, handle)| handle.is_ready())
        .map(|(channel, _)| channel.clone())
        .collect();
    ready.sort();
    ready
}

/// Handles one command inside its deadline. A command whose deadline passed
/// gets no response at all.
async fn process(
    command: Command,
    deadline: Option<Instant>,
    target: Target,
    control_plane: Arc<ControlPlane>,
    backoff: Backoff,
) {
    let request_id = command.request_id.clone();
    if command.command_type != JSONRPC_COMMAND {
        warn!(
            request_id,
            command_type = command.command_type,
            "ignored a command of a type that the client does not know"
        );
        return;
    }
    let Some(message) = command.jsonrpc else {
        warn!(request_id, "ignored a jsonrpc command with no message");
        return;
    };

    let work = async {
        let answer = match &target {
            Target::McpServer(handle) => answer(message, handle.as_ref()).await,
            Target::TunnelClient(control) => match control.answer(&message).await {
                Some(response) => Answer::response(OK, response),
                None => Answer::ack(),
            },
        };
        let response = TunnelResponse {
            request_id: command.request_id,
            channel: command.channel,
            resp_json: answer.resp_json,
            resp_headers: json_content_type(),
            resp_code: answer.resp_code,
            resp_type: answer.resp_type,
        };
        deliver(&control_plane, &response, backoff).await;
    };
    match deadline {
        None => work.await,
        Some(deadline) if deadline <= Instant::now() => {
            debug!(request_id, "dropped a command: its response_timeout passed");
        }
        Some(deadline) => {
            if tokio::time::timeout_at(deadline, work).await.is_err() {
                debug!(request_id, "dropped a command: its response_timeout passed");
            }
        }
    }
}

/// The answer to one polled message, as the fields of a tunnel response.
#[derive(Debug, PartialEq)]
struct Answer {
    resp_type: ResponseType,
    resp_json: Option<Value>,
    resp_code: u16,
}

impl Answer {
    fn response(resp_code: u16, message: Value) -> Self {
        Self {
            resp_type: ResponseType::JsonrpcResponse,
            resp_json: Some(message),
            resp_code,
        }
    }

    fn failure(id: Value, error: ForwardError) -> Self {
        let message = format!("MCP bridge: {error}");
        Self::response(
            BAD_GATEWAY,
            jsonrpc::tunnel_failure_response(id, &message, error.tunnel_failure()),
        )
    }

    fn ack() -> Self {
        Self {
            resp_type: ResponseType::NotifyAck,
            resp_json: None,
            resp_code: ACCEPTED,
        }
    }
}

/// Decides what to do with a polled message. `handle` is the channel of the
/// command, when the config file has an MCP server for it.
async fn answer(message: Value, handle: Option<&ChannelHandle>) -> Answer {
    match jsonrpc::classify(&message) {
        MessageKind::Request { id, method } => {
            // `None`: no MCP server is in operation for the channel.
            let initialized = handle.and_then(|handle| Some((handle, handle.initialize_result()?)));
            let Some((handle, initialize_result)) = initialized else {
                return Answer::failure(id, ForwardError::NotRunning);
            };
            if method == jsonrpc::INITIALIZE {
                // The client did `initialize` itself. The MCP server takes
                // only one: answer from the kept result.
                let result = Value::clone(&initialize_result);
                return Answer::response(OK, jsonrpc::result_response(id, result));
            }
            match handle.request(message).await {
                Ok(forwarded) => Answer::response(forwarded.status, forwarded.message),
                Err(error) => Answer::failure(id, error),
            }
        }
        MessageKind::Notification { method } => {
            if jsonrpc::is_forwarded_notification(&method)
                && let Some(handle) = handle.filter(|handle| handle.is_ready())
                && let Err(error) = handle.notify(message).await
            {
                debug!(method, %error, "could not forward a notification");
            }
            Answer::ack()
        }
        // The client answers the requests of an MCP server itself, so no MCP
        // server waits for a response. Nothing to forward.
        MessageKind::Response { .. } | MessageKind::Invalid => Answer::ack(),
    }
}

/// Posts a response. Transient failures get a bounded number of retries with
/// backoff; the deadline of the command (in `process`) can end them earlier.
async fn deliver(control_plane: &ControlPlane, response: &TunnelResponse, backoff: Backoff) {
    let mut tries = 1;
    loop {
        match control_plane.post_response(response).await {
            PostOutcome::Done => return,
            PostOutcome::Retry if tries == MAX_POST_TRIES => {
                warn!(
                    request_id = response.request_id,
                    "gave up on a response after {MAX_POST_TRIES} tries"
                );
                return;
            }
            PostOutcome::Retry => {
                tokio::time::sleep(backoff.delay(tries)).await;
                tries += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn a_request_for_a_channel_with_no_server_gets_the_tunnel_failure() {
        let request = json!({"jsonrpc": "2.0", "id": "rpc_1", "method": "tools/list"});
        let answer = answer(request, None).await;
        assert_eq!(answer.resp_type, ResponseType::JsonrpcResponse);
        assert_eq!(answer.resp_code, 502);
        assert_eq!(
            answer.resp_json,
            Some(json!({
                "jsonrpc": "2.0",
                "id": "rpc_1",
                "error": {
                    "code": -32603,
                    "message": "MCP bridge: no MCP server runs for this catalog item on the device; see its state on the Device tab of Personal Settings in Archestra",
                    "data": {"tunnel_failure": {
                        "version": 1,
                        "source": "transport_closed",
                        "upstream_response_received": false,
                    }},
                },
            }))
        );
    }

    #[tokio::test]
    async fn initialize_for_a_channel_with_no_server_gets_the_tunnel_failure() {
        let request = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}});
        let answer = answer(request, None).await;
        assert_eq!(answer.resp_code, 502);
        assert_eq!(
            answer.resp_json.expect("an error")["error"]["code"],
            json!(-32603)
        );
    }

    #[tokio::test]
    async fn notifications_are_acknowledged() {
        for message in [
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 4, "result": {}}),
        ] {
            assert_eq!(answer(message, None).await, Answer::ack());
        }
        assert_eq!(
            Answer::ack(),
            Answer {
                resp_type: ResponseType::NotifyAck,
                resp_json: None,
                resp_code: 202
            }
        );
    }
}
