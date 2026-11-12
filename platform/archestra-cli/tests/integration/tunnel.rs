//! The run loop against the mock Archestra and the test MCP servers.

use std::time::Duration;

use archestra_cli::bridge::BridgeStatus;
use archestra_cli::bridge::config::McpConfig;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{
    Bridge, HttpFixture, TestDir, command_entry, free_port, kill, server_pid, tool_text,
    tools_call, url_entry, wait_until_gone,
};
use crate::mock_control_plane::MockControlPlane;

const FILES: &str = "7c1e0000-0000-4000-8000-00000000a094";
const NOT_CONFIGURED: &str = "3f020000-0000-4000-8000-00000000b061";
const NOTES: &str = "91bd0000-0000-4000-8000-00000000c007";

/// A mock Archestra and a client with the stdio test server on one channel.
async fn start_with_stdio_server() -> (MockControlPlane, TestDir, Bridge) {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mcp = McpConfig {
        commands: vec![command_entry(FILES, &dir.stdio_command())],
        server_urls: Vec::new(),
    };
    let bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES]).await;
    (mock, dir, bridge)
}

#[tokio::test]
async fn a_polled_initialize_is_answered_from_the_kept_result() {
    let (mock, _dir, _bridge) = start_with_stdio_server().await;

    // Two MCP sessions of the backend. The test server takes only one
    // `initialize` (the one of the client) and answers a second one with an
    // error, so these answers do not come from the server.
    for id in [json!(0), json!("session-b")] {
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "archestra", "version": "1"},
            },
        });
        let response = mock.call(FILES, initialize).await;
        assert_eq!(response["resp_type"], json!("jsonrpc_response"));
        assert_eq!(response["resp_code"], json!(200));
        assert_eq!(response["channel"], json!(FILES));
        assert_eq!(
            response["resp_headers"],
            json!({"Content-Type": ["application/json"]})
        );
        assert_eq!(
            response["resp_json"],
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "files-stdio", "version": "1.0.0"},
                },
            })
        );
    }

    let response = mock
        .call(
            FILES,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;
    assert_eq!(response["resp_type"], json!("notify_ack"));
    assert_eq!(response.get("resp_json"), None);

    // The session still works after these.
    let response = mock
        .call(FILES, json!({"jsonrpc": "2.0", "id": 9, "method": "ping"}))
        .await;
    assert_eq!(
        response["resp_json"],
        json!({"jsonrpc": "2.0", "id": 9, "result": {}})
    );
}

#[tokio::test]
async fn tools_list_goes_to_the_server() {
    let (mock, _dir, _bridge) = start_with_stdio_server().await;

    let response = mock
        .call(
            FILES,
            json!({"jsonrpc": "2.0", "id": "list-1", "method": "tools/list", "params": {}}),
        )
        .await;
    assert_eq!(response["resp_code"], json!(200));
    assert_eq!(response["resp_json"]["id"], json!("list-1"));
    let names: Vec<&str> = response["resp_json"]["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names, vec!["write_file", "read_file", "list_files"]);
}

#[tokio::test]
async fn tools_call_writes_a_file_on_the_device_and_reads_it_back() {
    let (mock, dir, _bridge) = start_with_stdio_server().await;

    let write = tools_call(
        json!(1),
        "write_file",
        json!({"path": "notes/hello.txt", "content": "hello from the agent"}),
    );
    let response = mock.call(FILES, write).await;
    assert_eq!(response["resp_json"]["id"], json!(1));
    assert_eq!(
        tool_text(&response),
        "wrote 20 characters to notes/hello.txt"
    );
    let on_disk = std::fs::read_to_string(dir.root().join("notes/hello.txt"))
        .expect("the file exists in the temp folder of the test");
    assert_eq!(on_disk, "hello from the agent");

    let read = tools_call(json!(2), "read_file", json!({"path": "notes/hello.txt"}));
    let response = mock.call(FILES, read).await;
    assert_eq!(response["resp_json"]["id"], json!(2));
    assert_eq!(tool_text(&response), "hello from the agent");

    let list = tools_call(json!(3), "list_files", json!({}));
    assert_eq!(tool_text(&mock.call(FILES, list).await), "notes/hello.txt");
}

#[tokio::test]
async fn a_path_outside_the_root_is_refused_as_a_tool_error() {
    let (mock, dir, _bridge) = start_with_stdio_server().await;

    let write = tools_call(
        json!(1),
        "write_file",
        json!({"path": "../escaped.txt", "content": "no"}),
    );
    let response = mock.call(FILES, write).await;
    // A tool error is a normal MCP answer: the client passes it on.
    assert_eq!(response["resp_code"], json!(200));
    assert_eq!(response["resp_json"]["result"]["isError"], json!(true));
    assert!(!dir.root().with_file_name("escaped.txt").exists());

    // The server did not crash.
    let read = tools_call(json!(2), "list_files", json!({}));
    assert_eq!(tool_text(&mock.call(FILES, read).await), "");
}

#[tokio::test]
async fn two_calls_in_flight_get_the_answers_with_their_own_ids() {
    let (mock, dir, _bridge) = start_with_stdio_server().await;

    // One poll gives both commands, so both are in work at the same time.
    let ids = mock.enqueue(&[
        (
            FILES,
            tools_call(
                json!("call-a"),
                "write_file",
                json!({"path": "a.txt", "content": "A"}),
            ),
            Some("60s"),
        ),
        (
            FILES,
            tools_call(
                json!(77),
                "write_file",
                json!({"path": "b.txt", "content": "BB"}),
            ),
            Some("60s"),
        ),
    ]);
    let first = mock.response(&ids[0]).await;
    let second = mock.response(&ids[1]).await;
    assert_eq!(first["resp_json"]["id"], json!("call-a"));
    assert_eq!(tool_text(&first), "wrote 1 characters to a.txt");
    assert_eq!(second["resp_json"]["id"], json!(77));
    assert_eq!(tool_text(&second), "wrote 2 characters to b.txt");
    assert_eq!(
        std::fs::read_to_string(dir.root().join("a.txt"))
            .ok()
            .as_deref(),
        Some("A")
    );
    assert_eq!(
        std::fs::read_to_string(dir.root().join("b.txt"))
            .ok()
            .as_deref(),
        Some("BB")
    );

    // Two MCP sessions of the backend can use the same JSON-RPC id at the
    // same time. Each command still gets its own answer.
    let ids = mock.enqueue(&[
        (
            FILES,
            tools_call(json!(1), "read_file", json!({"path": "a.txt"})),
            Some("60s"),
        ),
        (
            FILES,
            tools_call(json!(1), "read_file", json!({"path": "b.txt"})),
            Some("60s"),
        ),
    ]);
    let first = mock.response(&ids[0]).await;
    let second = mock.response(&ids[1]).await;
    assert_eq!(first["resp_json"]["id"], json!(1));
    assert_eq!(tool_text(&first), "A");
    assert_eq!(second["resp_json"]["id"], json!(1));
    assert_eq!(tool_text(&second), "BB");
}

fn assert_tunnel_failure(response: &Value, id: &Value) {
    assert_eq!(response["resp_type"], json!("jsonrpc_response"));
    assert_eq!(response["resp_code"], json!(502));
    assert_eq!(
        response["resp_json"],
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32603,
                "message": "MCP bridge: no MCP server runs for this catalog item on the device; see its state on the Device tab of Personal Settings in Archestra",
                "data": {"tunnel_failure": {
                    "version": 1,
                    "source": "transport_closed",
                    "upstream_response_received": false,
                }},
            },
        })
    );
}

#[tokio::test]
async fn a_command_for_a_channel_with_no_server_gets_the_502_error() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mcp = McpConfig {
        commands: vec![
            command_entry(FILES, &dir.stdio_command()),
            command_entry(NOT_CONFIGURED, ""),
        ],
        server_urls: Vec::new(),
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES]).await;

    let list = json!({"jsonrpc": "2.0", "id": "x-1", "method": "tools/list"});
    // A channel that is not in the config file at all.
    let response = mock.call("no-such-channel", list.clone()).await;
    assert_eq!(response["channel"], json!("no-such-channel"));
    assert_tunnel_failure(&response, &json!("x-1"));
    // A channel with an empty command.
    let response = mock.call(NOT_CONFIGURED, list).await;
    assert_tunnel_failure(&response, &json!("x-1"));
    // `initialize` has no kept result to answer from.
    let initialize = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}});
    let response = mock.call(NOT_CONFIGURED, initialize).await;
    assert_tunnel_failure(&response, &json!(0));
}

#[tokio::test]
async fn a_killed_server_is_started_again() {
    let (mock, dir, _bridge) = start_with_stdio_server().await;
    let write = tools_call(
        json!(1),
        "write_file",
        json!({"path": "kept.txt", "content": "before the kill"}),
    );
    tool_text(&mock.call(FILES, write).await);

    let first_pid = server_pid(&dir, None).await;
    kill(first_pid);
    // The client starts the program again: a new process writes its id.
    let second_pid = server_pid(&dir, Some(first_pid)).await;
    assert_ne!(first_pid, second_pid);

    // While the new process starts, a call gets the 502 error. A later call
    // succeeds.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let response = loop {
        let read = tools_call(json!(2), "read_file", json!({"path": "kept.txt"}));
        let response = mock.call(FILES, read).await;
        if response["resp_code"] == json!(200) {
            break response;
        }
        assert_tunnel_failure(&response, &json!(2));
        assert!(
            tokio::time::Instant::now() < deadline,
            "the server did not come back"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(response["resp_json"]["id"], json!(2));
    assert_eq!(tool_text(&response), "before the kill");
    mock.wait_for_ready_channels(&[FILES]).await;
}

#[tokio::test]
async fn an_http_server_is_reached_through_server_urls() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let mcp = McpConfig {
        commands: Vec::new(),
        server_urls: vec![url_entry(NOTES, &fixture.url("/mcp"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[NOTES]).await;

    let initialize = json!({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}});
    let response = mock.call(NOTES, initialize).await;
    assert_eq!(response["resp_json"]["id"], json!("init"));
    assert_eq!(
        response["resp_json"]["result"]["serverInfo"]["name"],
        json!("files-http")
    );

    let write = tools_call(
        json!("w"),
        "write_file",
        json!({"path": "http.txt", "content": "over HTTP"}),
    );
    let response = mock.call(NOTES, write).await;
    assert_eq!(response["resp_json"]["id"], json!("w"));
    assert_eq!(tool_text(&response), "wrote 9 characters to http.txt");
    assert_eq!(
        std::fs::read_to_string(dir.root().join("http.txt"))
            .ok()
            .as_deref(),
        Some("over HTTP")
    );

    let read = tools_call(json!(5), "read_file", json!({"path": "http.txt"}));
    let response = mock.call(NOTES, read).await;
    assert_eq!(response["resp_json"]["id"], json!(5));
    assert_eq!(tool_text(&response), "over HTTP");

    // A notification that is forwarded: the server answers `202`, the client
    // acknowledges.
    let changed = json!({"jsonrpc": "2.0", "method": "notifications/roots/list_changed"});
    let response = mock.call(NOTES, changed).await;
    assert_eq!(response["resp_type"], json!("notify_ack"));
    assert_eq!(response.get("resp_json"), None);
}

#[tokio::test]
async fn an_http_server_can_answer_with_an_sse_stream() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let mcp = McpConfig {
        commands: Vec::new(),
        server_urls: vec![url_entry(NOTES, &fixture.url("/sse"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[NOTES]).await;

    let write = tools_call(
        json!("sse-1"),
        "write_file",
        json!({"path": "sse.txt", "content": "stream"}),
    );
    let response = mock.call(NOTES, write).await;
    assert_eq!(response["resp_json"]["id"], json!("sse-1"));
    assert_eq!(tool_text(&response), "wrote 6 characters to sse.txt");
    assert!(dir.root().join("sse.txt").exists());
}

#[tokio::test]
async fn an_http_server_that_starts_later_or_stops_changes_the_ready_state() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let port = free_port();
    let mcp = McpConfig {
        commands: Vec::new(),
        server_urls: vec![url_entry(NOTES, &format!("http://127.0.0.1:{port}/mcp"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);

    // The user did not start the server yet.
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    let response = mock.call(NOTES, list.clone()).await;
    assert_eq!(response["resp_code"], json!(502));
    assert_eq!(
        mock.server_info(),
        Some(json!({"version": 1, "channels": []}))
    );

    let fixture = HttpFixture::start_on(&dir.root(), port);
    mock.wait_for_ready_channels(&[NOTES]).await;
    assert_eq!(
        mock.call(NOTES, list.clone()).await["resp_code"],
        json!(200)
    );

    // The server stops. The next call fails, and the channel is not ready.
    drop(fixture);
    let response = mock.call(NOTES, list).await;
    assert_eq!(response["resp_code"], json!(502));
    assert_eq!(
        response["resp_json"]["error"]["data"]["tunnel_failure"]["source"],
        json!("connect")
    );
    mock.wait_for_ready_channels(&[]).await;
}

#[tokio::test]
async fn an_http_server_that_restarts_gets_a_new_session() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let port = fixture.port;
    let mcp = McpConfig {
        commands: Vec::new(),
        server_urls: vec![url_entry(NOTES, &fixture.url("/mcp"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[NOTES]).await;

    // The new process does not know the MCP session of the client: it
    // answers `404`. The client does `initialize` again.
    drop(fixture);
    let _fixture = HttpFixture::start_on(&dir.root(), port);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let list = tools_call(json!("after"), "list_files", json!({}));
        let response = mock.call(NOTES, list).await;
        if response["resp_code"] == json!(200) {
            assert_eq!(response["resp_json"]["id"], json!("after"));
            break;
        }
        assert_eq!(response["resp_code"], json!(502), "{response}");
        assert_eq!(response["resp_json"]["error"]["code"], json!(-32603));
        assert!(
            tokio::time::Instant::now() < deadline,
            "the client did not connect again"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn the_poll_reports_exactly_the_ready_channels() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let mcp = McpConfig {
        commands: vec![
            command_entry(FILES, &dir.stdio_command()),
            command_entry(NOT_CONFIGURED, ""),
            command_entry("broken-quote", "python3 'open"),
            command_entry("no-such-program", "/nonexistent/archestra-test-mcp-server"),
            command_entry("in-both-lists", &dir.stdio_command()),
        ],
        server_urls: vec![
            url_entry(NOTES, &fixture.url("/mcp")),
            url_entry("in-both-lists", &fixture.url("/mcp")),
        ],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES, NOTES]).await;

    assert_eq!(
        mock.server_info(),
        Some(json!({
            "version": 1,
            "channels": [
                {"name": FILES, "proc_affinity": true},
                {"name": NOTES, "proc_affinity": true},
            ],
        }))
    );
    let query = mock.poll_query();
    assert_eq!(query.get("limit").map(String::as_str), Some("25"));
    assert_eq!(query.get("timeout_ms").map(String::as_str), Some("500"));
    assert_eq!(
        mock.poll_client(),
        Some((
            "archestra-mcp-bridge".to_owned(),
            env!("CARGO_PKG_VERSION").to_owned()
        ))
    );

    // The channel that is in both lists has no server.
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    assert_eq!(
        mock.call("in-both-lists", list).await["resp_code"],
        json!(502)
    );
}

#[tokio::test]
async fn a_command_whose_deadline_passed_gets_no_response() {
    let (mock, _dir, _bridge) = start_with_stdio_server().await;

    let ping = |id: u32| json!({"jsonrpc": "2.0", "id": id, "method": "ping"});
    let ids = mock.enqueue(&[
        (FILES, ping(1), Some("0s")),
        (FILES, ping(2), Some("60s")),
        // Not valid: no deadline, as in the OpenAI client.
        (FILES, ping(3), Some("soon")),
        (FILES, ping(4), None),
    ]);
    for id in &ids[1..] {
        assert_eq!(mock.response(id).await["resp_code"], json!(200));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!mock.has_response(&ids[0]));
    assert_eq!(mock.response_posts(&ids[0]), 0);
}

#[tokio::test]
async fn a_response_post_is_retried_after_a_transient_failure() {
    let (mock, _dir, _bridge) = start_with_stdio_server().await;

    mock.fail_next_responses(&[StatusCode::SERVICE_UNAVAILABLE, StatusCode::BAD_GATEWAY]);
    let ids = mock.enqueue(&[(
        FILES,
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
        Some("60s"),
    )]);
    assert_eq!(mock.response(&ids[0]).await["resp_code"], json!(200));
    assert_eq!(mock.response_posts(&ids[0]), 3);
}

#[tokio::test]
async fn a_response_post_that_gets_404_is_not_retried() {
    let (mock, _dir, _bridge) = start_with_stdio_server().await;

    mock.fail_next_responses(&[StatusCode::NOT_FOUND]);
    let ids = mock.enqueue(&[(
        FILES,
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
        Some("60s"),
    )]);
    // A later command shows that the client went on.
    let later = mock
        .call(FILES, json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}))
        .await;
    assert_eq!(later["resp_code"], json!(200));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(mock.response_posts(&ids[0]), 1);
    assert!(!mock.has_response(&ids[0]));
}

#[tokio::test]
async fn a_rejected_key_stops_the_polling_with_the_signed_out_status() {
    let (mock, dir, mut bridge) = start_with_stdio_server().await;
    bridge.wait_for_status(BridgeStatus::Connected).await;
    let pid = server_pid(&dir, None).await;

    mock.reject_the_key();
    bridge.wait_for_status(BridgeStatus::SignedOut).await;

    // No more polls: a command stays in the queue.
    let ids = mock.enqueue(&[(
        FILES,
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
        None,
    )]);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!mock.has_response(&ids[0]));
    assert_eq!(bridge.state().status, BridgeStatus::SignedOut);
    // The MCP server of the signed-out device is stopped.
    wait_until_gone(pid).await;
    assert_eq!(bridge.state().servers, Vec::new());
}
