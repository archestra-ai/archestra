//! A mock Archestra on 127.0.0.1: the tunnel endpoints (plan 2.2) with a
//! queue in memory, and the sign-in endpoints (plan 2.3). It keeps the state
//! reports of the tunnel client apart from the responses to commands.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use archestra_cli::bridge::config::ControlPlaneConfig;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

pub const TUNNEL_ID: &str = "tunnel_0123456789abcdef0123456789abcdef";
/// 43 base64url characters, as Archestra makes them.
pub const DEVICE_CODE: &str = "dGVzdC1kZXZpY2UtY29kZS0wMTIzNDU2Nzg5YWJjZGU";
pub const DEVICE_KEY: &str = "archestra_dev_dGVzdC1kZXZpY2UtY29kZS0wMTIzNDU2Nzg5YWJjZGU";
/// The reserved channel: its messages are for the tunnel client itself.
pub const BRIDGE_CHANNEL: &str = "archestra-bridge";

/// How long a test waits for something that must happen.
const WAIT: Duration = Duration::from_secs(30);
const STEP: Duration = Duration::from_millis(10);
/// The longest hold of a poll with no work.
const POLL_HOLD: Duration = Duration::from_millis(100);

#[derive(Default)]
struct Inner {
    catalog_items: Vec<Value>,
    /// The key that the tunnel endpoints accept.
    accepted_key: String,
    queue: VecDeque<Value>,
    next_request: u64,
    /// Accepted responses by `request_id`.
    responses: HashMap<String, Value>,
    /// How many response POSTs came for each `request_id`.
    response_posts: HashMap<String, u32>,
    /// The next response POSTs get these statuses, in this order.
    response_failures: VecDeque<StatusCode>,
    /// The bodies of the accepted `jsonrpc_notify` POSTs: the state reports.
    state_reports: Vec<Value>,
    /// The next state reports get this status, one for each POST.
    state_report_failures: VecDeque<StatusCode>,
    /// The tunnel data endpoint answers with this status.
    metadata_failure: Option<StatusCode>,
    /// `X-Tunnel-MCP-Server-Info` of the last poll, parsed.
    server_info: Option<Value>,
    /// The query of the last poll.
    poll_query: HashMap<String, String>,
    /// The client headers of the last poll.
    poll_client: Option<(String, String)>,
    metadata_calls: u32,
    /// `program` of the tunnel data: the program that Archestra serves.
    program: Option<Value>,
    /// The file of that program, as the download gives it.
    program_file: Option<Vec<u8>>,
    /// The targets that a download asked for.
    program_downloads: Vec<String>,
    /// The target and the SHA-256 that the last tunnel data request named.
    metadata_program_headers: Option<(String, String)>,
    /// How many times the device asked to be removed, with a key that was
    /// accepted.
    device_removals: u32,
    /// The removal of the device answers with this status.
    device_removal_failure: Option<StatusCode>,
    sign_in_starts: Vec<Value>,
    sign_in_polls: u32,
}

type Shared = Arc<Mutex<Inner>>;

pub struct MockControlPlane {
    pub base_url: String,
    inner: Shared,
}

impl MockControlPlane {
    pub async fn start() -> Self {
        let inner: Shared = Arc::new(Mutex::new(Inner {
            accepted_key: DEVICE_KEY.to_owned(),
            ..Inner::default()
        }));
        let app = Router::new()
            .route(
                "/v1/tunnels/{tunnel_id}",
                get(metadata).delete(remove_device),
            )
            .route("/v1/tunnels/{tunnel_id}/poll", get(poll))
            .route("/v1/tunnels/{tunnel_id}/response", post(response))
            .route("/api/archestra-cli/{target}", get(download_program))
            .route("/api/desktop-devices/sign-in", post(sign_in_start))
            .route("/api/desktop-devices/sign-in/poll", post(sign_in_poll))
            .with_state(Arc::clone(&inner));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("the mock serves");
        });
        Self {
            base_url: format!("http://{address}"),
            inner,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("the mock state")
    }

    pub fn control_plane_config(&self) -> ControlPlaneConfig {
        ControlPlaneConfig {
            base_url: self.base_url.clone(),
            tunnel_id: TUNNEL_ID.to_owned(),
            api_key: DEVICE_KEY.to_owned(),
        }
    }

    /// The `catalog_items` of the tunnel data, as Archestra sends them.
    pub fn set_catalog_items(&self, items: Value) {
        self.lock().catalog_items = items.as_array().expect("an array of items").clone();
    }

    /// From now on, Archestra serves a program with these bytes. The tunnel
    /// data name `sha256` for it (the real one, or another to test a wrong
    /// download), `version` and `auto_update`.
    pub fn serve_program(
        &self,
        file: &[u8],
        sha256: &str,
        version: Option<&str>,
        auto_update: bool,
    ) {
        let mut inner = self.lock();
        inner.program_file = Some(file.to_vec());
        inner.program = Some(json!({
            "version": version,
            "sha256": sha256,
            "auto_update": auto_update,
        }));
    }

    /// The targets that the downloads of the program asked for.
    pub fn program_downloads(&self) -> Vec<String> {
        self.lock().program_downloads.clone()
    }

    /// The target and the SHA-256 that the last sync named for its program.
    pub fn metadata_program_headers(&self) -> Option<(String, String)> {
        self.lock().metadata_program_headers.clone()
    }

    /// From now on, the tunnel data endpoint answers with this status.
    /// `None`: it works again.
    pub fn fail_tunnel_data(&self, status: Option<StatusCode>) {
        self.lock().metadata_failure = status;
    }

    /// From now on, the removal of the device answers with this status.
    pub fn fail_device_removal(&self, status: StatusCode) {
        self.lock().device_removal_failure = Some(status);
    }

    /// How many times Archestra removed the device.
    pub fn device_removals(&self) -> u32 {
        self.lock().device_removals
    }

    /// From now on, the tunnel endpoints answer `401`.
    pub fn reject_the_key(&self) {
        self.lock().accepted_key = "no key is valid".to_owned();
    }

    /// Puts commands in the queue. One poll takes all of them.
    pub fn enqueue(&self, commands: &[(&str, Value, Option<&str>)]) -> Vec<String> {
        let mut inner = self.lock();
        commands
            .iter()
            .map(|(channel, jsonrpc, response_timeout)| {
                inner.next_request += 1;
                let request_id = format!("req-{}", inner.next_request);
                let mut command = json!({
                    "request_id": request_id,
                    "command_type": "jsonrpc",
                    "channel": channel,
                    "created_at": "2026-11-10T12:00:00Z",
                    "headers": {},
                    "jsonrpc": jsonrpc,
                });
                if let Some(response_timeout) = response_timeout {
                    command["response_timeout"] = json!(response_timeout);
                }
                inner.queue.push_back(command);
                request_id
            })
            .collect()
    }

    /// The next response POSTs fail with these statuses, one for each POST.
    pub fn fail_next_responses(&self, statuses: &[StatusCode]) {
        self.lock().response_failures.extend(statuses);
    }

    pub fn response_posts(&self, request_id: &str) -> u32 {
        self.lock()
            .response_posts
            .get(request_id)
            .copied()
            .unwrap_or_default()
    }

    pub fn has_response(&self, request_id: &str) -> bool {
        self.lock().responses.contains_key(request_id)
    }

    /// Waits for the response POST of a command and gives its body.
    pub async fn response(&self, request_id: &str) -> Value {
        self.wait_for(&format!("the response of {request_id}"), |inner| {
            inner.responses.get(request_id).cloned()
        })
        .await
    }

    /// Sends one JSON-RPC message through the tunnel and gives the response
    /// body that the client posts.
    pub async fn call(&self, channel: &str, jsonrpc: Value) -> Value {
        let ids = self.enqueue(&[(channel, jsonrpc, Some("60s"))]);
        self.response(&ids[0]).await
    }

    /// Sends one request to the tunnel client itself and gives the JSON-RPC
    /// response that the client posts.
    pub async fn control(&self, method: &str, params: Value) -> Value {
        let request =
            json!({"jsonrpc": "2.0", "id": "control", "method": method, "params": params});
        let response = self.call(BRIDGE_CHANNEL, request).await;
        assert_eq!(response["channel"], json!(BRIDGE_CHANNEL), "{response}");
        assert_eq!(
            response["resp_type"],
            json!("jsonrpc_response"),
            "{response}"
        );
        assert_eq!(response["resp_code"], json!(200), "{response}");
        assert_eq!(response["resp_json"]["id"], json!("control"), "{response}");
        response["resp_json"].clone()
    }

    /// The next state reports fail with these statuses, one for each POST.
    pub fn fail_next_state_reports(&self, statuses: &[StatusCode]) {
        self.lock().state_report_failures.extend(statuses);
    }

    /// Waits until each failure of [`Self::fail_next_state_reports`] was the
    /// answer to a state report.
    pub async fn wait_until_no_state_report_failures(&self) {
        self.wait_for("the state reports that fail", |inner| {
            inner.state_report_failures.is_empty().then_some(())
        })
        .await;
    }

    /// The bodies of the state reports that came, the oldest first.
    pub fn state_reports(&self) -> Vec<Value> {
        self.lock().state_reports.clone()
    }

    /// Waits for a state report after the first `skip` whose `params` pass
    /// the check, and gives its `params`.
    pub async fn state_report_after(
        &self,
        skip: usize,
        what: &str,
        mut check: impl FnMut(&Value) -> bool,
    ) -> Value {
        self.wait_for(&format!("a state report: {what}"), |inner| {
            inner
                .state_reports
                .iter()
                .skip(skip)
                .map(|report| &report["resp_json"]["params"])
                .find(|params| check(params))
                .cloned()
        })
        .await
    }

    /// Waits for a state report in which the server of `channel` has
    /// `state`, and gives the `params` of the report.
    pub async fn state_report_with(&self, channel: &str, state: &str) -> Value {
        self.state_report_after(0, &format!("{channel} is {state}"), |params| {
            server_of(params, channel).is_some_and(|server| server["state"] == json!(state))
        })
        .await
    }

    /// Waits until a poll reports exactly these channels as ready.
    pub async fn wait_for_ready_channels(&self, channels: &[&str]) {
        let mut expected: Vec<&str> = channels.to_vec();
        expected.sort_unstable();
        self.wait_for(&format!("ready channels {expected:?}"), |inner| {
            let reported = inner.server_info.as_ref()?["channels"].as_array()?;
            let mut names: Vec<&str> = reported
                .iter()
                .filter_map(|channel| channel["name"].as_str())
                .collect();
            names.sort_unstable();
            (names == expected).then_some(())
        })
        .await;
    }

    pub fn server_info(&self) -> Option<Value> {
        self.lock().server_info.clone()
    }

    pub fn poll_query(&self) -> HashMap<String, String> {
        self.lock().poll_query.clone()
    }

    pub fn poll_client(&self) -> Option<(String, String)> {
        self.lock().poll_client.clone()
    }

    pub fn metadata_calls(&self) -> u32 {
        self.lock().metadata_calls
    }

    pub fn sign_in_starts(&self) -> Vec<Value> {
        self.lock().sign_in_starts.clone()
    }

    async fn wait_for<T>(&self, what: &str, mut check: impl FnMut(&Inner) -> Option<T>) -> T {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(found) = check(&self.lock()) {
                return found;
            }
            if tokio::time::Instant::now() >= deadline {
                // The last state report has the error of each MCP server
                // that is not ready: it says why the wait failed.
                let last_report = self.lock().state_reports.last().cloned();
                panic!("timed out waiting for {what}; the last state report: {last_report:?}");
            }
            tokio::time::sleep(STEP).await;
        }
    }
}

/// The entry of one channel in the `params` of a state report.
pub fn server_of<'a>(params: &'a Value, channel: &str) -> Option<&'a Value> {
    params["servers"]
        .as_array()?
        .iter()
        .find(|server| server["channel"] == json!(channel))
}

/// `401` for a wrong key, `403` for a tunnel that the key does not own.
fn authorize(inner: &Inner, tunnel_id: &str, headers: &HeaderMap) -> Result<(), StatusCode> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    if authorization != Some(&format!("Bearer {}", inner.accepted_key)) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if tunnel_id != TUNNEL_ID {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

async fn metadata(
    State(inner): State<Shared>,
    Path(tunnel_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let mut inner = inner.lock().expect("the mock state");
    if let Err(status) = authorize(&inner, &tunnel_id, &headers) {
        return status.into_response();
    }
    inner.metadata_calls += 1;
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    inner.metadata_program_headers =
        header("x-tunnel-client-target").zip(header("x-tunnel-client-sha256"));
    if let Some(status) = inner.metadata_failure {
        return status.into_response();
    }
    Json(json!({
        "id": TUNNEL_ID,
        "name": "test-device",
        "description": "",
        "catalog_items": inner.catalog_items,
        "program": inner.program,
    }))
    .into_response()
}

/// The download of the Connect page: no device key.
async fn download_program(State(inner): State<Shared>, Path(target): Path<String>) -> Response {
    let mut inner = inner.lock().expect("the mock state");
    inner.program_downloads.push(target);
    match &inner.program_file {
        Some(file) => file.clone().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn remove_device(
    State(inner): State<Shared>,
    Path(tunnel_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let mut inner = inner.lock().expect("the mock state");
    if let Err(status) = authorize(&inner, &tunnel_id, &headers) {
        return status.into_response();
    }
    if let Some(status) = inner.device_removal_failure {
        return status.into_response();
    }
    inner.device_removals += 1;
    // The key of a removed device is not valid any more.
    inner.accepted_key = "no key is valid".to_owned();
    Json(json!({"status": "ok"})).into_response()
}

async fn poll(
    State(inner): State<Shared>,
    Path(tunnel_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let deadline = tokio::time::Instant::now() + POLL_HOLD;
    loop {
        {
            let mut inner = inner.lock().expect("the mock state");
            if let Err(status) = authorize(&inner, &tunnel_id, &headers) {
                return status.into_response();
            }
            inner.server_info =
                serde_json::from_str(&header(&headers, "x-tunnel-mcp-server-info")).ok();
            inner.poll_query.clone_from(&query);
            inner.poll_client = Some((
                header(&headers, "x-tunnel-client-name"),
                header(&headers, "x-tunnel-client-version"),
            ));
            if !inner.queue.is_empty() {
                let commands: Vec<Value> = inner.queue.drain(..).collect();
                return Json(json!({ "commands": commands })).into_response();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return StatusCode::NO_CONTENT.into_response();
        }
        tokio::time::sleep(STEP).await;
    }
}

async fn response(
    State(inner): State<Shared>,
    Path(tunnel_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let mut inner = inner.lock().expect("the mock state");
    if let Err(status) = authorize(&inner, &tunnel_id, &headers) {
        return status.into_response();
    }
    let Some(request_id) = body["request_id"].as_str().map(str::to_owned) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // A notification of the tunnel client: no command waits for it.
    if body["resp_type"] == json!("jsonrpc_notify") {
        if let Some(status) = inner.state_report_failures.pop_front() {
            return status.into_response();
        }
        inner.state_reports.push(body);
        return Json(json!({"status": "ok"})).into_response();
    }
    *inner.response_posts.entry(request_id.clone()).or_default() += 1;
    if let Some(status) = inner.response_failures.pop_front() {
        return status.into_response();
    }
    inner.responses.insert(request_id, body);
    Json(json!({"status": "ok"})).into_response()
}

async fn sign_in_start(State(inner): State<Shared>, Json(body): Json<Value>) -> Json<Value> {
    // A setup code is known to the mock when it has the right shape.
    let approve_in_archestra = body["setupCode"]
        .as_str()
        .is_some_and(|code| code.len() == 22);
    inner
        .lock()
        .expect("the mock state")
        .sign_in_starts
        .push(body);
    Json(json!({
        "id": "signin-1",
        "deviceCode": DEVICE_CODE,
        "userCode": "ABCD-1234",
        "verificationPath": "/devices/approve?id=signin-1",
        "expiresAt": "2026-11-10T12:10:00Z",
        "interval": 0,
        "approveInArchestra": approve_in_archestra,
    }))
}

/// The first poll is `pending`. The second is `approved`: from then on the
/// tunnel endpoints accept the key of this sign-in.
async fn sign_in_poll(State(inner): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut inner = inner.lock().expect("the mock state");
    if body["deviceCode"] != json!(DEVICE_CODE) {
        return StatusCode::NOT_FOUND.into_response();
    }
    inner.sign_in_polls += 1;
    if inner.sign_in_polls < 2 {
        return Json(json!({"status": "pending"})).into_response();
    }
    inner.accepted_key = DEVICE_KEY.to_owned();
    Json(json!({"status": "approved", "tunnelId": TUNNEL_ID})).into_response()
}
