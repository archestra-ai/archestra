//! `prepare`: the sign-in flow and the sync at the start, against the mock
//! Archestra. No browser is opened (`open_browser: false`, which is
//! `--no-open`).

use std::time::{Duration, SystemTime};

use archestra_cli::bridge::config::{CommandEntry, Config, McpConfig, ServerUrlEntry};
use archestra_cli::bridge::{BridgeError, StartOptions};
use axum::http::StatusCode;
use serde_json::json;

use crate::harness::{TestDir, command_entry, url_entry};
use crate::mock_control_plane::{DEVICE_CODE, MockControlPlane, TUNNEL_ID};

fn options(mock: &MockControlPlane, dir: &TestDir) -> StartOptions {
    StartOptions {
        // A `/` at the end, as a user can paste it.
        url: Some(format!("{}/", mock.base_url)),
        config_path: dir.config_path(),
        open_browser: false,
        setup_code: None,
    }
}

#[tokio::test]
async fn the_first_run_signs_in_and_syncs_the_config_file() {
    let mock = MockControlPlane::start().await;
    mock.set_catalog_items(json!([
        {
            "id": "7c1e",
            "name": "peekaboo",
            "command": "/Users/$USER/bins/peekaboo mcp serve",
            "url": null,
            "enabled": true,
        },
        {
            "id": "91bd",
            "name": "Notes",
            "command": null,
            "url": "http://127.0.0.1:8080/mcp",
            "enabled": false,
        },
        {"id": "3f02", "name": "eda-agent", "command": null, "url": null, "enabled": true},
    ]));
    let dir = TestDir::new();
    let before = SystemTime::now() - Duration::from_secs(1);

    let prepared = archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("prepare");
    let config = prepared.config;

    assert_eq!(config.control_plane.base_url, mock.base_url);
    assert_eq!(config.control_plane.tunnel_id, TUNNEL_ID);
    assert_eq!(
        config.control_plane.api_key,
        format!("archestra_dev_{DEVICE_CODE}")
    );
    // One entry for each catalog item. The command is as Archestra sent it.
    assert_eq!(
        config.mcp.commands,
        vec![
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

    // The sync changed the file: its time is in the file and in the result.
    assert!(!prepared.sync.failed);
    let synced_at = prepared.sync.synced_at.expect("the time of the sync");
    assert!(synced_at >= before && synced_at <= SystemTime::now());
    assert_eq!(config.last_sync(), Some(synced_at));

    let on_disk = Config::load(&dir.config_path())
        .expect("load")
        .expect("the config file exists");
    assert_eq!(on_disk, config);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.config_path())
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let starts = mock.sign_in_starts();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["platform"], json!(std::env::consts::OS));
    let device_name = starts[0]["deviceName"].as_str().expect("deviceName");
    assert!(!device_name.is_empty() && !device_name.contains('.'));
}

#[tokio::test]
async fn a_setup_code_goes_with_the_sign_in_for_the_dialog_to_approve() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let with_code = StartOptions {
        setup_code: Some("AbCdEfGhIjKlMnOpQrStUv".to_owned()),
        ..options(&mock, &dir)
    };

    archestra_cli::bridge::prepare(&with_code)
        .await
        .expect("signs in");

    let starts = mock.sign_in_starts();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["setupCode"], json!("AbCdEfGhIjKlMnOpQrStUv"));
    // With no setup code, the request has none.
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("signs in");
    assert!(mock.sign_in_starts()[0].get("setupCode").is_none());
}

#[tokio::test]
async fn a_later_run_replaces_the_entries_of_the_config_file() {
    let mock = MockControlPlane::start().await;
    mock.set_catalog_items(json!([
        {"id": "7c1e", "name": "MATLAB R2026", "command": "/opt/matlab/mcp", "url": null, "enabled": true},
        {"id": "aa11", "name": "New server", "command": null, "url": null, "enabled": true},
    ]));
    let dir = TestDir::new();
    // The file of an earlier run. Archestra has a new name and a new command
    // for one entry, and does not list the two other entries any more.
    let control_plane = mock.control_plane_config();
    let earlier = Config {
        control_plane: control_plane.clone(),
        synced_at: None,
        mcp: McpConfig {
            commands: vec![
                command_entry("7c1e", "/usr/local/bin/matlab-mcp-server"),
                command_entry("gone", "server"),
            ],
            server_urls: vec![url_entry("91bd", "http://127.0.0.1:8080/mcp")],
        },
    };
    earlier.save(&dir.config_path()).expect("save");

    // `--url` is not necessary on a later run.
    let options = StartOptions {
        url: None,
        ..options(&mock, &dir)
    };
    let prepared = archestra_cli::bridge::prepare(&options)
        .await
        .expect("prepare");
    let config = prepared.config;

    assert!(mock.sign_in_starts().is_empty());
    assert_eq!(config.control_plane, control_plane);
    // Only what Archestra lists: the old command and the entries that
    // Archestra does not list are gone.
    assert_eq!(
        config.mcp.commands,
        vec![
            CommandEntry {
                channel: "7c1e".to_owned(),
                name: "MATLAB R2026".to_owned(),
                command: "/opt/matlab/mcp".to_owned(),
                arguments: Vec::new(),
                enabled: true,
            },
            CommandEntry {
                channel: "aa11".to_owned(),
                name: "New server".to_owned(),
                command: String::new(),
                arguments: Vec::new(),
                enabled: true,
            },
        ]
    );
    assert_eq!(config.mcp.server_urls, Vec::new());
    assert!(!prepared.sync.failed);
    assert_eq!(
        Config::load(&dir.config_path()).expect("load"),
        Some(config)
    );
}

#[tokio::test]
async fn a_rejected_key_at_the_start_signs_in_again_and_syncs() {
    let mock = MockControlPlane::start().await;
    mock.set_catalog_items(json!([
        {"id": "7c1e", "name": "MATLAB", "command": "/opt/matlab/mcp", "enabled": true},
    ]));
    mock.reject_the_key();
    let dir = TestDir::new();
    let mut existing = Config {
        control_plane: mock.control_plane_config(),
        synced_at: None,
        mcp: McpConfig {
            commands: vec![command_entry("7c1e", "/usr/local/bin/matlab-mcp-server")],
            server_urls: Vec::new(),
        },
    };
    existing.control_plane.api_key = "archestra_dev_old".to_owned();
    existing.save(&dir.config_path()).expect("save");

    let prepared = archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("prepare");

    assert_eq!(mock.sign_in_starts().len(), 1);
    assert_eq!(
        prepared.config.control_plane.api_key,
        format!("archestra_dev_{DEVICE_CODE}")
    );
    assert_eq!(prepared.config.mcp.commands[0].command, "/opt/matlab/mcp");
    assert_eq!(prepared.config.mcp.commands[0].name, "MATLAB");
    assert!(!prepared.sync.failed);
    assert_eq!(mock.metadata_calls(), 1);
    assert_eq!(
        Config::load(&dir.config_path()).expect("load"),
        Some(prepared.config)
    );
}

#[tokio::test]
async fn the_first_run_needs_the_url() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let options = StartOptions {
        url: None,
        ..options(&mock, &dir)
    };
    let error = archestra_cli::bridge::prepare(&options)
        .await
        .expect_err("no config file and no --url");
    assert!(matches!(error, BridgeError::UrlRequired { .. }));
    assert!(!dir.config_path().exists());
}

/// A config file of an earlier sync.
fn synced_earlier(mock: &MockControlPlane) -> Config {
    Config {
        control_plane: mock.control_plane_config(),
        synced_at: Some("2026-11-10T12:00:00Z".to_owned()),
        mcp: McpConfig {
            commands: vec![command_entry("7c1e", "server")],
            server_urls: vec![url_entry("91bd", "http://127.0.0.1:8080/mcp")],
        },
    }
}

#[tokio::test]
async fn a_start_with_no_change_in_archestra_leaves_the_config_file_as_it_is() {
    let mock = MockControlPlane::start().await;
    mock.set_catalog_items(json!([
        {"id": "7c1e", "name": "7c1e name", "command": "server", "url": null, "enabled": true},
        {"id": "91bd", "name": "91bd name", "command": null, "url": "http://127.0.0.1:8080/mcp", "enabled": true},
    ]));
    let dir = TestDir::new();
    let existing = synced_earlier(&mock);
    existing.save(&dir.config_path()).expect("save");
    let text_before = std::fs::read_to_string(dir.config_path()).expect("read");
    let before = SystemTime::now() - Duration::from_secs(1);

    let prepared = archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("prepare");

    assert_eq!(mock.metadata_calls(), 1);
    // The file keeps the time of the sync that changed it; the result has
    // the time of this sync.
    assert_eq!(prepared.config, existing);
    assert_eq!(
        std::fs::read_to_string(dir.config_path()).expect("read"),
        text_before
    );
    assert!(!prepared.sync.failed);
    let synced_at = prepared.sync.synced_at.expect("the time of the sync");
    assert!(synced_at >= before && synced_at <= SystemTime::now());
}

#[tokio::test]
async fn archestra_that_cannot_be_reached_leaves_the_config_file_as_it_is() {
    let mock = MockControlPlane::start().await;
    let dir = TestDir::new();
    let mut existing = synced_earlier(&mock);
    // Nothing listens on port 9 of this computer.
    existing.control_plane.base_url = "http://127.0.0.1:9".to_owned();
    existing.save(&dir.config_path()).expect("save");
    let text_before = std::fs::read_to_string(dir.config_path()).expect("read");

    let prepared = archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("prepare");
    assert_eq!(prepared.config, existing);
    // The sync failed; the time is that of the file.
    assert!(prepared.sync.failed);
    assert_eq!(prepared.sync.synced_at, existing.last_sync());
    assert!(prepared.sync.synced_at.is_some());
    assert_eq!(
        std::fs::read_to_string(dir.config_path()).expect("read"),
        text_before
    );
}

#[tokio::test]
async fn a_failed_sync_at_the_start_leaves_the_config_file_as_it_is() {
    let mock = MockControlPlane::start().await;
    mock.set_catalog_items(json!([{"id": "aa11", "name": "New server", "enabled": true}]));
    mock.fail_tunnel_data(Some(StatusCode::INTERNAL_SERVER_ERROR));
    let dir = TestDir::new();
    let existing = synced_earlier(&mock);
    existing.save(&dir.config_path()).expect("save");

    let prepared = archestra_cli::bridge::prepare(&options(&mock, &dir))
        .await
        .expect("prepare");
    assert_eq!(prepared.config, existing);
    assert!(prepared.sync.failed);
    assert_eq!(
        Config::load(&dir.config_path()).expect("load"),
        Some(existing)
    );
    assert!(mock.sign_in_starts().is_empty());
}
