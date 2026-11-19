//! Sign-in of a device: start, open the approval page, wait for the decision
//! of the user, and make the device key.

use std::time::Duration;

use tracing::warn;

use crate::bridge::config::{ControlPlaneConfig, is_valid_tunnel_id};
use crate::bridge::control_plane::{
    self, ControlPlaneError, DEVICE_KEY_PREFIX, SignInPoll, SignInStatus,
};
use crate::bridge::open_url::open_url;

/// The time between two polls is what Archestra asks for, inside these bounds.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum SignInError {
    #[error(transparent)]
    ControlPlane(#[from] ControlPlaneError),
    #[error("the sign-in was denied in the browser")]
    Denied,
    #[error("the sign-in was not approved in time; start the tunnel client again")]
    Expired,
    #[error("Archestra approved the sign-in but sent no valid tunnel id")]
    NoTunnelId,
}

/// How the sign-in asks for the approval.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SignInOptions<'a> {
    /// Open the approval page in the browser. The URL is printed always.
    pub open_browser: bool,
    /// From the command of a setup dialog in Archestra.
    pub setup_code: Option<&'a str>,
}

/// After this long with no answer in the setup dialog, the approval page is
/// offered as well: the dialog may be closed.
const APPROVAL_PAGE_FALLBACK_AFTER: Duration = Duration::from_secs(60);

/// Runs the sign-in at `base_url`. With a setup code that Archestra knows,
/// the user approves in the setup dialog the command came from, and no
/// browser page opens. Else it prints the approval URL and opens it in the
/// browser when `open_browser` is set. It returns when the user approves.
pub(crate) async fn sign_in(
    http: &reqwest::Client,
    base_url: &str,
    options: &SignInOptions<'_>,
) -> Result<ControlPlaneConfig, SignInError> {
    let start = control_plane::start_sign_in(
        http,
        base_url,
        &device_name(),
        std::env::consts::OS,
        options.setup_code,
    )
    .await?;
    let approval_url = format!("{base_url}{}", start.verification_path);

    println!(
        "{}",
        approval_text(&start.user_code, &approval_url, start.approve_in_archestra)
    );
    if !start.approve_in_archestra && options.open_browser && !open_url(&approval_url) {
        warn!("could not open the browser; open the URL by hand");
    }

    let interval = poll_interval(start.interval);
    let started = tokio::time::Instant::now();
    let mut offered_the_page = !start.approve_in_archestra;
    loop {
        tokio::time::sleep(interval).await;
        let SignInPoll { status, tunnel_id } =
            control_plane::poll_sign_in(http, base_url, &start.device_code).await?;
        match status {
            SignInStatus::Pending => {
                if !offered_the_page && started.elapsed() >= APPROVAL_PAGE_FALLBACK_AFTER {
                    offered_the_page = true;
                    println!("{}", fallback_text(&approval_url));
                }
            }
            SignInStatus::Denied => return Err(SignInError::Denied),
            SignInStatus::Expired => return Err(SignInError::Expired),
            SignInStatus::Approved => {
                let tunnel_id = tunnel_id
                    .filter(|tunnel_id| is_valid_tunnel_id(tunnel_id))
                    .ok_or(SignInError::NoTunnelId)?;
                return Ok(ControlPlaneConfig {
                    base_url: base_url.to_owned(),
                    tunnel_id,
                    api_key: format!("{DEVICE_KEY_PREFIX}{}", start.device_code),
                });
            }
        }
    }
}

/// What the terminal says while the sign-in waits for the user.
fn approval_text(user_code: &str, approval_url: &str, approve_in_archestra: bool) -> String {
    if approve_in_archestra {
        format!(
            "Approve this device in Archestra, in the window where you copied this command.\n\
             Make sure the code there is {user_code}.\n\
             \n\
             Waiting for approval..."
        )
    } else {
        format!(
            "This device is not authorized. Approve it in the browser:\n\
             {approval_url}\n\
             Make sure the code {user_code} matches the code in the browser."
        )
    }
}

/// The approval page, for a user who closed the setup dialog.
fn fallback_text(approval_url: &str) -> String {
    format!("Or approve it here: {approval_url}")
}

fn poll_interval(seconds: f64) -> Duration {
    Duration::try_from_secs_f64(seconds)
        .unwrap_or(MIN_POLL_INTERVAL)
        .clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
}

/// The name of the device in Archestra: the hostname, with no domain.
fn device_name() -> String {
    #[cfg(unix)]
    let hostname = rustix::system::uname()
        .nodename()
        .to_string_lossy()
        .into_owned();
    // Windows sets it for each process: the NetBIOS name of the computer.
    #[cfg(windows)]
    let hostname = std::env::var("COMPUTERNAME").unwrap_or_default();
    short_hostname(&hostname)
}

fn short_hostname(hostname: &str) -> String {
    match hostname.split('.').next() {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => "unknown-device".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_loses_its_domain() {
        assert_eq!(short_hostname("MBP-0142.local"), "MBP-0142");
        assert_eq!(short_hostname("build-7.corp.example.com"), "build-7");
        assert_eq!(short_hostname("MBP-0142"), "MBP-0142");
        assert_eq!(short_hostname(""), "unknown-device");
    }

    #[test]
    fn the_terminal_names_where_to_approve() {
        let url = "https://archestra.example.com/devices/approve?request=r1";
        let in_archestra = approval_text("ABCD-1234", url, true);
        assert_eq!(
            in_archestra,
            "Approve this device in Archestra, in the window where you copied this command.\n\
             Make sure the code there is ABCD-1234.\n\
             \n\
             Waiting for approval..."
        );
        // No page to open: the setup dialog shows the request.
        assert!(!in_archestra.contains(url));

        let in_browser = approval_text("ABCD-1234", url, false);
        assert!(in_browser.contains(url));
        assert!(in_browser.contains("Make sure the code ABCD-1234 matches"));

        assert_eq!(fallback_text(url), format!("Or approve it here: {url}"));
    }

    #[test]
    fn poll_interval_stays_in_bounds() {
        assert_eq!(poll_interval(2.0), Duration::from_secs(2));
        assert_eq!(poll_interval(0.0), MIN_POLL_INTERVAL);
        assert_eq!(poll_interval(-1.0), MIN_POLL_INTERVAL);
        assert_eq!(poll_interval(f64::NAN), MIN_POLL_INTERVAL);
        assert_eq!(poll_interval(5000.0), MAX_POLL_INTERVAL);
    }
}
