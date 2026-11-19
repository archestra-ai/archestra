//! HTTP calls to Archestra: tunnel metadata, poll, response, state report,
//! sign-in, and the removal of the device.
//!
//! The tunnel calls use the wire protocol of the OpenAI tunnel client.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;
use tracing::warn;

use crate::bridge::config::ControlPlaneConfig;

/// The reserved channel. A message on it is for the tunnel client itself,
/// not for an MCP server. The id of a catalog item is a UUID, so no catalog
/// item has this channel.
pub(crate) const BRIDGE_CHANNEL: &str = "archestra-bridge";

/// The device key is this prefix + the `deviceCode` of the sign-in.
pub const DEVICE_KEY_PREFIX: &str = "archestra_dev_";

const CLIENT_NAME: &str = "archestra-mcp-bridge";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const CLIENT_NAME_HEADER: &str = "X-Tunnel-Client-Name";
const CLIENT_VERSION_HEADER: &str = "X-Tunnel-Client-Version";
const SERVER_INFO_HEADER: &str = "X-Tunnel-MCP-Server-Info";
/// The system and CPU of this program, and the SHA-256 of its file: Archestra
/// answers a sync with the program that it serves for that target.
const CLIENT_TARGET_HEADER: &str = "X-Tunnel-Client-Target";
const CLIENT_SHA256_HEADER: &str = "X-Tunnel-Client-Sha256";

/// The largest batch that the protocol allows for one poll.
const POLL_LIMIT: u32 = 25;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// For the calls that are not a long poll.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// For the download of the program: some megabytes, also on a slow line.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// For the call of `archestra uninstall`: the user waits in the terminal, and
/// the uninstall goes on when Archestra does not answer.
const REMOVE_DEVICE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum ControlPlaneError {
    #[error("the request to Archestra failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Archestra answered with HTTP status {0}")]
    Status(u16),
    #[error("Archestra sent an answer that is not valid: {0}")]
    Decode(#[from] serde_json::Error),
}

impl ControlPlaneError {
    /// `401` or `403`: the device key is not valid (any more). The user must
    /// sign in again; a retry does not help.
    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Status(401 | 403))
    }

    /// A failure of a response POST that can go away with a retry.
    fn is_transient_for_response(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status(status) => matches!(status, 408 | 429 | 502 | 503 | 504),
            Self::Decode(_) => false,
        }
    }
}

/// The HTTP client for all calls to Archestra.
pub(crate) fn http_client() -> Result<reqwest::Client, ControlPlaneError> {
    Ok(reqwest::Client::builder()
        .user_agent(format!("{CLIENT_NAME}/{CLIENT_VERSION}"))
        .connect_timeout(CONNECT_TIMEOUT)
        .build()?)
}

/// One desktop MCP server that the user of the device installed: the catalog
/// item with its config, and whether it is on for this device.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    /// How to start the MCP server. The variables are not replaced.
    #[serde(default)]
    pub command: Option<String>,
    /// What the user of the device added in Archestra: they go after the
    /// arguments of the command, each as one argument. An Archestra from
    /// before the arguments sends no such key.
    #[serde(default, deserialize_with = "null_as_default")]
    pub arguments: Vec<String>,
    /// The address of an HTTP MCP server on the device. An item has a
    /// command or a URL, not both.
    #[serde(default)]
    pub url: Option<String>,
    /// `false`: the user stopped the MCP server in Archestra.
    pub enabled: bool,
}

/// A `null` is the default value, as a key that is missing is.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// The answer of `GET /v1/tunnels/{tunnel_id}`. `catalog_items` and
/// `program` are the additions of Archestra.
#[derive(Debug, Deserialize)]
pub(crate) struct TunnelMetadata {
    #[serde(default)]
    pub catalog_items: Vec<CatalogItem>,
    /// `None`: Archestra has no program for the target of this one.
    #[serde(default)]
    pub program: Option<ServedProgram>,
}

/// The `archestra` program that Archestra serves for the target of this one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServedProgram {
    /// `None`: Archestra does not know the version (a build put there by
    /// hand).
    #[serde(default)]
    pub version: Option<String>,
    /// The SHA-256 of its file, in lower-case hex.
    pub sha256: String,
    /// Archestra lets the MCP bridge update itself.
    #[serde(default)]
    pub auto_update: bool,
}

/// One item of a poll answer.
#[derive(Debug, Deserialize)]
pub(crate) struct Command {
    pub request_id: String,
    pub command_type: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    /// Kept as raw JSON: a value that is not valid means "no deadline".
    #[serde(default)]
    pub response_timeout: Value,
    #[serde(default)]
    pub jsonrpc: Option<Value>,
}

fn default_channel() -> String {
    "main".to_owned()
}

#[derive(Debug)]
pub(crate) enum PollOutcome {
    /// `204`: poll again.
    NoWork,
    Commands {
        /// When the poll answer came. The `response_timeout` of each command
        /// counts from here.
        received_at: Instant,
        commands: Vec<Command>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ResponseType {
    JsonrpcResponse,
    NotifyAck,
    /// A notification that the tunnel client sends on its own.
    JsonrpcNotify,
}

/// The body of `POST /v1/tunnels/{tunnel_id}/response`.
#[derive(Debug, Serialize)]
pub(crate) struct TunnelResponse {
    pub request_id: String,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resp_json: Option<Value>,
    pub resp_headers: BTreeMap<&'static str, Vec<&'static str>>,
    pub resp_code: u16,
    pub resp_type: ResponseType,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PostOutcome {
    /// Nothing more to do: Archestra has the response, or a retry does not
    /// help.
    Done,
    /// The POST failed and a retry can help.
    Retry,
}

/// The tunnel of one device.
#[derive(Debug)]
pub(crate) struct ControlPlane {
    http: reqwest::Client,
    base_url: String,
    tunnel_id: String,
    api_key: String,
}

impl ControlPlane {
    pub(crate) fn new(http: reqwest::Client, config: &ControlPlaneConfig) -> Self {
        Self {
            http,
            base_url: config.base_url.clone(),
            tunnel_id: config.tunnel_id.clone(),
            api_key: config.api_key.clone(),
        }
    }

    fn tunnel_url(&self, suffix: &str) -> String {
        format!("{}/v1/tunnels/{}{suffix}", self.base_url, self.tunnel_id)
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let request = self
            .http
            .request(method, url)
            .bearer_auth(&self.api_key)
            .header(CLIENT_NAME_HEADER, CLIENT_NAME)
            .header(CLIENT_VERSION_HEADER, CLIENT_VERSION)
            .header(CLIENT_TARGET_HEADER, crate::program::target());
        match crate::program::own_sha256() {
            Some(sha256) => request.header(CLIENT_SHA256_HEADER, sha256),
            None => request,
        }
    }

    /// The desktop MCP servers that the user of this device installed, with
    /// their config.
    pub(crate) async fn tunnel_metadata(&self) -> Result<TunnelMetadata, ControlPlaneError> {
        let response = self
            .request(reqwest::Method::GET, self.tunnel_url(""))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?;
        decode_json(response).await
    }

    /// Asks Archestra to remove this device: the device key stops working,
    /// and the Device tab does not show the device any more.
    pub(crate) async fn remove_device(&self) -> Result<(), ControlPlaneError> {
        let status = self
            .request(reqwest::Method::DELETE, self.tunnel_url(""))
            .timeout(REMOVE_DEVICE_TIMEOUT)
            .send()
            .await?
            .status();
        if status.is_success() {
            Ok(())
        } else {
            Err(ControlPlaneError::Status(status.as_u16()))
        }
    }

    /// One long poll. `ready_channels` are the channels that have an MCP
    /// server in operation now. `wait` is the hold that the client asks for;
    /// the HTTP request gives up `guard` later.
    pub(crate) async fn poll(
        &self,
        ready_channels: &[String],
        wait: Duration,
        guard: Duration,
    ) -> Result<PollOutcome, ControlPlaneError> {
        let url = self.tunnel_url(&format!(
            "/poll?limit={POLL_LIMIT}&timeout_ms={}",
            wait.as_millis()
        ));
        let response = self
            .request(reqwest::Method::GET, url)
            .header(SERVER_INFO_HEADER, server_info_header(ready_channels))
            .timeout(wait + guard)
            .send()
            .await?;
        let received_at = Instant::now();

        match response.status().as_u16() {
            204 => Ok(PollOutcome::NoWork),
            200 => {
                let body = response.bytes().await?;
                Ok(PollOutcome::Commands {
                    received_at,
                    commands: decode_commands(&body)?,
                })
            }
            status => Err(ControlPlaneError::Status(status)),
        }
    }

    /// One try to post the answer of a command.
    pub(crate) async fn post_response(&self, response: &TunnelResponse) -> PostOutcome {
        let request_id = response.request_id.as_str();
        match self.try_post_response(response).await {
            // `404`: the request does not wait any more.
            Ok(()) | Err(ControlPlaneError::Status(404)) => PostOutcome::Done,
            Err(error) if error.is_transient_for_response() => {
                warn!(request_id, %error, "could not post the response; a retry follows");
                PostOutcome::Retry
            }
            Err(error) => {
                warn!(request_id, %error, "Archestra did not accept the response");
                PostOutcome::Done
            }
        }
    }

    /// One try to post a notification of the tunnel client itself: the
    /// state report. No request waits for it, so it gets a new request id.
    pub(crate) async fn post_notification(
        &self,
        notification: Value,
    ) -> Result<(), ControlPlaneError> {
        self.try_post_response(&TunnelResponse {
            request_id: uuid_v4(),
            channel: BRIDGE_CHANNEL.to_owned(),
            resp_json: Some(notification),
            resp_headers: json_content_type(),
            resp_code: 200,
            resp_type: ResponseType::JsonrpcNotify,
        })
        .await
    }

    async fn try_post_response(&self, response: &TunnelResponse) -> Result<(), ControlPlaneError> {
        let status = self
            .request(reqwest::Method::POST, self.tunnel_url("/response"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(response)?)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .status();
        if status.is_success() {
            Ok(())
        } else {
            Err(ControlPlaneError::Status(status.as_u16()))
        }
    }
}

/// Downloads the `archestra` program that Archestra serves for `target`
/// (`<system>-<cpu>`). The download needs no device key: it is the one of the
/// install command.
pub(crate) async fn download_program(
    http: &reqwest::Client,
    base_url: &str,
    target: &str,
) -> Result<Vec<u8>, ControlPlaneError> {
    let response = http
        .get(format!("{base_url}/api/archestra-cli/{target}"))
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(ControlPlaneError::Status(status.as_u16()));
    }
    Ok(response.bytes().await?.to_vec())
}

/// `resp_headers` of a response of the tunnel client.
pub(crate) fn json_content_type() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([("Content-Type", vec!["application/json"])])
}

/// A random UUID, version 4. It names a notification; it is not a secret.
fn uuid_v4() -> String {
    // The version is in the high bits of the third group, the variant in
    // the high bits of the fourth.
    let bits = fastrand::u128(..) & !(0xf << 76) | (0x4 << 76);
    let bits = bits & !(0x3 << 62) | (0x2 << 62);
    let hex = format!("{bits:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// The value of `X-Tunnel-MCP-Server-Info`, version 1: the channels that have
/// an MCP server in operation. Each MCP session lives in this one process, so
/// each channel has `proc_affinity`.
pub(crate) fn server_info_header(ready_channels: &[String]) -> String {
    // Written by hand: the protocol fixes the order of the keys, and the
    // order of `json!` keys depends on a feature of serde_json.
    let channels: Vec<String> = ready_channels
        .iter()
        .map(|name| {
            let name = Value::from(name.as_str());
            format!(r#"{{"name":{name},"proc_affinity":true}}"#)
        })
        .collect();
    format!(r#"{{"version":1,"channels":[{}]}}"#, channels.join(","))
}

/// Parses `response_timeout`: digits + one unit (`ns`, `us`, `ms`, `s`, `m`,
/// `h`). As the OpenAI client does, a value that is absent or not valid gives
/// `None`: the command has no deadline.
pub(crate) fn parse_response_timeout(value: &Value) -> Option<Duration> {
    let text = value.as_str()?;
    let digits_end = text.find(|c: char| !c.is_ascii_digit())?;
    let (digits, unit) = text.split_at(digits_end);
    let amount: u64 = digits.parse().ok()?;
    match unit {
        "ns" => Some(Duration::from_nanos(amount)),
        "us" => Some(Duration::from_micros(amount)),
        "ms" => Some(Duration::from_millis(amount)),
        "s" => Some(Duration::from_secs(amount)),
        "m" => amount.checked_mul(60).map(Duration::from_secs),
        "h" => amount.checked_mul(3600).map(Duration::from_secs),
        _ => None,
    }
}

/// Decodes the commands one by one: a command that the client cannot read
/// does not stop the other commands of the batch.
fn decode_commands(body: &[u8]) -> Result<Vec<Command>, ControlPlaneError> {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        commands: Vec<Value>,
    }

    let envelope: Envelope = serde_json::from_slice(body)?;
    let mut commands = Vec::with_capacity(envelope.commands.len());
    for raw in envelope.commands {
        match serde_json::from_value(raw) {
            Ok(command) => commands.push(command),
            Err(error) => warn!(%error, "ignored a polled command that is not valid"),
        }
    }
    Ok(commands)
}

async fn decode_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ControlPlaneError> {
    let status = response.status();
    if !status.is_success() {
        return Err(ControlPlaneError::Status(status.as_u16()));
    }
    let body = response.bytes().await?;
    Ok(serde_json::from_slice(&body)?)
}

/// The answer of `POST /api/desktop-devices/sign-in`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_path: String,
    /// Seconds between two polls for the result.
    pub interval: f64,
    /// The setup code was known: the setup dialog in Archestra shows the
    /// request, so no approval page is opened.
    #[serde(default)]
    pub approve_in_archestra: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SignInStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

/// The answer of `POST /api/desktop-devices/sign-in/poll`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInPoll {
    pub status: SignInStatus,
    pub tunnel_id: Option<String>,
}

pub(crate) async fn start_sign_in(
    http: &reqwest::Client,
    base_url: &str,
    device_name: &str,
    platform: &str,
    setup_code: Option<&str>,
) -> Result<SignInStart, ControlPlaneError> {
    let mut body = json!({ "deviceName": device_name, "platform": platform });
    if let Some(setup_code) = setup_code {
        body["setupCode"] = json!(setup_code);
    }
    post_json(
        http,
        format!("{base_url}/api/desktop-devices/sign-in"),
        &body,
    )
    .await
}

pub(crate) async fn poll_sign_in(
    http: &reqwest::Client,
    base_url: &str,
    device_code: &str,
) -> Result<SignInPoll, ControlPlaneError> {
    let body = json!({ "deviceCode": device_code });
    post_json(
        http,
        format!("{base_url}/api/desktop-devices/sign-in/poll"),
        &body,
    )
    .await
}

async fn post_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: String,
    body: &Value,
) -> Result<T, ControlPlaneError> {
    let response = http
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(body)?)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await?;
    decode_json(response).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control_plane() -> ControlPlane {
        ControlPlane::new(
            reqwest::Client::new(),
            &ControlPlaneConfig {
                base_url: "https://archestra.example.com".to_owned(),
                tunnel_id: "tunnel_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b".to_owned(),
                api_key: format!("{DEVICE_KEY_PREFIX}code"),
            },
        )
    }

    #[test]
    fn tunnel_urls_have_the_tunnel_id() {
        let control_plane = control_plane();
        assert_eq!(
            control_plane.tunnel_url(""),
            "https://archestra.example.com/v1/tunnels/tunnel_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b"
        );
        assert_eq!(
            control_plane.tunnel_url("/response"),
            "https://archestra.example.com/v1/tunnels/tunnel_6b1f0c2e4d5a4f7e8a9b0c1d2e3f4a5b/response"
        );
    }

    #[test]
    fn requests_have_the_bearer_key_and_the_client_headers() {
        let control_plane = control_plane();
        let request = control_plane
            .request(reqwest::Method::GET, control_plane.tunnel_url("/poll"))
            .build()
            .expect("the request builds");
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        assert_eq!(
            header("authorization").as_deref(),
            Some("Bearer archestra_dev_code")
        );
        assert_eq!(
            header("x-tunnel-client-name").as_deref(),
            Some("archestra-mcp-bridge")
        );
        assert_eq!(
            header("x-tunnel-client-version").as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        // What Archestra needs to say if it serves another program.
        assert_eq!(
            header("x-tunnel-client-target"),
            Some(crate::program::target())
        );
        assert_eq!(
            header("x-tunnel-client-sha256").as_deref(),
            crate::program::own_sha256()
        );
    }

    #[test]
    fn server_info_header_lists_the_channels() {
        assert_eq!(
            server_info_header(&["7c1e".to_owned(), "91bd".to_owned()]),
            r#"{"version":1,"channels":[{"name":"7c1e","proc_affinity":true},{"name":"91bd","proc_affinity":true}]}"#
        );
        assert_eq!(server_info_header(&[]), r#"{"version":1,"channels":[]}"#);
        // A name from the config file is escaped as JSON.
        assert_eq!(
            server_info_header(&["a\"b".to_owned()]),
            r#"{"version":1,"channels":[{"name":"a\"b","proc_affinity":true}]}"#
        );
    }

    #[test]
    fn parses_a_valid_response_timeout() {
        let parse = |text: &str| parse_response_timeout(&json!(text));
        assert_eq!(parse("118500ms"), Some(Duration::from_millis(118_500)));
        assert_eq!(parse("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse("0s"), Some(Duration::ZERO));
        assert_eq!(parse("2m"), Some(Duration::from_secs(120)));
        assert_eq!(parse("1h"), Some(Duration::from_secs(3600)));
        assert_eq!(parse("250us"), Some(Duration::from_micros(250)));
        assert_eq!(parse("7ns"), Some(Duration::from_nanos(7)));
    }

    #[test]
    fn a_response_timeout_that_is_not_valid_means_no_deadline() {
        for text in [
            "",
            "30",
            "s",
            "4.5s",
            "-1s",
            "+1s",
            "1m30s",
            " 1s",
            "1s ",
            "1e3s",
            "30d",
            "30S",
            "999999999999999999999999h",
            "18446744073709551615h",
        ] {
            assert_eq!(parse_response_timeout(&json!(text)), None, "{text:?}");
        }
        assert_eq!(parse_response_timeout(&json!(30)), None);
        assert_eq!(parse_response_timeout(&Value::Null), None);
    }

    #[test]
    fn decodes_the_commands_of_a_poll_answer() {
        let body = json!({
            "commands": [
                {
                    "request_id": "r1",
                    "command_type": "jsonrpc",
                    "channel": "7c1e",
                    "created_at": "2026-11-10T12:00:00Z",
                    "response_timeout": "118500ms",
                    "headers": {},
                    "jsonrpc": {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                    "a_future_field": true,
                },
                {"command_type": "jsonrpc"},
                {"request_id": "r2", "command_type": "session_termination"},
            ]
        });
        let commands = decode_commands(body.to_string().as_bytes()).expect("decodes");
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].request_id, "r1");
        assert_eq!(commands[0].channel, "7c1e");
        assert_eq!(
            parse_response_timeout(&commands[0].response_timeout),
            Some(Duration::from_millis(118_500))
        );
        assert_eq!(commands[1].channel, "main");
        assert_eq!(commands[1].jsonrpc, None);
    }

    #[test]
    fn a_uuid_is_version_4() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            let uuid = uuid_v4();
            let groups: Vec<&str> = uuid.split('-').collect();
            let lengths: Vec<usize> = groups.iter().map(|group| group.len()).collect();
            assert_eq!(lengths, [8, 4, 4, 4, 12]);
            assert!(
                uuid.chars()
                    .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)),
                "only hex digits and hyphens"
            );
            assert!(groups[2].starts_with('4'), "version 4");
            assert!(groups[3].starts_with(['8', '9', 'a', 'b']), "variant");
            assert!(seen.insert(uuid));
        }
    }

    #[test]
    fn catalog_items_decode() {
        let metadata: TunnelMetadata = serde_json::from_value(json!({
            "id": "tunnel_ab",
            "catalog_items": [
                {
                    "id": "7c1e",
                    "name": "peekaboo",
                    "command": "/Users/$USER/bins/peekaboo mcp serve",
                    "arguments": ["--root", "$HOME/My Models"],
                    "url": null,
                    "enabled": false,
                },
                // `null` is no arguments, as a missing key is.
                {
                    "id": "91bd",
                    "name": "Notes",
                    "command": null,
                    "arguments": null,
                    "url": "http://127.0.0.1:8080/mcp",
                    "enabled": true,
                },
                // No command and no URL; a field that the client does not
                // know is ignored.
                {"id": "3f02", "name": "eda-agent", "enabled": true, "a_future_field": [7]},
            ],
        }))
        .expect("decodes");
        let item = |id: &str, name: &str| CatalogItem {
            id: id.to_owned(),
            name: name.to_owned(),
            command: None,
            arguments: Vec::new(),
            url: None,
            enabled: true,
        };
        assert_eq!(
            metadata.catalog_items,
            vec![
                CatalogItem {
                    command: Some("/Users/$USER/bins/peekaboo mcp serve".to_owned()),
                    arguments: vec!["--root".to_owned(), "$HOME/My Models".to_owned()],
                    enabled: false,
                    ..item("7c1e", "peekaboo")
                },
                CatalogItem {
                    url: Some("http://127.0.0.1:8080/mcp".to_owned()),
                    ..item("91bd", "Notes")
                },
                item("3f02", "eda-agent"),
            ]
        );
    }

    #[test]
    fn response_body_shapes() {
        let headers = json_content_type();
        let response = TunnelResponse {
            request_id: "r1".to_owned(),
            channel: "7c1e".to_owned(),
            resp_json: Some(json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})),
            resp_headers: headers.clone(),
            resp_code: 200,
            resp_type: ResponseType::JsonrpcResponse,
        };
        assert_eq!(
            serde_json::to_value(&response).expect("serializes"),
            json!({
                "request_id": "r1",
                "channel": "7c1e",
                "resp_json": {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}},
                "resp_headers": {"Content-Type": ["application/json"]},
                "resp_code": 200,
                "resp_type": "jsonrpc_response",
            })
        );

        let ack = TunnelResponse {
            request_id: "r2".to_owned(),
            channel: "7c1e".to_owned(),
            resp_json: None,
            resp_headers: headers,
            resp_code: 202,
            resp_type: ResponseType::NotifyAck,
        };
        assert_eq!(
            serde_json::to_value(&ack).expect("serializes"),
            json!({
                "request_id": "r2",
                "channel": "7c1e",
                "resp_headers": {"Content-Type": ["application/json"]},
                "resp_code": 202,
                "resp_type": "notify_ack",
            })
        );
        assert_eq!(
            serde_json::to_value(ResponseType::JsonrpcNotify).expect("serializes"),
            json!("jsonrpc_notify")
        );
    }

    #[test]
    fn sign_in_answers_decode() {
        let start: SignInStart = serde_json::from_value(json!({
            "id": "s1",
            "deviceCode": "code",
            "userCode": "ABCD-1234",
            "verificationPath": "/devices/approve?id=s1",
            "expiresAt": "2026-11-10T12:10:00Z",
            "interval": 2,
        }))
        .expect("decodes");
        assert_eq!(start.device_code, "code");
        assert_eq!(start.verification_path, "/devices/approve?id=s1");
        // An older Archestra sends no such field: the approval page, as before.
        assert!(!start.approve_in_archestra);
        assert!((start.interval - 2.0).abs() < f64::EPSILON);

        let poll: SignInPoll =
            serde_json::from_value(json!({"status": "approved", "tunnelId": "tunnel_ab"}))
                .expect("decodes");
        assert_eq!(poll.status, SignInStatus::Approved);
        assert_eq!(poll.tunnel_id.as_deref(), Some("tunnel_ab"));

        let poll: SignInPoll =
            serde_json::from_value(json!({"status": "pending"})).expect("decodes");
        assert_eq!(poll.status, SignInStatus::Pending);
        assert_eq!(poll.tunnel_id, None);
    }
}
