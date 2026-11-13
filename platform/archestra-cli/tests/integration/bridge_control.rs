//! The sync of the config file, the requests of Archestra to the tunnel
//! client itself (the reserved channel), and the state report.

use std::time::Duration;

use archestra_cli::bridge::config::{Config, McpConfig};
use archestra_cli::bridge::{
    Backoff, BridgeStatus, RunOptions, ServerState, StartOptions, Timings,
};
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{
    Bridge, HttpFixture, TestDir, command_entry, kill, pid_in, server_pid, timings, tool_text,
    tools_call, url_entry, wait_until_gone,
};
use crate::mock_control_plane::{BRIDGE_CHANNEL, MockControlPlane, server_of};

const FILES: &str = "7c1e0000-0000-4000-8000-00000000a094";
const NOT_CONFIGURED: &str = "3f020000-0000-4000-8000-00000000b061";
const NOTES: &str = "91bd0000-0000-4000-8000-00000000c007";
const STOPPED: &str = "aa110000-0000-4000-8000-00000000d00d";

/// A catalog item as Archestra sends it, with a command.
fn command_item(id: &str, command: &str) -> Value {
    json!({
        "id": id,
        "name": format!("{id} name"),
        "command": command,
        "url": null,
        "enabled": true,
    })
}

fn no_servers() -> McpConfig {
    McpConfig::default()
}

fn one_stdio_server(dir: &TestDir) -> McpConfig {
    McpConfig {
        commands: vec![command_entry(FILES, &dir.stdio_command())],
        server_urls: Vec::new(),
    }
}

fn load(dir: &TestDir) -> Config {
    Config::load(&dir.config_path())
        .expect("load")
        .expect("the config file exists")
}

fn error_of(response: &Value) -> (i64, &str) {
    let error = &response["error"];
    (
        error["code"].as_i64().expect("an error code"),
        error["message"].as_str().expect("an error message"),
    )
}

#[tokio::test]
async fn a_start_with_no_connection_runs_the_servers_of_the_config_file() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut config = Config {
        control_plane: mock.control_plane_config(),
        synced_at: Some("2026-11-10T12:00:00Z".to_owned()),
        mcp: one_stdio_server(&dir),
    };
    // Nothing listens on port 9 of this computer.
    config.control_plane.base_url = "http://127.0.0.1:9".to_owned();
    config.save(&dir.config_path()).expect("save");

    let prepared = archestra_cli::bridge::prepare(&StartOptions {
        url: None,
        config_path: dir.config_path(),
        open_browser: false,
        setup_code: None,
    })
    .await
    .expect("prepare");
    assert!(prepared.sync.failed);
    assert_eq!(prepared.config, config);

    let mut bridge = Bridge::run(RunOptions {
        config_path: dir.config_path(),
        control_plane: prepared.config.control_plane,
        timings: timings(),
        sync: prepared.sync,
        update: prepared.update,
        auto_update: None,
    });
    bridge
        .wait_for_server_state(FILES, &ServerState::Running)
        .await;
    server_pid(&dir, None).await;
    bridge.wait_for_status(BridgeStatus::Disconnected).await;

    // The state: the sync failed, and the time of the last good sync.
    let state = bridge.state();
    assert!(state.sync.failed);
    assert_eq!(state.sync.synced_at, config.last_sync());
    assert!(state.sync.synced_at.is_some());
    assert_eq!(mock.metadata_calls(), 0);
}

#[tokio::test]
async fn an_entry_that_is_off_is_stopped() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut stopped = command_entry(STOPPED, &dir.stdio_command());
    stopped.enabled = false;
    let mcp = McpConfig {
        commands: vec![stopped, command_entry(NOT_CONFIGURED, "")],
        server_urls: vec![url_entry(NOTES, "http://127.0.0.1:9/mcp")],
    };
    let mut bridge = Bridge::start(&mock, &dir, mcp);

    bridge
        .wait_for_server_state(STOPPED, &ServerState::Stopped)
        .await;
    let report = mock.state_report_with(STOPPED, "stopped").await;
    assert_eq!(
        server_of(&report, STOPPED),
        Some(&json!({"channel": STOPPED, "state": "stopped", "error": null}))
    );

    // No process was started, and a call gets the "no MCP server" error.
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    assert_eq!(mock.call(STOPPED, list).await["resp_code"], json!(502));
    assert!(!dir.pid_file().exists());
    mock.wait_for_ready_channels(&[]).await;
}

#[tokio::test]
async fn a_sync_request_replaces_the_entries_and_the_servers_follow() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut bridge = Bridge::start(&mock, &dir, no_servers());
    bridge.wait_for_status(BridgeStatus::Connected).await;
    assert_eq!(bridge.state().sync.synced_at, None);

    // Archestra has two catalog items for the device now.
    mock.set_catalog_items(json!([
        command_item(FILES, &dir.stdio_command()),
        {"id": NOT_CONFIGURED, "name": "no command yet", "enabled": true},
    ]));
    let response = mock.control("bridge/sync", Value::Null).await;
    assert_eq!(response["result"], json!({}), "{response}");

    mock.wait_for_ready_channels(&[FILES]).await;
    let first_pid = server_pid(&dir, None).await;
    let config = load(&dir);
    assert_eq!(config.mcp.commands.len(), 2);
    assert_eq!(config.mcp.commands[0].command, dir.stdio_command());
    assert_eq!(config.mcp.commands[1].name, "no command yet");
    let state = bridge.state();
    assert!(!state.sync.failed);
    assert_eq!(state.sync.synced_at, config.last_sync());
    assert!(state.sync.synced_at.is_some());
    // A state report follows the sync.
    let report = mock.state_report_with(FILES, "running").await;
    assert_eq!(
        server_of(&report, NOT_CONFIGURED),
        Some(&json!({"channel": NOT_CONFIGURED, "state": "no_command", "error": null}))
    );

    // A new command: the MCP server starts again with it.
    mock.set_catalog_items(json!([
        command_item(FILES, &dir.stdio_command_with_log()),
        {"id": NOT_CONFIGURED, "name": "no command yet", "enabled": true},
    ]));
    let response = mock.control("bridge/sync", json!({})).await;
    assert_eq!(response["result"], json!({}), "{response}");
    let second_pid = server_pid(&dir, Some(first_pid)).await;
    wait_until_gone(first_pid).await;
    assert_eq!(
        load(&dir).mcp.commands[0].command,
        dir.stdio_command_with_log()
    );

    // The user stops the MCP server in Archestra.
    let mut stopped = command_item(FILES, &dir.stdio_command_with_log());
    stopped["enabled"] = json!(false);
    mock.set_catalog_items(json!([stopped]));
    mock.control("bridge/sync", Value::Null).await;
    bridge
        .wait_for_server_state(FILES, &ServerState::Stopped)
        .await;
    wait_until_gone(second_pid).await;
    mock.wait_for_ready_channels(&[]).await;
    // The entry that Archestra does not list any more is gone.
    let channels: Vec<String> = bridge
        .state()
        .servers
        .into_iter()
        .map(|server| server.channel)
        .collect();
    assert_eq!(channels, [FILES]);
    mock.state_report_with(FILES, "stopped").await;

    // Archestra lists no catalog item: no entry stays.
    mock.set_catalog_items(json!([]));
    mock.control("bridge/sync", Value::Null).await;
    bridge
        .wait_for_state("no servers", |state| state.servers.is_empty())
        .await;
    assert_eq!(load(&dir).mcp, McpConfig::default());
}

#[tokio::test]
async fn the_arguments_of_the_user_reach_the_server_and_a_change_starts_it_again() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut bridge = Bridge::start(&mock, &dir, no_servers());
    bridge.wait_for_status(BridgeStatus::Connected).await;

    // The command of the admin has no options. The user adds the pid file:
    // its path has a space and stays one argument.
    let pid_file = dir.root().join("the server.pid");
    let pid_path = pid_file.display().to_string();
    let items = |arguments: Value| {
        let mut item = command_item(FILES, &dir.stdio_command_with_no_options());
        item["arguments"] = arguments;
        json!([item])
    };
    mock.set_catalog_items(items(json!(["--pid-file", pid_path])));
    let response = mock.control("bridge/sync", Value::Null).await;
    assert_eq!(response["result"], json!({}), "{response}");
    mock.wait_for_ready_channels(&[FILES]).await;
    let first_pid = pid_in(&pid_file, None).await;
    assert_eq!(
        load(&dir).mcp.commands[0].arguments,
        ["--pid-file".to_owned(), pid_path.clone()]
    );
    assert_eq!(
        load(&dir).mcp.commands[0].command,
        dir.stdio_command_with_no_options()
    );

    // A sync with the same arguments does not write the file, and the MCP
    // server runs on.
    let written = |dir: &TestDir| {
        std::fs::metadata(dir.config_path())
            .and_then(|metadata| metadata.modified())
            .expect("the config file")
    };
    let written_at = written(&dir);
    mock.control("bridge/sync", Value::Null).await;
    tokio::time::sleep(timings().config_check_interval * 4).await;
    assert_eq!(written(&dir), written_at);
    assert_eq!(pid_in(&pid_file, None).await, first_pid);

    // One more argument: the MCP server starts again with all of them.
    mock.set_catalog_items(items(json!(["--pid-file", pid_path, "--log-to-stderr"])));
    mock.control("bridge/sync", Value::Null).await;
    let second_pid = pid_in(&pid_file, Some(first_pid)).await;
    wait_until_gone(first_pid).await;
    mock.wait_for_ready_channels(&[FILES]).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let response = mock
            .control("bridge/server/log", json!({"channel": FILES}))
            .await;
        let lines = response["result"]["lines"].as_array().cloned();
        if lines.is_some_and(|lines| lines.contains(&json!("files server started"))) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the log did not come: {response}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The user removes the arguments: Archestra sends an empty list, the
    // file has no `arguments` key, and the MCP server starts again.
    mock.set_catalog_items(items(json!([])));
    mock.control("bridge/sync", Value::Null).await;
    wait_until_gone(second_pid).await;
    mock.wait_for_ready_channels(&[FILES]).await;
    assert!(load(&dir).mcp.commands[0].arguments.is_empty());
    let text = std::fs::read_to_string(dir.config_path()).expect("the config file");
    assert!(!text.contains("arguments:"), "{text}");
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    assert_eq!(mock.call(FILES, list).await["resp_code"], json!(200));
}

#[tokio::test]
async fn a_sync_that_fails_keeps_the_file_and_the_servers() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let bridge = Bridge::start(&mock, &dir, one_stdio_server(&dir));
    mock.wait_for_ready_channels(&[FILES]).await;
    let pid = server_pid(&dir, None).await;

    // A good sync, to have the time of one.
    mock.set_catalog_items(json!([command_item(FILES, &dir.stdio_command())]));
    mock.control("bridge/sync", Value::Null).await;
    let synced_at = bridge.state().sync.synced_at;
    assert!(synced_at.is_some());
    let file_before = std::fs::read_to_string(dir.config_path()).expect("read");

    mock.set_catalog_items(json!([]));
    mock.fail_tunnel_data(Some(StatusCode::INTERNAL_SERVER_ERROR));
    let response = mock.control("bridge/sync", Value::Null).await;
    assert_eq!(response.get("result"), None, "{response}");
    assert_eq!(
        error_of(&response),
        (
            -32603,
            "could not get the config from Archestra: Archestra answered with HTTP status 500"
        )
    );

    // The state: the sync failed, and the time of the last good sync.
    let state = bridge.state();
    assert!(state.sync.failed);
    assert_eq!(state.sync.synced_at, synced_at);
    assert_eq!(
        std::fs::read_to_string(dir.config_path()).expect("read"),
        file_before
    );
    // The MCP server is the same process, and it still answers.
    let list = tools_call(json!(1), "list_files", json!({}));
    assert_eq!(tool_text(&mock.call(FILES, list).await), "");
    assert_eq!(server_pid(&dir, None).await, pid);

    // The next good sync removes the failure.
    mock.fail_tunnel_data(None);
    mock.set_catalog_items(json!([command_item(FILES, &dir.stdio_command())]));
    mock.control("bridge/sync", Value::Null).await;
    assert!(!bridge.state().sync.failed);
}

#[tokio::test]
async fn a_sync_with_no_change_keeps_the_file_and_sends_no_state_report() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let bridge = Bridge::start(&mock, &dir, one_stdio_server(&dir));
    mock.wait_for_ready_channels(&[FILES]).await;
    let pid = server_pid(&dir, None).await;

    // Archestra has the entries of the file. The file has no time of a sync
    // yet, so the first sync writes it.
    mock.set_catalog_items(json!([command_item(FILES, &dir.stdio_command())]));
    mock.control("bridge/sync", Value::Null).await;
    let first = bridge.state().sync.synced_at;
    assert!(first.is_some());
    assert_eq!(load(&dir).last_sync(), first);
    let file_before = std::fs::read_to_string(dir.config_path()).expect("read");

    // The time of a sync has whole seconds: the next sync is a later one.
    // The report that follows the first sync comes in this time.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let reports = mock.state_reports().len();
    let response = mock.control("bridge/sync", Value::Null).await;
    assert_eq!(response["result"], json!({}), "{response}");

    // The state has the time of this sync. The file keeps the time of the
    // sync that changed it.
    let state = bridge.state();
    assert!(!state.sync.failed);
    assert!(state.sync.synced_at > first);
    assert_eq!(
        std::fs::read_to_string(dir.config_path()).expect("read"),
        file_before
    );
    // The supervisor did not read the file again: the same process, and no
    // new state report.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(server_pid(&dir, None).await, pid);
    assert_eq!(mock.state_reports().len(), reports);
}

#[tokio::test]
async fn a_sync_notification_is_acknowledged_and_starts_a_sync() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let _bridge = Bridge::start(&mock, &dir, no_servers());

    // What Archestra sends when the config of the device changes: no `id`,
    // so no answer but the acknowledgement.
    mock.set_catalog_items(json!([command_item(FILES, &dir.stdio_command())]));
    let response = mock
        .call(
            BRIDGE_CHANNEL,
            json!({"jsonrpc": "2.0", "method": "bridge/sync"}),
        )
        .await;
    assert_eq!(response["channel"], json!(BRIDGE_CHANNEL));
    assert_eq!(response["resp_type"], json!("notify_ack"));
    assert_eq!(response["resp_code"], json!(202));
    assert_eq!(response.get("resp_json"), None);

    mock.wait_for_ready_channels(&[FILES]).await;
    assert_eq!(load(&dir).mcp.commands[0].channel, FILES);
    let pid = server_pid(&dir, None).await;

    // Each other notification for the tunnel client is acknowledged and
    // does nothing.
    for (method, params) in [
        ("bridge/server/restart", json!({"channel": FILES})),
        ("bridge/server/log", json!({"channel": FILES})),
        ("bridge/unknown", Value::Null),
    ] {
        let notification = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let response = mock.call(BRIDGE_CHANNEL, notification).await;
        assert_eq!(response["resp_type"], json!("notify_ack"), "{method}");
        assert_eq!(response.get("resp_json"), None, "{method}");
    }
    let ping = json!({"jsonrpc": "2.0", "id": 1, "method": "ping"});
    assert_eq!(mock.call(FILES, ping).await["resp_code"], json!(200));
    assert_eq!(server_pid(&dir, None).await, pid);
}

#[tokio::test]
async fn the_client_syncs_at_the_interval_with_no_request() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let timings = Timings {
        sync_interval: Duration::from_millis(150),
        ..timings()
    };
    let mut bridge = Bridge::start_with(&mock, &dir, no_servers(), timings);

    // A change that makes no `bridge/sync`: the access of the user changed.
    mock.set_catalog_items(json!([command_item(FILES, &dir.stdio_command())]));
    mock.wait_for_ready_channels(&[FILES]).await;
    let first = bridge
        .wait_for_state("a sync", |state| state.sync.synced_at.is_some())
        .await;
    assert!(!first.sync.failed);
    let calls = mock.metadata_calls();
    // The next syncs come with no request too.
    tokio::time::timeout(Duration::from_secs(30), async {
        while mock.metadata_calls() < calls + 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("more syncs come");
}

#[tokio::test]
async fn a_restart_request_starts_a_new_process() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let mut stopped = command_entry(STOPPED, &dir.stdio_command());
    stopped.enabled = false;
    let mcp = McpConfig {
        commands: vec![
            command_entry(FILES, &dir.stdio_command()),
            command_entry(NOT_CONFIGURED, ""),
            stopped,
            command_entry("broken-quote", "python3 'open"),
        ],
        server_urls: vec![url_entry(NOTES, &fixture.url("/mcp"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES, NOTES]).await;
    let first_pid = server_pid(&dir, None).await;

    let response = mock
        .control("bridge/server/restart", json!({"channel": FILES}))
        .await;
    assert_eq!(response["result"], json!({}), "{response}");
    let second_pid = server_pid(&dir, Some(first_pid)).await;
    wait_until_gone(first_pid).await;

    // The new process answers. While it starts, a call gets the 502 error.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let list = tools_call(json!(1), "list_files", json!({}));
        if mock.call(FILES, list).await["resp_code"] == json!(200) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the server did not come back"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(server_pid(&dir, None).await, second_pid);

    // An HTTP MCP server: the client connects again.
    let response = mock
        .control("bridge/server/restart", json!({"channel": NOTES}))
        .await;
    assert_eq!(response["result"], json!({}), "{response}");
    mock.wait_for_ready_channels(&[FILES, NOTES]).await;

    // Nothing to start again.
    for (channel, message) in [
        (
            "no-such-channel",
            "the config file of the device has no MCP server for the channel no-such-channel",
        ),
        (NOT_CONFIGURED, "the MCP server has no command and no URL"),
        (STOPPED, "the MCP server is stopped; start it first"),
        (
            "broken-quote",
            "the entry of the MCP server has an error: the command has a quote that is not closed",
        ),
    ] {
        let response = mock
            .control("bridge/server/restart", json!({"channel": channel}))
            .await;
        assert_eq!(response.get("result"), None, "{response}");
        assert_eq!(error_of(&response), (-32603, message));
    }
    assert_eq!(server_pid(&dir, None).await, second_pid);
}

#[tokio::test]
async fn a_log_request_gives_the_stderr_lines_of_the_server() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let fixture = HttpFixture::start(&dir.root());
    let mcp = McpConfig {
        commands: vec![command_entry(FILES, &dir.stdio_command_with_log())],
        server_urls: vec![url_entry(NOTES, &fixture.url("/mcp"))],
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES, NOTES]).await;
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    assert_eq!(mock.call(FILES, list).await["resp_code"], json!(200));

    // The task that reads stderr is not the task of the MCP session: the
    // last line can come a moment after the answer.
    let expected = json!({"lines": [
        "files server started",
        "request initialize",
        "request tools/list",
    ]});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let response = mock
            .control("bridge/server/log", json!({"channel": FILES}))
            .await;
        if response["result"] == expected {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the log did not come: {response}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The client does not start an HTTP MCP server: no log. The same for a
    // channel that the config file does not have.
    for channel in [NOTES, "no-such-channel"] {
        let response = mock
            .control("bridge/server/log", json!({"channel": channel}))
            .await;
        assert_eq!(response["result"], json!({"lines": []}), "{channel}");
    }
}

#[tokio::test]
async fn requests_that_the_client_cannot_do_get_a_jsonrpc_error() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let _bridge = Bridge::start(&mock, &dir, no_servers());

    let response = mock.control("bridge/unknown", Value::Null).await;
    assert_eq!(
        error_of(&response),
        (-32601, "Method not found: bridge/unknown")
    );
    // A method of MCP is not a method of the tunnel client.
    let response = mock.control("tools/list", json!({})).await;
    assert_eq!(
        error_of(&response),
        (-32601, "Method not found: tools/list")
    );

    let response = mock.control("bridge/server/restart", json!({})).await;
    let (code, message) = error_of(&response);
    assert_eq!(code, -32602);
    assert!(
        message.starts_with("the params of bridge/server/restart are not valid: "),
        "{message}"
    );
}

#[tokio::test]
async fn the_state_report_has_each_server() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut stopped = command_entry(STOPPED, "server");
    stopped.enabled = false;
    let mcp = McpConfig {
        commands: vec![
            command_entry(FILES, &dir.stdio_command()),
            command_entry(NOT_CONFIGURED, ""),
            stopped,
        ],
        server_urls: Vec::new(),
    };
    // A server that stops stays "failed" for the time of the backoff. The
    // time is long here, so that a report has that state.
    let slow_restart = Backoff {
        initial: Duration::from_millis(600),
        max: Duration::from_millis(600),
    };
    let timings = Timings {
        mcp_server_backoff: slow_restart,
        ..timings()
    };
    let _bridge = Bridge::start_with(&mock, &dir, mcp, timings);

    let report = mock.state_report_with(FILES, "running").await;
    assert_eq!(
        report,
        json!({
            // In the order of the config file.
            "servers": [
                {"channel": FILES, "state": "running", "error": null},
                {"channel": NOT_CONFIGURED, "state": "no_command", "error": null},
                {"channel": STOPPED, "state": "stopped", "error": null},
            ],
        })
    );

    // The body of the POST.
    let reports = mock.state_reports();
    let body = reports.last().expect("a report");
    assert_eq!(body["channel"], json!(BRIDGE_CHANNEL));
    assert_eq!(body["resp_code"], json!(200));
    assert_eq!(body["resp_type"], json!("jsonrpc_notify"));
    assert_eq!(body["resp_json"]["jsonrpc"], json!("2.0"));
    assert_eq!(body["resp_json"]["method"], json!("bridge/state"));
    assert_eq!(body["resp_json"].get("id"), None);
    // Each report has a new request id: a UUID of version 4.
    let mut request_ids = Vec::new();
    for report in &reports {
        let request_id = report["request_id"].as_str().expect("a request id");
        let groups: Vec<&str> = request_id.split('-').collect();
        let lengths: Vec<usize> = groups.iter().map(|group| group.len()).collect();
        assert_eq!(lengths, [8, 4, 4, 4, 12], "{request_id}");
        assert!(groups[2].starts_with('4'), "{request_id}");
        assert!(!request_ids.contains(&request_id), "{request_id}");
        request_ids.push(request_id);
    }

    // The MCP server stops: a report with the error, then one with the new
    // process in operation.
    let seen = reports.len();
    kill(server_pid(&dir, None).await);
    let failed = mock
        .state_report_after(seen, "the server failed", |params| {
            server_of(params, FILES).is_some_and(|server| server["state"] == json!("failed"))
        })
        .await;
    let error = server_of(&failed, FILES).expect("the server")["error"]
        .as_str()
        .expect("an error text");
    assert!(error.starts_with("the MCP server stopped"), "{error}");
    assert_eq!(failed["servers"].as_array().map(Vec::len), Some(3));
    mock.state_report_after(seen, "the server runs again", |params| {
        server_of(params, FILES).is_some_and(|server| server["state"] == json!("running"))
    })
    .await;
}

#[tokio::test]
async fn a_server_that_cannot_start_is_reported_as_failed_with_the_reason() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mcp = McpConfig {
        commands: vec![
            command_entry("no-such-program", "/nonexistent/archestra-test-mcp-server"),
            command_entry("broken-quote", "python3 'open"),
        ],
        server_urls: vec![url_entry(NOTES, "http://127.0.0.1:9/mcp")],
    };
    let mut bridge = Bridge::start(&mock, &dir, mcp);

    let report = mock.state_report_with("no-such-program", "failed").await;
    let error = server_of(&report, "no-such-program").expect("the server")["error"]
        .as_str()
        .expect("an error text");
    assert!(error.starts_with("cannot start the program: "), "{error}");
    assert_eq!(
        server_of(&report, "broken-quote"),
        Some(&json!({
            "channel": "broken-quote",
            "state": "failed",
            "error": "the command has a quote that is not closed",
        }))
    );

    // Nothing listens at the URL.
    let report = mock.state_report_with(NOTES, "failed").await;
    let error = server_of(&report, NOTES).expect("the server")["error"]
        .as_str()
        .expect("an error text");
    assert!(error.starts_with("the request failed: "), "{error}");

    // The state has the same.
    bridge
        .wait_for_state("failed servers", |state| {
            state
                .servers
                .iter()
                .all(|server| matches!(server.state, ServerState::Failed { .. }))
        })
        .await;
}

#[tokio::test]
async fn a_change_after_a_report_that_failed_sends_the_full_state_again() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    // The first report is lost.
    mock.fail_next_state_reports(&[StatusCode::SERVICE_UNAVAILABLE]);
    let mcp = McpConfig {
        commands: vec![command_entry(NOT_CONFIGURED, "")],
        server_urls: Vec::new(),
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_until_no_state_report_failures().await;

    // A change: a sync brings one more MCP server.
    mock.set_catalog_items(json!([
        {"id": NOT_CONFIGURED, "name": "no command yet", "enabled": true},
        command_item(FILES, &dir.stdio_command()),
    ]));
    mock.control("bridge/sync", Value::Null).await;
    let report = mock.state_report_with(FILES, "running").await;
    assert_eq!(
        report["servers"],
        json!([
            {"channel": NOT_CONFIGURED, "state": "no_command", "error": null},
            {"channel": FILES, "state": "running", "error": null},
        ])
    );
}

#[tokio::test]
async fn a_report_that_failed_is_sent_again_after_the_next_sync_with_no_change() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mcp = McpConfig {
        commands: vec![command_entry(NOT_CONFIGURED, "")],
        server_urls: Vec::new(),
    };
    let mut bridge = Bridge::start(&mock, &dir, mcp);
    bridge.wait_for_status(BridgeStatus::Connected).await;
    mock.state_report_with(NOT_CONFIGURED, "no_command").await;

    // A sync brings one more MCP server. The report that follows is lost.
    mock.fail_next_state_reports(&[StatusCode::SERVICE_UNAVAILABLE]);
    mock.set_catalog_items(json!([
        command_item(NOT_CONFIGURED, ""),
        command_item(STOPPED, ""),
    ]));
    mock.control("bridge/sync", Value::Null).await;
    mock.wait_until_no_state_report_failures().await;
    // Nothing changes: the tunnel client does not send the report again.
    // The time of a sync has whole seconds: the next sync is a later one.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let reports = mock.state_reports().len();
    assert!(reports > 0);
    let file_before = std::fs::read_to_string(dir.config_path()).expect("read");

    // The next sync writes nothing, but it is a change of the state of the
    // tunnel client: Archestra gets the report now.
    mock.control("bridge/sync", Value::Null).await;
    let report = mock
        .state_report_after(reports, "both servers", |params| {
            server_of(params, STOPPED).is_some()
        })
        .await;
    assert_eq!(report["servers"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        std::fs::read_to_string(dir.config_path()).expect("read"),
        file_before
    );
}

#[tokio::test]
async fn the_variables_of_a_command_are_replaced_on_the_device() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    // The root folder of the test server has the name of the user in it,
    // in both forms of the variable. A system with no `USER` keeps the text.
    let folder = match std::env::var("USER") {
        Ok(user) if !user.is_empty() => format!("{user}-{user}"),
        _ => "${USER}-$USER".to_owned(),
    };
    let command = dir.stdio_command().replace(
        &format!("'{}'", dir.root().display()),
        &format!("'{}/${{USER}}-$USER'", dir.root().display()),
    );
    assert_ne!(command, dir.stdio_command());
    let mcp = McpConfig {
        commands: vec![command_entry(FILES, &command)],
        server_urls: Vec::new(),
    };
    let _bridge = Bridge::start(&mock, &dir, mcp);
    mock.wait_for_ready_channels(&[FILES]).await;

    let write = tools_call(
        json!(1),
        "write_file",
        json!({"path": "hello.txt", "content": "hi"}),
    );
    tool_text(&mock.call(FILES, write).await);
    let written = dir.root().join(folder).join("hello.txt");
    assert_eq!(std::fs::read_to_string(written).ok().as_deref(), Some("hi"));
    // The file keeps the command as Archestra sent it.
    assert_eq!(load(&dir).mcp.commands[0].command, command);
}
