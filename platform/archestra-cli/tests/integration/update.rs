//! The update of the program, against the mock Archestra and a temp home
//! folder. The install step is a test function: no test starts a downloaded
//! program or replaces one.

use std::path::Path;
use std::time::Duration;

use archestra_cli::bridge::config::Config;
use archestra_cli::bridge::update::{UpdateError, download_verified, downloaded_program_path};
use archestra_cli::bridge::{
    AutoUpdate, Bridge, RunOptions, StartOptions, SyncState, http_client, prepare, served_program,
};
use archestra_cli::{layout, program};

use crate::harness::{TestDir, timings};
use crate::mock_control_plane::MockControlPlane;

const NEW_PROGRAM: &[u8] = b"the bytes of the new program";

fn serve_new_program(mock: &MockControlPlane, auto_update: bool) -> String {
    let sha256 = program::sha256_hex(NEW_PROGRAM);
    mock.serve_program(NEW_PROGRAM, &sha256, Some("0.2.0"), auto_update);
    sha256
}

/// The install step of the tests: it only leaves a note next to the
/// downloaded program, with the config file that it got.
fn note_the_install(program: &Path, config_path: &Path) -> std::io::Result<()> {
    std::fs::write(
        program.with_extension("installed"),
        config_path.display().to_string(),
    )
}

fn installed_note(home: &Path) -> std::path::PathBuf {
    downloaded_program_path(home).with_extension("installed")
}

/// Runs the MCP bridge with the automatic update on, in a temp home folder.
async fn run_with_auto_update(
    mock: &MockControlPlane,
    dir: &TestDir,
    home: &Path,
) -> tokio::task::JoinHandle<()> {
    std::fs::create_dir_all(layout::bridge_dir(home)).expect("mkdir");
    // A computer that is signed in already: the start only syncs.
    Config::new(mock.control_plane_config())
        .save(&dir.config_path())
        .expect("save");
    let prepared = prepare(&StartOptions {
        url: Some(mock.base_url.clone()),
        config_path: dir.config_path(),
        open_browser: false,
        setup_code: None,
    })
    .await
    .expect("prepare");
    let mut bridge = Bridge::new(RunOptions {
        config_path: dir.config_path(),
        control_plane: prepared.config.control_plane,
        timings: timings(),
        sync: SyncState::default(),
        update: prepared.update,
        auto_update: Some(AutoUpdate {
            home: home.to_owned(),
            install: note_the_install,
        }),
    });
    tokio::spawn(async move {
        let _ = bridge.run().await;
    })
}

async fn wait_for(what: &str, check: impl Fn() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{what} did not happen");
}

#[tokio::test]
async fn a_sync_names_this_program_and_gets_the_served_one() {
    let mock = MockControlPlane::start().await;
    serve_new_program(&mock, true);

    let served = served_program(&mock.control_plane_config())
        .await
        .expect("the sync works")
        .expect("Archestra serves a program");

    assert_eq!(served.version.as_deref(), Some("0.2.0"));
    assert_eq!(served.sha256, program::sha256_hex(NEW_PROGRAM));
    assert!(served.auto_update);
    // Archestra got the target and the checksum of the program that asked.
    assert_eq!(
        mock.metadata_program_headers(),
        Some((
            program::target(),
            program::own_sha256().expect("checksum").to_owned()
        ))
    );
}

#[tokio::test]
async fn an_archestra_with_no_program_serves_none() {
    let mock = MockControlPlane::start().await;
    let served = served_program(&mock.control_plane_config())
        .await
        .expect("the sync works");
    assert_eq!(served, None);
}

#[tokio::test]
async fn a_download_with_the_right_checksum_is_written_as_a_program() {
    let mock = MockControlPlane::start().await;
    let sha256 = serve_new_program(&mock, true);
    let home = tempfile::tempdir().expect("temp home");
    let http = http_client().expect("client");

    let downloaded = download_verified(&http, &mock.base_url, &sha256, home.path())
        .await
        .expect("download");

    assert_eq!(downloaded, downloaded_program_path(home.path()));
    assert_eq!(std::fs::read(&downloaded).expect("read"), NEW_PROGRAM);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&downloaded)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    // The download is the one of this system and CPU.
    assert_eq!(mock.program_downloads(), [program::target()]);
}

#[tokio::test]
async fn a_download_with_another_checksum_changes_nothing() {
    let mock = MockControlPlane::start().await;
    // The tunnel data name another checksum than the file has.
    let named = program::sha256_hex(b"another program");
    mock.serve_program(NEW_PROGRAM, &named, Some("0.2.0"), true);
    let home = tempfile::tempdir().expect("temp home");
    let http = http_client().expect("client");

    let error = download_verified(&http, &mock.base_url, &named, home.path())
        .await
        .expect_err("the checksum is wrong");

    assert!(matches!(
        error,
        UpdateError::WrongChecksum { expected, actual }
            if expected == named && actual == program::sha256_hex(NEW_PROGRAM)
    ));
    assert!(!downloaded_program_path(home.path()).exists());
    assert!(!layout::bin_dir(home.path()).exists());
}

#[tokio::test]
async fn the_bridge_installs_an_update_one_time_when_archestra_allows_it() {
    let mock = MockControlPlane::start().await;
    serve_new_program(&mock, true);
    let dir = TestDir::new();
    let home = tempfile::tempdir().expect("temp home");

    let bridge = run_with_auto_update(&mock, &dir, home.path()).await;

    let note = installed_note(home.path());
    wait_for("the install", || note.exists()).await;
    // The new program got the config file of the MCP bridge.
    assert_eq!(
        std::fs::read_to_string(&note).expect("read"),
        dir.config_path().display().to_string()
    );
    assert_eq!(
        std::fs::read(downloaded_program_path(home.path())).expect("read"),
        NEW_PROGRAM
    );

    // Archestra still serves that program (an install that did not work):
    // the MCP bridge does not try it again, here or after a new start.
    std::fs::remove_file(&note).expect("remove");
    tokio::time::sleep(Duration::from_millis(300)).await;
    bridge.abort();
    let bridge = run_with_auto_update(&mock, &dir, home.path()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!note.exists());
    assert_eq!(mock.program_downloads().len(), 1);
    bridge.abort();
}

#[tokio::test]
async fn the_bridge_does_not_install_an_update_that_archestra_does_not_allow() {
    let mock = MockControlPlane::start().await;
    serve_new_program(&mock, false);
    let dir = TestDir::new();
    let home = tempfile::tempdir().expect("temp home");

    let bridge = run_with_auto_update(&mock, &dir, home.path()).await;

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(mock.program_downloads().is_empty());
    assert!(!installed_note(home.path()).exists());
    bridge.abort();
}

#[tokio::test]
async fn the_bridge_does_not_install_the_program_that_it_runs() {
    let mock = MockControlPlane::start().await;
    // Archestra serves the program that runs: the same checksum.
    let own = program::own_sha256().expect("checksum");
    mock.serve_program(NEW_PROGRAM, own, Some("0.1.0"), true);
    let dir = TestDir::new();
    let home = tempfile::tempdir().expect("temp home");

    let bridge = run_with_auto_update(&mock, &dir, home.path()).await;

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(mock.program_downloads().is_empty());
    bridge.abort();
}

#[tokio::test]
async fn a_wrong_download_is_not_installed_and_not_remembered() {
    let mock = MockControlPlane::start().await;
    let named = program::sha256_hex(b"another program");
    mock.serve_program(NEW_PROGRAM, &named, Some("0.2.0"), true);
    let dir = TestDir::new();
    let home = tempfile::tempdir().expect("temp home");

    let bridge = run_with_auto_update(&mock, &dir, home.path()).await;

    wait_for("the download", || !mock.program_downloads().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!installed_note(home.path()).exists());
    assert!(!downloaded_program_path(home.path()).exists());
    // Not remembered as tried: a later download that is right installs.
    assert!(
        !layout::bridge_dir(home.path())
            .join("update-tried")
            .exists()
    );
    bridge.abort();
}
