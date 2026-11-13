//! One streamable HTTP MCP server on the device. The user starts that server;
//! the client connects, does `initialize`, and forwards each request as one
//! HTTP POST. The answer is a JSON body or an SSE stream.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::{Notify, mpsc, watch};
use tracing::{debug, info, warn};

use crate::bridge::Timings;
use crate::bridge::channels::{ForwardError, Forwarded};
use crate::bridge::jsonrpc::{self, MessageKind};
use crate::bridge::state::ServerState;

const SESSION_ID_HEADER: &str = "Mcp-Session-Id";
const PROTOCOL_VERSION_HEADER: &str = "MCP-Protocol-Version";
const EVENT_STREAM: &str = "text/event-stream";

#[derive(Debug, thiserror::Error)]
enum ConnectError {
    #[error("the request failed: {}", with_sources(.0))]
    Transport(#[from] reqwest::Error),
    #[error("the MCP server did not answer `initialize` in time")]
    Timeout,
    #[error("the MCP server did not accept the handshake: {0}")]
    Handshake(ForwardError),
    #[error("the MCP server answered `initialize` with an error: {0}")]
    Rejected(Value),
}

/// One MCP session with the server, from one `initialize`.
#[derive(Debug)]
struct HttpSession {
    /// Counts the sessions of this channel, to tell a broken session from the
    /// session that came after it.
    generation: u64,
    session_id: Option<String>,
    protocol_version: String,
    initialize_result: Arc<Value>,
}

/// Where the connection of a channel is in its life.
#[derive(Debug, Clone)]
enum Connection {
    /// The client does `initialize`.
    Connecting,
    Connected(Arc<HttpSession>),
    /// No session is in operation. The client connects again after the
    /// backoff.
    Failed {
        error: String,
    },
}

/// The way to one HTTP MCP server.
#[derive(Debug, Clone)]
pub(crate) struct HttpHandle {
    http: reqwest::Client,
    url: Arc<str>,
    connection: watch::Receiver<Connection>,
    /// Tells the connection task that a session does not work any more.
    broken: mpsc::Sender<u64>,
    /// The next id for the MCP server. All clones of the handle share it.
    next_id: Arc<AtomicU64>,
}

impl HttpHandle {
    pub(crate) fn state(&self) -> ServerState {
        match &*self.connection.borrow() {
            Connection::Connecting => ServerState::Starting,
            Connection::Connected(_) => ServerState::Running,
            Connection::Failed { error } => ServerState::Failed {
                error: error.clone(),
            },
        }
    }

    pub(crate) fn initialize_result(&self) -> Option<Arc<Value>> {
        self.current_session()
            .ok()
            .map(|session| Arc::clone(&session.initialize_result))
    }

    fn current_session(&self) -> Result<Arc<HttpSession>, ForwardError> {
        match &*self.connection.borrow() {
            Connection::Connected(session) => Ok(Arc::clone(session)),
            Connection::Connecting | Connection::Failed { .. } => Err(ForwardError::NotRunning),
        }
    }

    pub(crate) async fn request(&self, mut message: Value) -> Result<Forwarded, ForwardError> {
        let session = self.current_session()?;
        let MessageKind::Request {
            id: original_id, ..
        } = jsonrpc::classify(&message)
        else {
            return Err(ForwardError::Protocol);
        };
        let id = Value::from(self.next_id.fetch_add(1, Ordering::Relaxed));
        jsonrpc::set_id(&mut message, id.clone());

        let target = Target {
            http: &self.http,
            url: &self.url,
            session_id: session.session_id.as_deref(),
            protocol_version: Some(&session.protocol_version),
        };
        let exchange = target.exchange(&message, &id).await;
        // The server is gone, or it does not know the session any more
        // (`404`, with or without a JSON-RPC error in the body).
        let session_lost = matches!(
            exchange,
            Ok((404, _)) | Err(ForwardError::Connect | ForwardError::TargetHttp { status: 404 })
        );
        if session_lost {
            let _ = self.broken.try_send(session.generation);
        }
        let (status, mut answer) = exchange?;
        jsonrpc::set_id(&mut answer, original_id);
        Ok(Forwarded {
            status,
            message: answer,
        })
    }

    pub(crate) async fn notify(&self, message: Value) -> Result<(), ForwardError> {
        let session = self.current_session()?;
        let target = Target {
            http: &self.http,
            url: &self.url,
            session_id: session.session_id.as_deref(),
            protocol_version: Some(&session.protocol_version),
        };
        let response = target.post(&message).await.map_err(|_| {
            let _ = self.broken.try_send(session.generation);
            ForwardError::Connect
        })?;
        check_status(&response)
    }
}

/// Makes the handle of a channel and the task that keeps its session. The
/// task tells `state_changed` each time the state of the connection changes.
pub(crate) fn channel(
    channel: String,
    url: String,
    http: reqwest::Client,
    timings: Timings,
    state_changed: Arc<Notify>,
) -> (HttpHandle, impl Future<Output = ()> + Send + 'static) {
    let (connection_tx, connection_rx) = watch::channel(Connection::Connecting);
    let (broken_tx, broken_rx) = mpsc::channel(8);
    let handle = HttpHandle {
        http: http.clone(),
        url: Arc::from(url),
        connection: connection_rx,
        broken: broken_tx,
        // Id 0 is the `initialize` of each session.
        next_id: Arc::new(AtomicU64::new(1)),
    };
    let server = Server {
        channel,
        http,
        url: Arc::clone(&handle.url),
        timings,
        connection: connection_tx,
        state_changed,
    };
    (handle, server.keep_connected(broken_rx))
}

/// What the task of one channel works with.
struct Server {
    channel: String,
    http: reqwest::Client,
    url: Arc<str>,
    timings: Timings,
    connection: watch::Sender<Connection>,
    state_changed: Arc<Notify>,
}

impl Server {
    fn set(&self, connection: Connection) {
        self.connection.send_replace(connection);
        self.state_changed.notify_one();
    }

    /// Connects, waits until the session breaks, and connects again with a
    /// backoff.
    async fn keep_connected(self, mut broken: mpsc::Receiver<u64>) {
        let channel = self.channel.as_str();
        let mut generation = 0;
        let mut failures = 0;
        loop {
            generation += 1;
            self.set(Connection::Connecting);
            let connect = initialize(&self.http, &self.url, generation);
            let connected =
                match tokio::time::timeout(self.timings.initialize_timeout, connect).await {
                    Ok(connected) => connected,
                    Err(_) => Err(ConnectError::Timeout),
                };
            let error = match connected {
                Ok(connected) => {
                    failures = 0;
                    info!(channel, "connected to the MCP server");
                    self.set(Connection::Connected(Arc::new(connected)));
                    loop {
                        match broken.recv().await {
                            Some(reported) if reported == generation => break,
                            // A late report about a session that is gone
                            // already.
                            Some(_) => {}
                            None => return,
                        }
                    }
                    warn!(channel, "the MCP server does not answer; connecting again");
                    "the MCP server does not answer".to_owned()
                }
                Err(error) => {
                    // The user starts this server; "not there yet" is a
                    // usual state.
                    if failures == 0 {
                        warn!(channel, %error, "cannot connect to the MCP server; trying again");
                    } else {
                        debug!(channel, %error, "cannot connect to the MCP server");
                    }
                    error.to_string()
                }
            };
            self.set(Connection::Failed { error });
            failures += 1;
            tokio::time::sleep(self.timings.mcp_server_backoff.delay(failures)).await;
        }
    }
}

/// The text of an error and of its causes. A `reqwest` error says only "error
/// sending request"; the cause says what went wrong.
fn with_sources(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// The MCP handshake over HTTP: `initialize`, then `notifications/initialized`.
async fn initialize(
    http: &reqwest::Client,
    url: &str,
    generation: u64,
) -> Result<HttpSession, ConnectError> {
    let id = Value::from(0);
    let request = jsonrpc::initialize_request(0);
    let mut target = Target {
        http,
        url,
        session_id: None,
        protocol_version: None,
    };

    let response = target.post(&request).await?;
    check_status(&response).map_err(ConnectError::Handshake)?;
    let session_id = response
        .headers()
        .get(SESSION_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    target.session_id = session_id.as_deref();
    let (_, mut answer) = target
        .read_answer(response, &id)
        .await
        .map_err(ConnectError::Handshake)?;
    if let Some(error) = answer.get("error") {
        return Err(ConnectError::Rejected(error.clone()));
    }
    let initialize_result = answer["result"].take();
    let protocol_version = initialize_result["protocolVersion"]
        .as_str()
        .unwrap_or(jsonrpc::PROTOCOL_VERSION)
        .to_owned();

    target.protocol_version = Some(&protocol_version);
    let response = target.post(&jsonrpc::initialized_notification()).await?;
    check_status(&response).map_err(ConnectError::Handshake)?;

    Ok(HttpSession {
        generation,
        session_id,
        protocol_version,
        initialize_result: Arc::new(initialize_result),
    })
}

/// Where the POSTs of one session go.
struct Target<'a> {
    http: &'a reqwest::Client,
    url: &'a str,
    session_id: Option<&'a str>,
    protocol_version: Option<&'a str>,
}

impl Target<'_> {
    async fn post(&self, message: &Value) -> Result<reqwest::Response, reqwest::Error> {
        let mut request = self
            .http
            .post(self.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .body(message.to_string());
        if let Some(session_id) = self.session_id {
            request = request.header(SESSION_ID_HEADER, session_id);
        }
        if let Some(protocol_version) = self.protocol_version {
            request = request.header(PROTOCOL_VERSION_HEADER, protocol_version);
        }
        request.send().await
    }

    /// Sends a request and reads its answer: the HTTP status of the server
    /// and the JSON-RPC response that has `id`.
    async fn exchange(&self, request: &Value, id: &Value) -> Result<(u16, Value), ForwardError> {
        let response = self
            .post(request)
            .await
            .map_err(|_| ForwardError::Connect)?;
        self.read_answer(response, id).await
    }

    async fn read_answer(
        &self,
        mut response: reqwest::Response,
        id: &Value,
    ) -> Result<(u16, Value), ForwardError> {
        let status = response.status().as_u16();
        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with(EVENT_STREAM));

        if !is_event_stream {
            let body = response.bytes().await.map_err(|_| ForwardError::Closed)?;
            return match serde_json::from_slice::<Value>(&body) {
                Ok(message) if is_response_to(&message, id) => Ok((status, message)),
                // No JSON-RPC answer in the body. With an error status, the
                // status says what is wrong.
                _ if status >= 400 => Err(ForwardError::TargetHttp { status }),
                _ => Err(ForwardError::Protocol),
            };
        }

        let mut events = SseParser::default();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                // The stream ended with no answer.
                Ok(None) if status >= 400 => return Err(ForwardError::TargetHttp { status }),
                Ok(None) => return Err(ForwardError::Protocol),
                Err(_) => return Err(ForwardError::Closed),
            };
            for data in events.push(&chunk) {
                let Ok(message) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                match jsonrpc::classify(&message) {
                    MessageKind::Response { .. } if is_response_to(&message, id) => {
                        return Ok((status, message));
                    }
                    MessageKind::Request { id, method } => {
                        debug!(
                            method,
                            "the MCP server sent a request; the answer is 'method not found'"
                        );
                        // Best effort: the answer of the command does not
                        // depend on this POST.
                        let _ = self.post(&jsonrpc::method_not_found(id, &method)).await;
                    }
                    MessageKind::Notification { method } => {
                        debug!(method, "dropped a notification of the MCP server");
                    }
                    MessageKind::Response { .. } | MessageKind::Invalid => {}
                }
            }
        }
    }
}

fn is_response_to(message: &Value, id: &Value) -> bool {
    matches!(jsonrpc::classify(message), MessageKind::Response { id: answered } if answered == *id)
}

fn check_status(response: &reqwest::Response) -> Result<(), ForwardError> {
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(ForwardError::TargetHttp {
            status: status.as_u16(),
        })
    }
}

/// Reads a `text/event-stream` body piece by piece and gives the `data` of
/// each complete event.
#[derive(Debug, Default)]
struct SseParser {
    /// Bytes of a line that is not complete yet.
    line: Vec<u8>,
    /// The `data` lines of the event that is not complete yet.
    data: Option<String>,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut events = Vec::new();
        for &byte in chunk {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            let line = String::from_utf8_lossy(&self.line).into_owned();
            self.line.clear();

            if line.is_empty() {
                // An empty line ends the event.
                events.extend(self.data.take());
            } else if let Some(value) = line.strip_prefix("data:") {
                let value = value.strip_prefix(' ').unwrap_or(value);
                match &mut self.data {
                    Some(data) => {
                        data.push('\n');
                        data.push_str(value);
                    }
                    None => self.data = Some(value.to_owned()),
                }
            }
            // Other fields (`event`, `id`, `retry`) and comments are not used.
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_gives_the_data_of_each_event() {
        let mut parser = SseParser::default();
        let events = parser.push(
            b"event: message\nid: 1\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n: comment\n\ndata: second\n\n",
        );
        assert_eq!(
            events,
            vec![
                r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_owned(),
                "second".to_owned()
            ]
        );
    }

    #[test]
    fn sse_joins_data_lines_and_accepts_crlf() {
        let mut parser = SseParser::default();
        let events = parser.push(b"data: {\"a\":\r\ndata:1}\r\n\r\n");
        assert_eq!(events, vec!["{\"a\":\n1}".to_owned()]);
    }

    #[test]
    fn sse_event_can_come_in_pieces() {
        let mut parser = SseParser::default();
        let text = "data: {\"text\":\"caf\u{e9}\"}\n\n".as_bytes();
        // Cut in the middle of the two bytes of `é`.
        let cut = text.iter().position(|&byte| byte == 0xc3).expect("é") + 1;
        assert!(parser.push(&text[..cut]).is_empty());
        assert_eq!(
            parser.push(&text[cut..]),
            vec!["{\"text\":\"caf\u{e9}\"}".to_owned()]
        );
    }

    #[test]
    fn sse_event_with_no_end_is_not_given() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: not complete\n").is_empty());
        assert!(parser.push(b"\n").len() == 1);
    }

    #[test]
    fn finds_the_response_for_an_id() {
        let answer = serde_json::json!({"jsonrpc": "2.0", "id": 5, "result": {}});
        assert!(is_response_to(&answer, &Value::from(5)));
        assert!(!is_response_to(&answer, &Value::from(6)));
        let request = serde_json::json!({"jsonrpc": "2.0", "id": 5, "method": "ping"});
        assert!(!is_response_to(&request, &Value::from(5)));
    }
}
