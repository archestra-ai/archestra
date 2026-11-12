//! The MCP bridge part of `archestra uninstall`, against the mock Archestra
//! and a temp home folder: Archestra removes the device, and the folder of
//! the MCP bridge goes away.

use std::path::Path;

use archestra_cli::bridge::config::Config;
use archestra_cli::bridge::remove::{DeviceRemoval, forget_device};
use archestra_cli::layout;
use axum::http::StatusCode;

use crate::mock_control_plane::MockControlPlane;

/// A home folder of a computer that is signed in to the mock Archestra, with
/// a log file next to the config file.
fn signed_in_home(mock: &MockControlPlane) -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("temp home");
    let config_path = layout::bridge_config_path(home.path());
    std::fs::create_dir_all(config_path.parent().expect("parent")).expect("mkdir");
    Config::new(mock.control_plane_config())
        .save(&config_path)
        .expect("save");
    std::fs::write(layout::bridge_log_path(home.path()), "log").expect("write");
    home
}

fn bridge_dir_is_gone(home: &Path) -> bool {
    !layout::bridge_dir(home).exists()
}

#[tokio::test]
async fn archestra_removes_the_device_and_the_folder_goes_away() {
    let mock = MockControlPlane::start().await;
    let home = signed_in_home(&mock);

    let device = forget_device(home.path()).await.expect("forget");

    assert_eq!(device, DeviceRemoval::Removed);
    assert_eq!(mock.device_removals(), 1);
    assert!(bridge_dir_is_gone(home.path()));

    // A second uninstall: nothing is there, and that is not an error.
    let device = forget_device(home.path()).await.expect("forget again");
    assert_eq!(device, DeviceRemoval::NotSignedIn);
    assert_eq!(mock.device_removals(), 1);
}

#[tokio::test]
async fn a_device_that_archestra_does_not_know_any_more_counts_as_removed() {
    let mock = MockControlPlane::start().await;
    let home = signed_in_home(&mock);
    // The user removed the device on the Device tab.
    mock.reject_the_key();

    let device = forget_device(home.path()).await.expect("forget");

    assert_eq!(device, DeviceRemoval::Removed);
    assert!(bridge_dir_is_gone(home.path()));
}

#[tokio::test]
async fn the_folder_goes_away_also_when_archestra_does_not_remove_the_device() {
    let mock = MockControlPlane::start().await;
    let home = signed_in_home(&mock);
    mock.fail_device_removal(StatusCode::SERVICE_UNAVAILABLE);

    let device = forget_device(home.path()).await.expect("forget");

    // The user gets the address of Archestra, to remove the device by hand.
    assert_eq!(
        device,
        DeviceRemoval::Failed {
            base_url: Some(mock.base_url.clone()),
            reason: "Archestra answered with HTTP status 503".to_owned(),
        }
    );
    assert_eq!(mock.device_removals(), 0);
    assert!(bridge_dir_is_gone(home.path()));
}

#[tokio::test]
async fn a_config_file_that_is_not_valid_does_not_stop_the_uninstall() {
    let home = tempfile::tempdir().expect("temp home");
    let config_path = layout::bridge_config_path(home.path());
    std::fs::create_dir_all(config_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&config_path, "not: [valid").expect("write");

    let device = forget_device(home.path()).await.expect("forget");

    assert!(matches!(
        device,
        DeviceRemoval::Failed { base_url: None, .. }
    ));
    assert!(bridge_dir_is_gone(home.path()));
}
